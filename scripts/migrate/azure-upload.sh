#!/usr/bin/env bash
# Uploads a migrated CSS root (made by migrate.mjs and checked with `migrate.mjs verify`) to
# the Azure Files share of an environment. Untested without Azure: read it before running it.
#
#   scripts/migrate/azure-upload.sh <resource-group> <env> <local-dir> [--merge] [--dry-run]
#
# Needs az (logged in) and azcopy. The share is reachable only over the private endpoint
# (publicNetworkAccess is Disabled in infra/main.bicep), so run this from a machine inside the
# VNet, or temporarily allow your IP on the storage account (see the README).
set -euo pipefail

if [ $# -lt 3 ]; then
  sed -n '2,10p' "$0"
  exit 1
fi
rg="$1"; env="$2"; dir="$3"; shift 3
merge=0; dry=()
for arg in "$@"; do
  case "$arg" in
    --merge) merge=1 ;;
    --dry-run) dry=(--dry-run) ;;
    *) echo "unknown option $arg"; exit 1 ;;
  esac
done
[ -d "$dir" ] || { echo "$dir is not a directory"; exit 1; }

account="$(az storage account list -g "$rg" --query "[?starts_with(name, 'sc${env}')].name | [0]" -o tsv)"
site="$(az webapp list -g "$rg" --query "[?starts_with(name, 'sc-${env}-')].name | [0]" -o tsv)"
[ -n "$account" ] && [ -n "$site" ] || { echo "no storage account or site for env $env in $rg"; exit 1; }
share=pods
echo "storage account: $account, share: $share, site: $site"

key="$(az storage account keys list -g "$rg" -n "$account" --query '[0].value' -o tsv)"
expiry="$(date -u -d '+12 hours' +%Y-%m-%dT%H:%MZ 2>/dev/null || date -u -v+12H +%Y-%m-%dT%H:%MZ)"
sas="$(az storage share generate-sas --account-name "$account" --account-key "$key" -n "$share" \
  --permissions rcwdl --expiry "$expiry" --https-only -o tsv)"
url="https://$account.file.core.windows.net/$share"

if [ "$merge" = 0 ] && [ -n "$(azcopy list "$url?$sas" 2>/dev/null | head -n 1)" ]; then
  echo "the share is not empty; pass --merge to upload into it anyway"
  exit 1
fi

if [ ${#dry[@]} -eq 0 ]; then
  echo "stopping $site so CSS doesn't write while the data changes"
  az webapp stop -g "$rg" -n "$site"
fi
# --as-subdir=false copies the contents of $dir (including .internal and .acl) to the share root.
azcopy copy "$dir" "$url?$sas" --recursive --as-subdir=false \
  --preserve-smb-info=false --preserve-permissions=false --overwrite=true ${dry[@]+"${dry[@]}"}
if [ ${#dry[@]} -eq 0 ]; then
  az webapp start -g "$rg" -n "$site"
  echo "started $site; check https://<host>/.well-known/openid-configuration and log in as a migrated user"
fi
