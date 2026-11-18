# Admin setup for solidcommunity.net on Azure

One-off steps for the ODI Azure admin. The same resource group first hosts a **preview environment for
the SolidOS team**, and later the **full migration** of solidcommunity.net. After this setup the operator
(Jesse) deploys both from this repository; the admin is not needed for either, or for day-to-day changes.

## What the admin runs

1. Fill in `admin/subscription.bicepparam`:
   - `operatorObjectId`: `az ad user show --id <operator's ODI email> --query id -o tsv`
   - `alertEmails`: who gets the budget alerts (the operator and the admin)
   - `location`: `uksouth` unless there's a reason to pick another region
   - `budgetStartDate`: the 1st of the current or next month
2. Run, signed in with Owner (or Contributor + User Access Administrator) on the subscription:

   ```bash
   az login
   az account set -s <subscription id>
   bash admin/bootstrap.sh
   ```

3. Send the operator the subscription id, tenant id and resource group name the script prints.

The script is safe to re-run.

## What it creates and grants

| Item | Detail |
|---|---|
| Resource providers | Microsoft.Web, Storage, Network, ManagedIdentity, ContainerRegistry, Consumption |
| Resource group | `solidcommunity` in `uksouth`, holding the preview and, later, production |
| Operator: Contributor | On that resource group only |
| Operator: Role Based Access Control Administrator | On that resource group only, **limited by a condition** to assigning Contributor, AcrPull and AcrPush (for the deploy and image-pull managed identities) |
| Budget | 300 per month (billing currency) on the resource group, with email alerts at 50%, 80% and 100% of actual spend and at 100% of forecast spend |

No Entra ID app registration or directory permissions are needed: GitHub Actions signs in through a
user-assigned managed identity with a federated credential, created by the operator inside the group.
DNS stays in Cloudflare, and no Key Vault is used.

Azure budgets send alerts but do not stop anything. If ODI wants a hard stop, that has to be an
action group on the budget that stops the web app, which we can add.

## Things the script checks but can't fix

- **App Service quota.** The preview uses one Linux B1 plan and production one Linux P1v3 plan (2 vCPUs). If the first deployment fails
  with a quota error, request 2 "Premium v3 vCPUs" for App Service in the region under Portal > Quotas.
- **Policy.** The deployment needs a VNet, a private endpoint, a private DNS zone
  (`privatelink.file.core.windows.net`) and a Premium FileStorage account with public network access
  disabled. The script lists the policy assignments on the group; none of them may deny those.

## What will run in the group, and roughly what it costs

These are list-price estimates for UK South, not quotes.

**Stage 1, SolidOS preview** (`environments/preview.bicepparam`): a fresh server on the Azure
`*.azurewebsites.net` hostname with pods under paths and no migrated accounts.

| Resource | Size | Approx. per month |
|---|---|---|
| App Service plan | B1 Linux | $15 |
| Storage account | Premium file share, 100 GiB | $20 |
| Private endpoint | 1 | $8 |
| Container registry | Basic, shared with production | $5 |
| **Total** | | **about $50** |

**Stage 2, production** (`environments/prod.bicepparam`), added alongside the preview:

| Resource | Size | Approx. per month |
|---|---|---|
| App Service plan | P1v3 Linux, 1 instance (2 vCPU, 8 GB) | $125 |
| Storage account | Premium file share, 200 GiB | $40 |
| Private endpoint + private DNS zone | 1 each | $8 |
| Bandwidth | Cloudflare caches most static traffic | $5–15 |
| **Total** | | **about $185** |

With both running, that's about $235 a month. The 300 budget covers that, plus temporary extra
storage during the migration. The preview can be scaled down or deleted once production is live.

**Why P1v3 for production.** B1 is fine for the preview and was enough for the test site's synthetic load, but it has 1.75 GB of
memory and one slow vCPU. The DigitalOcean server runs CSS with a 6 GB heap limit, and on B1 the test
site sat at 76–88% memory with almost no traffic. During every restart App Service runs the old and new
containers side by side, and on B1 that pinned the CPU at 100% for about three minutes. P1v3 gives
8 GB and two faster vCPUs for about $110 more per month. The plan size is one line in
`environments/prod.bicepparam`, so it can be changed later without the admin.
