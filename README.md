# solidcommunity-gitops

GitOps prototype for running [solidcommunity.net](https://solidcommunity.net) on Azure.
It is prototyped here and will move to the ODI organisation.

The aim is to have as few custom parts as possible: upstream Community Solid Server (CSS),
Mashlib as the UI, a config file, and the Azure deployment. There is no `@solid/pivot`, no
forked CSS release and no custom components.

## Layout

| Path | What |
|---|---|
| `Dockerfile` | Builds CSS from a pinned git commit, then adds Mashlib, the config and the templates. |
| `config/base.json` | Upstream CSS components only. File backend, in-memory locker, 50 MB pod quota, SolidOS pod layout, Mashlib as the default UI. |
| `config/solidcommunity.net.json` | Production entry point, with one pod per subdomain. |
| `config/test.json` | Test entry point, with pods under paths, because `*.azurewebsites.net` has no wildcard DNS. |
| `config/email.template.json` | SendGrid settings. The key is injected at start-up from `SMTP_PASSWORD` and is never committed. |
| `templates/root/wac/.acl` | Public, read-only server root (the Mashlib landing page). |
| `templates/pod/wac` | SolidOS pod template, copied from SolidOS/css-mashlib@5cb4457 (identical to pivot's). |
| `templates/identity/password/login.html.ejs` | Upstream login page. Accepts a bare username so that NSS-migrated accounts (`<user>@users.css.pod`) can still log in. |
| `infra/main.bicep` | App Service (Linux, sitecontainers) with an Azure Files share over a private endpoint. Based on theodi/css-azure-deployment. |
| `environments/<env>.bicepparam` | Desired state of each environment: image, SKU, base URL. |
| `.github/workflows/image.yml` | Builds the image, smoke-tests it and pushes it to GHCR. |
| `.github/workflows/deploy.yml` | Deploys an environment when `infra/` or `environments/` change on `main`. |
| `scripts/migrate/` | Copies accounts and pods from the DigitalOcean data directory. See [Migrating data](#migrating-data). |

## Why CSS comes from git, not npm

The CSS fixes solidcommunity.net depends on landed on CSS `main` after 7.2.0 was released:

- write-lock renewal (#2217) and `maxHoldDuration` (#2221)
- streamed container listings (#2211), which matter for the very large inboxes
- the pod quota fix in subdomain mode (#2210), without which the quota is silently unlimited

Once a CSS release includes them, the builder stage can become a normal npm dependency.

## What is not here yet, compared with the DigitalOcean server

| Live today | Status |
|---|---|
| Stream/lock hotfix from the 7.1.10 alpha | Not upstream. Being proposed as small CSS PRs. |
| Notification storage deadlock fix (fork #113) | Not upstream. Being proposed. |
| Expired notification channel sweep (#2222) | Open upstream PR, with changes requested. |
| Subdomain `/.well-known/openid-configuration` redirect (pivot) | Needs a CSS routing fix. Being proposed. Only matters in subdomain mode. |
| Perf patches (ACL cache, converter cache, sync quad parsing, …) | Not upstream. Left out for now, so the server is slower without them. |
| `@jeswr/css-cached-storage` read cache | Left out, because it's a custom component. Add it if production needs it. |
| In-memory cookie/OIDC storage | Left out. Upstream has no preset for it. |
| pivot's FedCM handler, N3 Patch list-preserving store and container redirect writer | Dropped. They are experimental, cosmetic or leak information. |

## Test environment

One-off setup, done once per subscription:

1. Create a resource group, e.g. `az group create -n solidcommunity-test -l switzerlandnorth` (the Azure for Students subscription only allows switzerlandnorth, norwayeast, belgiumcentral, polandcentral and denmarkeast).
2. Create a user-assigned managed identity with a federated credential for `repo:jeswr/solidcommunity-gitops:environment:test`, and give it Contributor on that resource group. This avoids needing an Entra app registration in the university tenant.
3. In the repo's `test` environment, set the secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and `SMTP_PASSWORD` (optional), and the variable `AZURE_RESOURCE_GROUP`.

After that, a merge to `main` that touches `environments/test.bicepparam` or `infra/` deploys.

## Local run

```bash
docker build -t solidcommunity .
docker run -p 3000:3000 -e CSS_BASE_URL=http://localhost:3000/ -e CSS_ROOT_FILE_PATH=/tmp/data solidcommunity
```

## Migrating data

`scripts/migrate/migrate.mjs` (Node 20+, rsync, no npm dependencies) copies accounts and pods from a
CSS file-backend root into an empty directory, which `azure-upload.sh` then uploads to the Azure Files share.
The source is a local directory or `ssh://user@host/path`. The script only reads it: over ssh it
runs `cat`, `test`, `find`, `du` and `ls`, and rsync only pulls. Output is limited to counts, pod names
and account IDs. E-mail addresses are masked, and password hashes, secrets and file contents are never printed.

```bash
src=ssh://root@solidcommunity.net/mnt/volume_lon1_01/solidcommunity.net
# Plan: counts and sizes only. --names-check also looks for names Azure Files can't store.
node scripts/migrate/migrate.mjs copy --source $src --target /data/sc --all --dry-run --names-check
node scripts/migrate/migrate.mjs copy --source $src --target /data/sc --all
node scripts/migrate/migrate.mjs verify --source $src --target /data/sc --all
# A few accounts, by pod name or e-mail address:
node scripts/migrate/migrate.mjs copy --source $src --target /data/some --accounts alice,bob@users.css.pod
# To the test environment (suffix identifiers, another host):
node scripts/migrate/migrate.mjs copy --source $src --target /data/test --all \
  --target-base-url https://sc-test-xxxx.azurewebsites.net/ --target-layout suffix
scripts/migrate/azure-upload.sh <resource-group> <env> /data/sc --dry-run
```

The source defaults to `--source-base-url https://solidcommunity.net/ --source-layout subdomain`. The target
defaults to the same values, in which case no files are rewritten. The target directory must be empty
unless you pass `--merge`, and then source files overwrite target files.

What is copied (paths under `www/.internal/` in the subdomain layout, `.internal/` in the suffix layout):

| | `--all` | `--accounts` |
|---|---|---|
| Account records (`accounts/data`) | all | only the selected accounts |
| Account index (`accounts/index`) | all | only entries for those accounts, worked out from their records, with any other account IDs removed |
| Pods | every top-level directory except `www`, `.internal` and `lost+found` | the selected accounts' pods |
| `idp/keys`, `setup/`, the base host's root files (`.acl`, `index.html`) | yes | yes |
| OIDC client registrations (`idp/adapter/Client`) | yes | no, because they don't belong to an account |
| Cookies, forgot-password, locks, notifications, `idp/tokens`, other `idp/adapter` entries | no | no |

Because cookies, refresh tokens and grants are not copied, users log in again to the account pages and
apps log in again. The issuer keys are copied, so the issuer keeps its signing keys, and client
credentials keep working.

`verify` boots nothing. For each selected account (or every account with `--all`) it checks that the
record parses, that every index entry exists and contains the account, and that each pod has a root
`.acl`. It warns about pods whose root `.meta` doesn't mark them as a storage, because the pod quota
doesn't apply to those pods. It also checks `idp/keys/jwks` and the setup markers.
With `--source` it compares records and pod file counts with the source, and with `--exact` it fails
if the target holds accounts that were not selected.

### Changing the base URL

Passing `--target-base-url` or `--target-layout` rewrites absolute URLs of the source host and its
pod subdomains (`https://alice.solidcommunity.net/…` becomes `https://<host>/alice/…` in the suffix layout):

- account records (WebID links, pod base URLs, owners and client-credential WebIDs) and the setup markers
- index file names that contain those URLs
- pod files with RDF extensions (`.acl`, `.meta`, `.ttl`, `.n3`, `.nt`, `.nq`, `.trig`, `.jsonld`), including
  the pod root `.meta`, which the pod quota needs, and profile `solid:oidcIssuer`

What it can't fix:

- WebIDs change, so anything outside the pods that refers to the old WebIDs or pod URLs no longer
  matches: ACLs and data on other servers, apps' stored data, links and bookmarks.
- Files with other extensions (HTML, JSON, Markdown, text, files without an extension, binaries) are left
  alone. Inside RDF files, matching URLs in literals are rewritten too.
- OIDC client registrations keep their redirect URIs.
- Pod names that clash with paths the base host already serves in the suffix layout (`.account`, `.oidc`,
  `.well-known`, and Mashlib's files at the root) are not detected.
- Only a subdomain-layout source can be rewritten.

### Uploading to Azure Files

`azure-upload.sh` stops the site, copies the directory to the root of the `pods` share with azcopy (using a
12-hour SAS), and starts the site again. Run `verify` on the local directory first. The script is untested,
because it needs Azure. Before running it:

- The storage account only accepts traffic from its private endpoint. Either run the script from inside the
  VNet, or temporarily allow your IP with `az storage account update --public-network-access Enabled`
  and `az storage account network-rule add --ip-address <ip>`. Remove the rule afterwards. The next
  deploy also resets public access.
- Azure Files names are case-insensitive, at most 255 characters long, and can't end in a dot or a space.
  Check the source with `--names-check` first, because such files would collide or fail to upload.

### Test

`scripts/migrate/test.sh` runs the whole flow with synthetic data. It needs Docker, Node, rsync and curl.
The test seeds a server running the production config with four accounts. One account has an `@users.css.pod`
e-mail address, and another has an e-mail address long enough that CSS hashes its index file name. The seeded
data also includes pods, private and shared files with ACLs, client credentials and an OIDC client registration.
The test then migrates a subset, everything, everything to the test (suffix) config on another port, and a
subset to that port, and boots the image on each target. Over HTTP it checks:

- password logins and the account's pods and WebIDs
- public, private and shared files, and the binary contents of a file
- DPoP client-credentials tokens
- the 50 MB pod quota
- that accounts which were not selected are absent
- client registrations
- that the JWKS is unchanged

The test also checks that an `ssh://` source, served from a read-only mount, produces the same files as a
local source, and that the source tree is unchanged.

Note that CSS reads every `CSS_*` environment variable as a CLI option, so the container doesn't start with
`CSS_EXTRA_ARGS` set (`Unknown argument: extraArgs`).
