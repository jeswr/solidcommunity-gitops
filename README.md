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
| `templates/root/wac/.acl` | Public, read-only server root. |
| `templates/root/wac/index.html` | Landing page, served for the root container to browsers (upstream `IndexRepresentationStore`). Holds the acceptable use policy. Only written when the root is first created, so an existing root needs it copied in by hand. |
| `templates/pod/wac` | SolidOS pod template, copied from SolidOS/css-mashlib@5cb4457 (identical to pivot's). |
| `templates/identity/password/login.html.ejs` | Login page in the site layout. Accepts a bare username so that NSS-migrated accounts (`<user>@users.css.pod`) can still log in. |
| `templates/identity/password/register.html.ejs` | Sign-up asks for a name and username and creates the account's Pod and WebID straight away, so every account has one. |
| `templates/identity/account/resource.html.ejs` | Simple account page: your Pod, your WebID, change email, change password. The upstream lists (extra logins, Pods, WebIDs, tokens) sit under "Advanced settings". |
| `templates/identity/oidc/consent.html.ejs` | App consent page that shows the person's name and picture from their profile; the client ID moves under "App details". |
| `templates/main.html.ejs` | Site layout (ODI and Solid branding) for every CSS account, login and consent page. The upstream page templates are unchanged. |
| `templates/static/` | Stylesheet, the header's profile menu (name and picture from the WebID profile) and the Solid logo, served under `/.well-known/sc/`. |
| `infra/main.bicep` | App Service (Linux, sitecontainers) with an Azure Files share over a private endpoint. Based on theodi/css-azure-deployment. |
| `environments/<env>.bicepparam` | Desired state of each environment: image, SKU, base URL. |
| `.github/workflows/image.yml` | Builds the image, smoke-tests it and pushes it to GHCR. |
| `.github/workflows/deploy.yml` | Deploys an environment when `infra/` or `environments/` change on `main`. |

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
