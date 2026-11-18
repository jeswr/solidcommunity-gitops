#!/bin/bash
# One-off setup of the solidcommunity.net production resource group. Run by a subscription admin
# (Owner, or Contributor + User Access Administrator, on the subscription) after filling in
# admin/subscription.bicepparam. Safe to re-run.
#
#   az login && az account set -s <subscription id>
#   bash admin/bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")"
LOCATION=$(grep -E "^param location" subscription.bicepparam | sed -E "s/.*'(.*)'/\1/")

echo "1/4 Registering resource providers"
for p in Microsoft.Web Microsoft.Storage Microsoft.Network Microsoft.ManagedIdentity Microsoft.ContainerRegistry Microsoft.Consumption; do
  az provider register -n "$p" --wait -o none
  echo "  $p: $(az provider show -n "$p" --query registrationState -o tsv)"
done

echo "2/4 Checking App Service P1v3 is offered in $LOCATION"
if az appservice list-locations --sku P1V3 --linux-workers-enabled -o tsv --query "[].name" | tr -d ' ' | grep -qix "$(az account list-locations --query "[?name=='$LOCATION'].displayName" -o tsv | tr -d ' ')"; then
  echo "  P1v3 Linux is available in $LOCATION"
else
  echo "  WARNING: P1v3 Linux not listed for $LOCATION. Pick another region or request it." >&2
fi
echo "  If the first deployment fails with a quota error, request 2 'Premium v3 vCPUs' for App Service in $LOCATION (Portal > Quotas)."

echo "3/4 Creating the resource group, budget and operator roles"
az deployment sub create -l "$LOCATION" -n solidcommunity-bootstrap -f subscription.bicep -p subscription.bicepparam -o none
RG=$(az deployment sub show -n solidcommunity-bootstrap --query properties.outputs.resourceGroupId.value -o tsv)
echo "  $RG"

echo "4/4 Policies that apply to the resource group (check none block private endpoints, private DNS zones, VNets or Premium FileStorage accounts)"
az policy assignment list --scope "$RG" --disable-scope-strict-match --query "[].{name:displayName, effect:parameters.effect.value}" -o table || true
echo
echo "Done. Send the operator: subscription id $(az account show --query id -o tsv), tenant id $(az account show --query tenantId -o tsv), resource group $RG."
