#!/usr/bin/env bash
# End-to-end smoke test against a running backend. Exits non-zero on the first failed check.
set -euo pipefail
API="${API:-http://127.0.0.1:8787}"
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; exit 1; }

health=$(curl -sf "$API/api/health")
python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["rows"]==4747963, d; assert d["serenedbVersion"].startswith("SereneDB 26.10.1"), d' "$health" \
  && pass "health: 4,747,963 rows on SereneDB 26.10.1" || fail "health $health"

ask() { curl -sf -X POST "$API/api/investigate$2" -H 'Content-Type: application/json' -d "{\"question\": \"$1\"}"; }

# Known incident: facts must contain the 148 KERNRTSP panics and every finding must cite existing facts.
r=$(ask "What happened around the runtime panics at 14:03 on 2005-07-11? Which nodes failed and what came right before?" "")
python3 -I -c '
import json,sys
d=json.loads(sys.argv[1]); b=d["bundle"]; ids={f["id"] for f in b["facts"]}
assert any(f.get("value")==148 for f in b["facts"]), "no fact with 148 panics"
logged={l["lineId"] for l in b["logs"]}
for f in b["facts"]:
    assert set(f["sourceLineIds"]) <= logged, ("fact cites rows missing from bundle.logs", f["id"])
for role,v in d["views"].items():
    assert "error" not in v, (role, v)
    assert v["findings"], role
    for f in v["findings"]:
        assert f["evidenceIds"] and set(f["evidenceIds"]) <= ids, (role, f)
assert d["views"]["manager"]["priorities"], "manager priorities missing"
' "$r" && pass "incident: 148 panics found, all findings cite real facts, all fact rows present" || fail "incident"

# Same question twice: facts must be identical (cached or not).
r2=$(ask "What happened around the runtime panics at 14:03 on 2005-07-11? Which nodes failed and what came right before?" "")
python3 -I -c '
import json,sys
a=json.loads(sys.argv[1])["bundle"]["facts"]; b=json.loads(sys.argv[2])["bundle"]["facts"]
assert [(f["statement"],f.get("value")) for f in a]==[(f["statement"],f.get("value")) for f in b]
' "$r" "$r2" && pass "repeat: identical facts" || fail "repeat"

# Question the logs cannot answer: no view may claim cost or customer impact as observed.
r=$(ask "Did the July 11 panics cause customer data loss, and how much did it cost?" "")
python3 -I -c '
import json,sys,re
d=json.loads(sys.argv[1])
for role,v in d["views"].items():
    assert "error" not in v, (role, v)
    assert v["unknowns"], f"{role}: no unknowns"
    for f in v["findings"]:
        if re.search(r"\b(cost|customer|revenue|data loss)\b", f["claim"], re.I) and f["status"]=="observed" and not re.search(r"\b(not|no|none|zero|cannot|does not)\b", f["claim"], re.I):
            raise AssertionError((role, f))
' "$r" && pass "unanswerable: unknowns present, no observed cost or customer claim" || fail "unanswerable"

# Stream: events arrive as tool* -> bundle -> 3 views (selected role first) -> done, with the same facts as the JSON endpoint.
s=$(curl -sf -X POST "$API/api/investigate/stream?first=manager" -H 'Content-Type: application/json' -d '{"question": "What happened around the runtime panics at 14:03 on 2005-07-11? Which nodes failed and what came right before?"}')
python3 -I -c '
import json,sys
ev=[json.loads(l) for l in sys.argv[1].splitlines() if l.strip()]
types=[e["type"] for e in ev]
b=types.index("bundle")
assert all(t=="tool" for t in types[:b]) and b>0, types
assert types[b+1:]==["view","view","view","done"], types
assert ev[b+1]["role"]=="manager", ev[b+1]["role"]
facts=[(f["statement"],f.get("value")) for f in ev[-1]["response"]["bundle"]["facts"]]
ref=[(f["statement"],f.get("value")) for f in json.loads(sys.argv[2])["bundle"]["facts"]]
assert facts==ref
' "$s" "$r2" && pass "stream: tool events, bundle, manager view first, done with identical facts" || fail "stream"

# Bad input is rejected.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/investigate" -H 'Content-Type: application/json' -d '{"question": ""}')
[ "$code" = "400" ] && pass "empty question rejected with 400" || fail "empty question returned $code"
