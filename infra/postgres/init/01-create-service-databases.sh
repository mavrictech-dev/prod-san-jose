#!/usr/bin/env sh
set -eu

identity_password="$(cat /run/secrets/identity_db_password)"
billing_password="$(cat /run/secrets/billing_db_password)"
sunat_password="$(cat /run/secrets/sunat_db_password)"
mailer_password="$(cat /run/secrets/mailer_db_password)"
reporting_password="$(cat /run/secrets/reporting_db_password)"

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=identity_password="$identity_password" \
  --set=billing_password="$billing_password" \
  --set=sunat_password="$sunat_password" \
  --set=mailer_password="$mailer_password" \
  --set=reporting_password="$reporting_password" <<-'SQL'
CREATE ROLE factuez_identity LOGIN PASSWORD :'identity_password';
CREATE ROLE factuez_billing LOGIN PASSWORD :'billing_password';
CREATE ROLE factuez_sunat LOGIN PASSWORD :'sunat_password';
CREATE ROLE factuez_mailer LOGIN PASSWORD :'mailer_password';
CREATE ROLE factuez_reporting LOGIN PASSWORD :'reporting_password';

CREATE DATABASE factuez_identity OWNER factuez_identity;
CREATE DATABASE factuez_billing OWNER factuez_billing;
CREATE DATABASE factuez_sunat OWNER factuez_sunat;
CREATE DATABASE factuez_mailer OWNER factuez_mailer;
CREATE DATABASE factuez_reporting OWNER factuez_reporting;
SQL
