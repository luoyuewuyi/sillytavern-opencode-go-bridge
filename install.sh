#!/bin/sh
set -eu
# No downloads, sudo, dependency installs or network/security changes.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'Node.js >=20 is required. Use the Node already provided by your SillyTavern installation.' >&2
    exit 1
fi
exec node "$script_dir/install/install.mjs" "$@"
