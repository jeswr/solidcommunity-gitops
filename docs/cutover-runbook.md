# Cutover runbook: DigitalOcean droplet to Azure

Who does what:

- **Jesse**: everything in Cloudflare (DNS, SSL mode, cache purge), the origin certificate, GitHub secrets.
- **Operator**: Azure, the GitHub deploy, the droplet freeze and the data copy.

`$src` below is `ssh://root@solidcommunity.net/mnt/volume_lon1_01/solidcommunity.net` (see the
`scripts/migrate` section of the README). `$rg` is the production resource group.

## 0. One-off setup (days before)

1. Create the production resource group, and a deploy identity with a federated credential for
   `repo:<org>/solidcommunity-gitops:environment:prod` and Contributor on that group.
2. Make the image pullable from production: either make the GHCR package public, or create a
   registry and pull identity in `$rg` (as for test) and update `environments/prod.bicepparam`.
3. In GitHub, create the `prod` environment with Jesse as required reviewer. Add the secrets
   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `SMTP_PASSWORD` and the variable
   `AZURE_RESOURCE_GROUP` (it overrides the repository-level value, which only gates the job).
4. Run **Deploy** by hand with `env=prod`. Without the certificate secrets this creates everything
   but the custom domain. Note the `customDomainVerificationId` output.
5. Jesse, in Cloudflare: add TXT `asuid.solidcommunity.net` = that ID (DNS only). One record covers
   the apex and the wildcard. With only the TXT record, App Service treats the domain as a migration
   and binds it while DNS still points at the droplet.
6. Jesse: create the origin certificate (SSL/TLS > Origin Server > Create certificate, RSA, hostnames
   `solidcommunity.net` and `*.solidcommunity.net`, PEM). Turn it into a PFX that App Service accepts
   (3DES, password protected) and store it:

   ```bash
   pw="$(openssl rand -hex 24)"
   openssl pkcs12 -export -in origin.pem -inkey origin.key -out origin.pfx -passout "pass:$pw" \
     -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1   # add -legacy on OpenSSL 3 if it complains
   base64 < origin.pfx | tr -d '\n' | gh secret set ORIGIN_CERT_PFX -e prod -R <org>/solidcommunity-gitops
   printf '%s' "$pw" | gh secret set ORIGIN_CERT_PASSWORD -e prod -R <org>/solidcommunity-gitops
   rm origin.pfx   # keep origin.key in the password manager, not on disk
   ```

7. Run **Deploy** with `env=prod` again. Both hostnames are now bound with the certificate.
8. The origin only accepts Cloudflare's IP ranges. For the checks before the DNS switch, allow your
   own IP for a while (the next deploy removes the rule again):

   ```bash
   az webapp config access-restriction add -g $rg -n <site> --rule-name operator --action Allow --ip-address <ip>/32 --priority 50
   ```

   Then test with `curl -k --connect-to ::<site>.azurewebsites.net:443 https://jeswr.solidcommunity.net/profile/card`
   (`-k` because the Origin CA certificate is only trusted by Cloudflare).

## 1. Pre-checks (read-only on the droplet)

```bash
node scripts/migrate/migrate.mjs copy --source $src --target /data/sc --all --dry-run --names-check
```

Record the account, pod and file counts and the size (74 GB last time). Fix or list any names that
Azure Files can't store before going further.

Go/no-go: the image must include the CSS stream/lock fix. Without it, an aborted streamed response
leaves a lock that later expires into a closed stream and the process exits (`TypeError: callback is
not a function`). The test site crashed like this about every 65 minutes from 16 to 25 October 2026.
The test site's container log should show no `Process is halting` for 24 hours.

## 2. Test migration of one pod

```bash
node scripts/migrate/migrate.mjs copy   --source $src --target /data/jeswr --accounts jeswr
node scripts/migrate/migrate.mjs verify --source $src --target /data/jeswr --accounts jeswr
scripts/migrate/azure-upload.sh $rg prod /data/jeswr
```

The storage account only takes traffic from its private endpoint: run the upload from inside the
VNet, or allow your IP on the storage account for the duration (see the README). Then, with the
operator access rule from step 0.8, check the profile, a private resource (401 without a token),
a password login and a client-credentials token against `jeswr.solidcommunity.net`.

Empty the share afterwards (`azcopy remove "<share-url>?<sas>" --recursive`), so that the full upload
starts from an empty share.

## 3. Full copy (the day before)

Copy everything once while the droplet is still live, so that the copy during the freeze only
transfers what changed:

```bash
node scripts/migrate/migrate.mjs copy --source $src --target /data/sc --all
```

## 4. Freeze

1. Announce the window (writes and logins fail during it, reads keep working).
2. On the droplet, make nginx reject everything but `GET`, `HEAD` and `OPTIONS` with 503 and reload
   nginx. Keep the change in a separate file so that undoing it is one `rm` and a reload.
3. Check: a `PUT` through Cloudflare returns 503, and a `GET` of a profile still returns 200.

## 5. Final copy and upload

```bash
node scripts/migrate/migrate.mjs copy   --source $src --target /data/sc --all --merge
node scripts/migrate/migrate.mjs verify --source $src --target /data/sc --all --exact
scripts/migrate/azure-upload.sh $rg prod /data/sc
```

`--merge` doesn't delete files that were deleted on the droplet since step 3. If that matters,
copy into a fresh directory instead (it takes longer). `azure-upload.sh` stops the site, uploads and
starts it again.

## 6. Verification before the switch

With the operator access rule:

- `https://solidcommunity.net/.well-known/openid-configuration` returns 200 and the issuer is `https://solidcommunity.net/`.
- `/.oidc/jwks` is identical to the droplet's (the issuer keys were copied, so existing tokens keep validating).
- Three or four known pods return their profile, and a private resource returns 401.
- A password login of a migrated account works, and so does a new registration and pod creation.
- The container log shows no errors at start-up, and the health check in the portal is green.

## 7. DNS switch (Jesse, Cloudflare)

1. Note the current records for `solidcommunity.net` and `*` and the current SSL/TLS mode, for rollback.
2. Point both at `<site>.azurewebsites.net` (CNAME, proxied; Cloudflare flattens the apex). Leave the
   other explicit records (e.g. `ops`) and mail records alone.
3. Set SSL/TLS mode to **Full (strict)**.
4. **Caching > Purge Everything**. The cache rules keep `/.well-known/openid-configuration` for 1 day,
   `/.oidc/jwks` for 10 minutes and `/.well-known/css/*` and `/favicon.ico` for 7 days. The issuer and
   keys are unchanged, and the new CSS version changes the `?v=` in the CSS asset URLs, but a purge
   removes any doubt. Pod resources are never cached.
5. Keep the other Cloudflare rules as they are: the WAF scanner block, the rate limit and its Worker
   skip, and the **Compress none** rule for pod hosts that keeps ETags strong.

The records are proxied, so clients keep resolving to Cloudflare and nothing waits on DNS TTLs: the
switch, and a rollback, take effect within a minute.

## 8. Post-cutover checks

- The checks from step 6, now through Cloudflare, without the access rule. Then remove the rule:
  `az webapp config access-restriction remove -g $rg -n <site> --rule-name operator`.
- `curl -sI https://<site>.azurewebsites.net/` returns 403 (only Cloudflare reaches the origin).
- `curl -sI https://solidcommunity.net/.well-known/openid-configuration` shows `cf-cache-status: HIT` on the second request; `/profile/card` of a pod shows no cache status.
- A `PUT` with `If-Match` of the ETag just read succeeds (strong ETags survive), and a WebSocket notification subscription connects.
- A forgotten-password e-mail arrives.
- For the first day, watch the container log for `Lock expired`, `halting` and 5xx responses, and the plan's CPU and memory.
- Restarts: `az webapp restart` overlaps the old and new containers on the same share for 2 to 4 minutes, each with its own in-memory locks. For planned maintenance use `az webapp stop` then `start` (or `stop_first` in the Deploy workflow), which costs about 4 minutes of downtime.

## 9. Rollback

Possible as long as the droplet's data is still current, that is until writes on Azure matter.
Decide go or no-go within the first hours.

1. Jesse: restore the old `solidcommunity.net` and `*` records and the old SSL/TLS mode, then purge the cache.
2. Undo the nginx freeze on the droplet and reload nginx.
3. Stop the Azure site (`az webapp stop`) so that nothing writes there by mistake.

Anything written on Azure after the switch is lost on rollback. Copying it back needs a manual copy
of the changed pods; the migration script only copies towards Azure.
