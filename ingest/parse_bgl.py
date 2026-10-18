"""Parse the raw Loghub BGL log into Parquet for SereneDB.

Usage: python3 -I ingest/parse_bgl.py data/raw/BGL.log data/parquet/bgl.parquet

Every input line becomes exactly one row. Lines that do not fit the documented
10-field layout keep their raw text and get a parse_status other than 'ok'.
"""
import re
import sys
from datetime import datetime

import pyarrow as pa
import pyarrow.parquet as pq

TIME_RE = re.compile(r"^\d{4}-\d\d-\d\d-\d\d\.\d\d\.\d\d\.\d{6}$")
# Wrapped or node-less lines: find "<type> <component> <level>" after the time.
TAIL_RE = re.compile(r"(?:^|\s)(RAS|NULL) (\S+) (\S+)(?: (.*))?$")
MIDPLANE_RE = re.compile(r"^(R\d\d-M\d)")

SCHEMA = pa.schema([
    ("line_id", pa.int64()),
    ("label", pa.string()),
    ("is_alert", pa.bool_()),
    ("epoch_s", pa.int64()),
    ("event_time", pa.timestamp("us")),  # log-local wall time (US Pacific), as printed in the log
    ("node", pa.string()),
    ("midplane", pa.string()),
    ("event_type", pa.string()),
    ("component", pa.string()),
    ("level", pa.string()),
    ("message", pa.string()),
    ("raw_line", pa.string()),
    ("parse_status", pa.string()),
])


def parse_time(text):
    return datetime.strptime(text, "%Y-%m-%d-%H.%M.%S.%f")


def parse_line(line_id, line):
    label, epoch, _date, node, rest = line.split(" ", 4)
    time_text, _, after = rest.partition(" ")
    if not TIME_RE.match(time_text):
        raise ValueError(f"line {line_id}: bad time field {time_text!r}")
    status = "ok"
    parts = after.split(" ", 4)
    if node != "-" and len(parts) >= 4 and parts[0] == node:
        _repeat, event_type, component, level = parts[:4]
        message = parts[4] if len(parts) == 5 else ""
        if len(parts) == 4:
            status = "empty_message"
    else:
        m = TAIL_RE.search(after)
        if not m:
            raise ValueError(f"line {line_id}: no type/component/level in {after[:80]!r}")
        event_type, component, level, message = m.group(1), m.group(2), m.group(3), m.group(4) or ""
        prefix = after[: m.start()].strip()
        status = "wrapped" if prefix else "no_node_repeat"
    mp = MIDPLANE_RE.match(node)
    return {
        "line_id": line_id,
        "label": label,
        "is_alert": label != "-",
        "epoch_s": int(epoch),
        "event_time": parse_time(time_text),
        "node": node,
        "midplane": mp.group(1) if mp else None,
        "event_type": event_type,
        "component": component,
        "level": level,
        "message": message,
        "raw_line": line,
        "parse_status": status,
    }


def main(src, dst, batch_size=250_000):
    writer = pq.ParquetWriter(dst, SCHEMA, compression="zstd")
    batch = {name: [] for name in SCHEMA.names}
    total = 0
    statuses = {}

    def flush():
        writer.write_table(pa.table(batch, schema=SCHEMA))
        for col in batch.values():
            col.clear()

    with open(src, "rb") as f:
        for line_id, raw in enumerate(f, 1):
            line = raw.decode("utf-8", errors="strict").rstrip("\n")
            row = parse_line(line_id, line)
            for k, v in row.items():
                batch[k].append(v)
            statuses[row["parse_status"]] = statuses.get(row["parse_status"], 0) + 1
            total += 1
            if len(batch["line_id"]) >= batch_size:
                flush()
    if batch["line_id"]:
        flush()
    writer.close()
    print(f"rows={total} statuses={statuses}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
