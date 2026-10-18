#!/bin/sh
# Run psql against the local SereneDB container.
exec env PGPASSWORD="${PGPASSWORD:-serene}" psql -h 127.0.0.1 -p "${PGPORT:-7890}" -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"
