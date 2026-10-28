#!/bin/sh
set -eu

db_password="$(cat /run/secrets/demo_db_password)"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=db_password="$db_password" <<'SQL'
SELECT format('CREATE ROLE factuez_demo_app LOGIN PASSWORD %L', :'db_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factuez_demo_app')\gexec
SQL

for database in factuez_identity factuez_billing factuez_sunat; do
  psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=database_name="$database" \
    --set=db_password="$db_password" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER factuez_demo_app', :'database_name')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'database_name')\gexec
SQL
done
