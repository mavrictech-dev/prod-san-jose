#!/bin/sh
set -eu
for component in identity billing sunat mailer received; do
 owner="factuez_${component}"
 case "$component" in
 identity) schema=identity-service ;;
 billing) schema=billing-service ;;
 sunat) schema=sunat-service ;;
 mailer) schema=mailer-worker ;;
 received) schema=received-documents-service ;;
 esac
 OWNER_PASSWORD="$(cat "/run/secrets/${component}_db_password")"
 case "$OWNER_PASSWORD" in ''|*[!0-9a-f]*) echo 'INVALID_INSTALLATION_SECRET' >&2; exit 1;; esac
 export OWNER_PASSWORD
 psql -X -q --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres --set=owner="$owner" <<'SQL'
\getenv owner_password OWNER_PASSWORD
CREATE ROLE :"owner" LOGIN PASSWORD :'owner_password';
SELECT format('CREATE DATABASE %I OWNER %I', :'owner', :'owner')\gexec
SQL
 PGPASSWORD="$OWNER_PASSWORD" PGOPTIONS="-c factuez.schema_target=${owner}" psql -X -q --set=ON_ERROR_STOP=1 --username "$owner" --dbname "$owner" --file "/schema/${schema}.sql"
 unset OWNER_PASSWORD
done
touch "$PGDATA/factuez-schema-ready"
