#!/bin/sh
set -eu
# Fixed identifiers; psql quotes password values read only inside the isolated container.
for component in identity billing sunat mailer received; do
 owner="factuez_${component}"
 OWNER_PASSWORD="$(cat "/backup/state/secrets/${component}_db_password")"
 case "$OWNER_PASSWORD" in ''|*[!0-9a-f]*) exit 61;; esac
 export OWNER_PASSWORD
 psql -X -q --set=ON_ERROR_STOP=1 -U postgres -d postgres --set=owner="$owner" <<'SQL'
\getenv owner_password OWNER_PASSWORD
CREATE ROLE :"owner" LOGIN PASSWORD :'owner_password';
SELECT format('CREATE DATABASE %I OWNER %I', :'owner', :'owner')\gexec
SQL
 unset OWNER_PASSWORD
done
