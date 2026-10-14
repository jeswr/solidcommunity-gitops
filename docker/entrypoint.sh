#!/bin/sh
# Starts CSS with the config chosen by the environment.
# Secrets arrive as environment variables and are written to a config file outside the
# image at start-up, so nothing secret is baked into the image or committed to git.
set -eu

: "${CSS_BASE_URL:?CSS_BASE_URL must be set}"
CSS_CONFIG="${CSS_CONFIG:-config/test.json}"
CSS_ROOT_FILE_PATH="${CSS_ROOT_FILE_PATH:-/data}"
CSS_PORT="${CSS_PORT:-3000}"

configs="$CSS_CONFIG"

if [ -n "${SMTP_PASSWORD:-}" ]; then
  secret_config="$(mktemp -d)/email.json"
  node -e '
    const fs = require("fs");
    const template = JSON.parse(fs.readFileSync("config/email.template.json", "utf8"));
    template["@graph"][0].overrideParameters.emailConfig_auth_pass = process.env.SMTP_PASSWORD;
    fs.writeFileSync(process.argv[1], JSON.stringify(template), { mode: 0o600 });
  ' "$secret_config"
  configs="$configs $secret_config"
fi

# shellcheck disable=SC2086
exec node node_modules/@solid/community-server/bin/server.js \
  -c $configs \
  -m /app \
  -f "$CSS_ROOT_FILE_PATH" \
  -b "$CSS_BASE_URL" \
  -p "$CSS_PORT" \
  ${SC_EXTRA_ARGS:-}
