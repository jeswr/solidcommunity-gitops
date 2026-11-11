# Admin setup for solidcommunity.net on Azure

One-off steps for the ODI Azure admin. After this, the operator (Jesse) deploys everything inside the
resource group from this repository; the admin is not needed for day-to-day changes.

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
| Resource group | `solidcommunity-prod` in `uksouth` |
| Operator: Contributor | On that resource group only |
| Operator: Role Based Access Control Administrator | On that resource group only, **limited by a condition** to assigning Contributor, AcrPull and AcrPush (for the deploy and image-pull managed identities) |
| Budget | 250 per month (billing currency) on the resource group, with email alerts at 50%, 80% and 100% of actual spend and at 100% of forecast spend |

No Entra ID app registration or directory permissions are needed: GitHub Actions signs in through a
user-assigned managed identity with a federated credential, created by the operator inside the group.
DNS stays in Cloudflare, and no Key Vault is used.

Azure budgets send alerts but do not stop anything. If ODI wants a hard stop, that has to be an
action group on the budget that stops the web app, which we can add.

## Things the script checks but can't fix

- **App Service quota.** Production uses one Linux P1v3 plan (2 vCPUs). If the first deployment fails
  with a quota error, request 2 "Premium v3 vCPUs" for App Service in the region under Portal > Quotas.
- **Policy.** The deployment needs a VNet, a private endpoint, a private DNS zone
  (`privatelink.file.core.windows.net`) and a Premium FileStorage account with public network access
  disabled. The script lists the policy assignments on the group; none of them may deny those.

## What will run in the group, and roughly what it costs

These are list-price estimates for UK South, not quotes.

| Resource | Size | Approx. per month |
|---|---|---|
| App Service plan | P1v3 Linux, 1 instance (2 vCPU, 8 GB) | $125 |
| Storage account | Premium file share, 200 GiB provisioned | $40 |
| Private endpoint + private DNS zone | 1 each | $8 |
| Container registry | Basic | $5 |
| Bandwidth | Cloudflare caches most static traffic | $5–15 |
| **Total** | | **about $185** |

The 250 budget leaves headroom for bandwidth spikes and temporary doubling during a migration.

**Why P1v3 rather than B1.** B1 was enough for the test site's synthetic load, but it has 1.75 GB of
memory and one slow vCPU. The DigitalOcean server runs CSS with a 6 GB heap limit, and on B1 the test
site sat at 76–88% memory with almost no traffic. During every restart App Service runs the old and new
containers side by side, and on B1 that pinned the CPU at 100% for about three minutes. P1v3 gives
8 GB and two faster vCPUs for about $110 more per month. The plan size is one line in
`environments/prod.bicepparam`, so it can be changed later without the admin.
