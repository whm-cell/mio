#!/bin/sh
set -eu
# Runs only when the official image initializes this environment's new volume.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=database="$POSTGRES_DB" --set=password="$MIO_LOCAL_DATABASE_PASSWORD" <<'SQL'
CREATE ROLE mio LOGIN PASSWORD :'password';
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"database" TO mio;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO mio;
SQL

if [ "$MIO_ENVIRONMENT" = test ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=password="$MIO_LOCAL_REGRESSION_PASSWORD" <<'SQL'
CREATE ROLE mio_regression LOGIN PASSWORD :'password';
CREATE DATABASE mio_regression_test OWNER mio_regression;
REVOKE ALL ON DATABASE mio_regression_test FROM PUBLIC;
SQL
fi
