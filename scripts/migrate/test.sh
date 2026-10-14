#!/usr/bin/env bash
# End-to-end test of scripts/migrate with synthetic data only.
#
# 1. Boots the image with the production (subdomain) config on an empty source directory and
#    creates accounts, pods, files, ACLs, client credentials and an OIDC client registration.
# 2. Migrates (a) a subset, (b) everything, (c) everything to a different base URL with the
#    test (suffix) config, and (d) a subset to that base URL, each into a fresh directory.
#    (Run the image without CSS_EXTRA_ARGS: CSS reads CSS_* variables as CLI options.)
# 3. Boots the image on each target and checks over HTTP: password logins, pods, files, ACLs,
#    client-credentials tokens, absent accounts, client registrations and unchanged JWKS.
#
# Needs Docker, Node >= 20, rsync and curl. Usage: scripts/migrate/test.sh
# IMAGE=<tag> to use a prebuilt image (default: builds sc-gitops:dev), KEEP=1 to keep the data.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
IMAGE="${IMAGE:-}"
PORT=3101
RPORT=3103
BASE="http://localhost:$PORT/"
RBASE="http://localhost:$RPORT/"
PODS=(alice bob carol dave dave-two)
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sc-migrate-test.XXXXXX")"
STATE="$WORK/state.json"
migrate=(node "$here/migrate.mjs")
e2e=(node "$here/test/e2e.mjs")

cleanup() {
  docker rm -f sc-migrate-test >/dev/null 2>&1 || true
  if [ "${KEEP:-}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

if [ -z "$IMAGE" ]; then
  IMAGE=sc-gitops:dev
  docker build -q -t "$IMAGE" "$repo" >/dev/null
fi

start_css() { # dir config port
  local hosts=()
  for pod in "${PODS[@]}"; do hosts+=(--add-host "$pod.localhost:127.0.0.1"); done
  docker run -d --name sc-migrate-test --user "$(id -u):$(id -g)" -p "$3:$3" \
    -e CSS_PORT="$3" -e CSS_BASE_URL="http://localhost:$3/" -e CSS_CONFIG="$2" \
    -v "$1:/data" "${hosts[@]}" "$IMAGE" >/dev/null
  for _ in $(seq 1 120); do
    if curl -sf "http://localhost:$3/.well-known/openid-configuration" >/dev/null; then return 0; fi
    sleep 1
  done
  docker logs --tail 50 sc-migrate-test
  return 1
}
stop_css() { docker rm -f sc-migrate-test >/dev/null; }

tree_hash() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 shasum | shasum | cut -c1-16); }

section() { printf '\n== %s\n' "$*"; }

section "seed source (subdomain, $BASE)"
mkdir -p "$WORK/source"
start_css "$WORK/source" config/solidcommunity.net.json $PORT
"${e2e[@]}" seed "$BASE" "$STATE"
stop_css
before="$(tree_hash "$WORK/source")"

common=(--source "$WORK/source" --source-base-url "$BASE")

section "(a) subset: alice + carol (by e-mail)"
"${migrate[@]}" copy "${common[@]}" --target "$WORK/subset" --accounts alice,carol@users.css.pod --dry-run
test ! -e "$WORK/subset" || { echo "dry run wrote to the target"; exit 1; }
"${migrate[@]}" copy "${common[@]}" --target "$WORK/subset" --accounts alice,carol@users.css.pod
if "${migrate[@]}" copy "${common[@]}" --target "$WORK/subset" --accounts bob 2>/dev/null; then
  echo "copy into a non-empty target without --merge should fail"; exit 1
fi
"${migrate[@]}" verify "${common[@]}" --target "$WORK/subset" --accounts alice,carol@users.css.pod --exact
if "${migrate[@]}" verify --target "$WORK/subset" --source-base-url "$BASE" --accounts bob >/dev/null; then
  echo "verify should fail for an account that was not migrated"; exit 1
fi
"${e2e[@]}" index "$WORK/source/www/.internal" "$WORK/subset/www/.internal"
start_css "$WORK/subset" config/solidcommunity.net.json $PORT
"${e2e[@]}" check "$BASE" subdomain "$STATE" alice,carol bob,dave
stop_css

section "(b) all"
"${migrate[@]}" copy "${common[@]}" --target "$WORK/all" --all --dry-run --names-check
"${migrate[@]}" copy "${common[@]}" --target "$WORK/all" --all
"${migrate[@]}" verify "${common[@]}" --target "$WORK/all" --all
"${e2e[@]}" index "$WORK/source/www/.internal" "$WORK/all/www/.internal"
start_css "$WORK/all" config/solidcommunity.net.json $PORT
"${e2e[@]}" check "$BASE" subdomain "$STATE" alice,bob,carol,dave "" --clients
stop_css

rewrite=(--target-base-url "$RBASE" --target-layout suffix)

section "(c) all, rewritten to $RBASE with suffix identifiers (test config)"
"${migrate[@]}" copy "${common[@]}" "${rewrite[@]}" --target "$WORK/rewrite" --all
"${migrate[@]}" verify "${common[@]}" "${rewrite[@]}" --target "$WORK/rewrite" --all
start_css "$WORK/rewrite" config/test.json $RPORT
"${e2e[@]}" check "$RBASE" suffix "$STATE" alice,bob,carol,dave "" --clients
stop_css

# dave is selected by his long e-mail address, whose index file name is hashed.
DAVE="$(printf 'd%.0s' $(seq 1 64))@a-very-long-subdomain-name-for-testing-hashed-keys.example.org"
section "(d) subset alice + bob + dave (by e-mail), rewritten to $RBASE"
"${migrate[@]}" copy "${common[@]}" "${rewrite[@]}" --target "$WORK/rewrite-subset" --accounts "alice,bob,$DAVE"
"${migrate[@]}" verify "${common[@]}" "${rewrite[@]}" --target "$WORK/rewrite-subset" --accounts "alice,bob,$DAVE" --exact
start_css "$WORK/rewrite-subset" config/test.json $RPORT
"${e2e[@]}" check "$RBASE" suffix "$STATE" alice,bob,dave carol
stop_css

section "source unchanged"
after="$(tree_hash "$WORK/source")"
[ "$before" = "$after" ] || { echo "source tree changed"; exit 1; }
echo "source tree hash unchanged ($after)"

printf '\nALL MIGRATION TESTS PASSED\n'
