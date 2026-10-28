#!/usr/bin/env bash
set -euo pipefail
# Installed and owned by TI, never uploaded/replaced by the workflow.
# authorized_keys: restrict,command="/srv/factuez-delivery/deploy-entry.sh" ssh-ed25519 ...
export PATH=/usr/local/bin:/usr/bin:/bin
exec /usr/bin/node /srv/factuez-delivery/deploy.mjs --stdin /srv/factuez-delivery/deployment.json
