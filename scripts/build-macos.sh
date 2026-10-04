#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# Prefer a development signature for local Notification Center support.
# An explicit identity always wins; do not commit personal signing identities.
if [ -z "${TINYJS_SIGN_IDENTITY:-}" ]; then
  dev_chat_identity=$(security find-identity -v -p codesigning |
    awk '/"Apple Development:/ { print $2; exit }')
  if [ -n "$dev_chat_identity" ]; then
    export TINYJS_SIGN_IDENTITY="$dev_chat_identity"
  else
    echo "No Apple Development identity found; building ad-hoc. Native notification click-through requires a signed build." >&2
  fi
fi
sh scripts/build-runtime.sh
exec ./.runtime/tinyjs build "$@"
