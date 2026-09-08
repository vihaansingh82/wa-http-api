#!/bin/sh
set -eu

# AUTH_DIR holds every tenant's WhatsApp credentials, so on a real deployment it
# sits on a mounted volume rather than in the image. A freshly created volume is
# owned by root:root, and a container that starts straight as `node` cannot
# create anything inside it -- every session would die with EACCES on the first
# write, which looks like a WhatsApp problem and is not one.
#
# So: start as root, fix the ownership of that one directory, then drop to
# `node` for the actual process. If the image is run with an explicit --user we
# are not root, there is nothing to fix, and we just exec through.
AUTH_DIR="${AUTH_DIR:-/app/auth}"

if [ "$(id -u)" = '0' ]; then
  mkdir -p "$AUTH_DIR"

  # Only chown when it is not already ours. Recursing a large session tree on
  # every boot costs real time once a few dozen tenants are linked.
  if [ "$(stat -c '%u' "$AUTH_DIR")" != "$(id -u node)" ]; then
    echo "entrypoint: taking ownership of $AUTH_DIR for the node user" >&2
    chown -R node:node "$AUTH_DIR"
  fi

  if ! command -v setpriv >/dev/null 2>&1; then
    # Refuse rather than silently running the socket as root.
    echo "entrypoint: setpriv is missing, cannot drop privileges" >&2
    exit 1
  fi

  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
