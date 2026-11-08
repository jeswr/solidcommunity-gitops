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
| `infra/monitoring.bicep` | Logs, alert rules and the action group that emails operators and opens incident issues. |
| `.github/workflows/incident.yml` | Hands incidents and failed builds or deploys to Claude Code, which proposes fixes as draft PRs. |

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

## Monitoring and incidents

Everything is Azure-native, sized to stay within free or near-free tiers:

- **Logs.** Container stdout (CSS's log) and App Service platform events go to a Log
  Analytics workspace with 30-day retention and a 0.15 GB/day cap, which keeps a month inside
  the free ingestion allowance. Per-request HTTP logs are off by default (`collectHttpLogs`).
- **Alerts.** Health check failing (the server is down), a burst of 5xx responses, slow
  responses, plan CPU or memory above 90%, the pod share above 80% of its quota, a burst of
  CSS error logs (expired locks and so on), and container crashes or restarts. The log
  thresholds are first guesses to tune once there are real logs.
- **Outside-in probe** (optional, `availabilityTestEnabled`). Fetches the public
  `/.well-known/openid-configuration` from two European locations every 15 minutes and
  checks the TLS certificate. It catches DNS, certificate and proxy failures the in-platform
  health check can't see, but it is billed per run, so it is off in the test environment.

When an alert fires, the action group emails `ALERT_EMAIL` and opens a GitHub issue labelled
`incident`. The [incident workflow](.github/workflows/incident.yml) then runs Claude Code
with read-only Azure access: it finds the cause in the logs and metrics, and when the fix
belongs in this repo it opens a **draft** PR. When the cause is in CSS or Mashlib it writes the
bug up on the issue instead. A failed image build or deploy on `main` gets the same
treatment, and `@claude` in any issue or PR comment asks for a follow-up. Nothing is ever
deployed automatically: a person reviews and merges, and the merge deploys as usual.

Repeats of an alert that already has an open incident issue are folded into that issue.
Close the issue once the incident is over.

### Setup, once per repo

1. Install the Claude GitHub app and add the token: run `/install-github-app` in Claude Code,
   which installs the app on this repo and stores `CLAUDE_CODE_OAUTH_TOKEN` (a Claude
   subscription) or `ANTHROPIC_API_KEY` (API billing) as a repo secret.
2. Create the `incident` label.
3. Create a fine-grained GitHub token with only **Issues: read and write** on this repo and
   store it as the `INCIDENT_GITHUB_TOKEN` secret of each deploy environment. It is what
   lets Azure open incident issues. Leave it unset to get email alerts only.
4. Set the `ALERT_EMAIL` variable on each deploy environment.
5. Create a second Entra app for the `incident` GitHub environment, with a federated
   credential for that environment and only **Reader** and **Log Analytics Reader** on the
   resource group. Store its `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`
   as secrets of the `incident` environment and set `AZURE_RESOURCE_GROUP` there too. Claude
   never gets the deploy identity.
6. Protect `main` so that changes need a pull request.

Issue text and log lines can contain text from anyone who sends the server a request, so
Claude is told to treat them as data, is limited to an allow-list of read-only Azure
commands plus git and `gh`, and can only open draft PRs.

## Local run

```bash
docker build -t solidcommunity .
docker run -p 3000:3000 -e CSS_BASE_URL=http://localhost:3000/ -e CSS_ROOT_FILE_PATH=/tmp/data solidcommunity
```
