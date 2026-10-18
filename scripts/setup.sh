#!/usr/bin/env bash
# One-command data setup: download BGL, verify, parse to Parquet, start SereneDB, load and index.
set -euo pipefail
cd "$(dirname "$0")/.."

BGL_URL="https://zenodo.org/records/8196385/files/BGL.zip?download=1"
BGL_MD5="4452953c470f2d95fcb32d5f6e733f7a"
EXPECTED_ROWS=4747963

mkdir -p data/raw data/parquet
if [ ! -f data/raw/BGL.log ]; then
  curl -L --fail -o data/raw/BGL.zip "$BGL_URL"
  echo "$BGL_MD5  data/raw/BGL.zip" | md5sum -c -
  unzip -o -q data/raw/BGL.zip -d data/raw
fi
[ -f data/parquet/bgl.parquet ] || python3 -I ingest/parse_bgl.py data/raw/BGL.log data/parquet/bgl.parquet

# Small public Loghub samples in other formats, for trying the upload feature.
mkdir -p data/samples data/parquet/uploads
for n in HDFS Linux Apache OpenSSH Zookeeper Spark; do
  [ -f "data/samples/${n}_2k.log" ] || curl -sfL -o "data/samples/${n}_2k.log" "https://raw.githubusercontent.com/logpai/loghub/master/$n/${n}_2k.log"
done

docker compose up -d serenedb
for _ in $(seq 1 30); do scripts/sql.sh -qAt -c "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
scripts/sql.sh -qAt -c "SELECT version()"

rows=$(scripts/sql.sh -qAt -c "SELECT count(*) FROM information_schema.tables WHERE table_name = 'bgl_logs'")
if [ "$rows" = "0" ]; then
  scripts/sql.sh -q -f db/schema.sql
  scripts/sql.sh -c "COPY bgl_logs FROM '/imports/bgl.parquet' (FORMAT parquet);"
  scripts/sql.sh -q -f db/index.sql
fi

count=$(scripts/sql.sh -qAt -c "SELECT count(*) FROM bgl_logs")
echo "bgl_logs rows: $count (expected $EXPECTED_ROWS)"
[ "$count" = "$EXPECTED_ROWS" ]
