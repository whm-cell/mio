#!/bin/sh
set -eu
umask 077
# The application can only access its own keys; configuration and clearing stay operator-only.
printf 'user default off\nuser mio on >%s ~mio:%s:* +hello +auth +ping +client|setinfo +eval +time +get +set +pttl +del\n' \
  "$MIO_LOCAL_REDIS_PASSWORD" "$MIO_REDIS_NAMESPACE" > /tmp/mio-users.acl
exec redis-server --dir /data --aclfile /tmp/mio-users.acl \
  --appendonly yes --appendfsync everysec --save '' \
  --maxmemory 128mb --maxmemory-policy noeviction --protected-mode yes
