#!/bin/sh
set -e

PUID=${PUID:-911}
PGID=${PGID:-911}

# Re-map the internal appuser/appgroup to the requested UID/GID at runtime
groupmod -o -g "$PGID" appgroup
usermod  -o -u "$PUID" appuser

# Fix ownership of the app dir so gunicorn can write its pid etc.
chown -R appuser:appgroup /app

echo "Running as uid=$(id -u appuser) gid=$(id -g appuser)"

exec gosu appuser gunicorn --config gunicorn.conf.py app:app
