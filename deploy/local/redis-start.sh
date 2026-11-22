#!/bin/sh
set -eu
umask 077
# The application can only access its own keys; regression tests only access ~mio:regtest-*:*.
{
  printf 'user default off\n'
  printf 'user mio on >%s ~mio:%s:* +hello +auth +ping +client|setinfo +eval +time +get +set +pttl +del\n' \
    "$MIO_LOCAL_REDIS_PASSWORD" "$MIO_REDIS_NAMESPACE"
  if [ -n "${MIO_LOCAL_REGRESSION_PASSWORD:-}" ]; then
    printf 'user mio_regression on >%s ~mio:regtest-*:* +hello +auth +ping +client|setinfo +eval +time +get +set +pttl +del\n' \
      "$MIO_LOCAL_REGRESSION_PASSWORD"
  fi
  if [ -n "${MIO_LOCAL_REDIS_MONITOR_PASSWORD:-}" ]; then
    printf 'user mio_monitor on >%s resetkeys -@all +hello +auth +ping +client|setinfo +time +dbsize +info\n' \
      "$MIO_LOCAL_REDIS_MONITOR_PASSWORD"
  fi
} > /tmp/mio-users.acl
exec redis-server --dir /data --aclfile /tmp/mio-users.acl \
  --appendonly yes --appendfsync everysec --save '' \
  --maxmemory 128mb --maxmemory-policy noeviction --protected-mode yes
