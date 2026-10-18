# Making Sense of Logs: one investigation, three perspectives

National AI Hackathon 2026, SereneDB challenge "Making Sense of Logs: The Right Insights for the Right People".

Ask one question about 4.7 million Blue Gene/L supercomputer log lines. SereneDB finds the evidence and computes the numbers; an AI agent explains the same evidence for an engineer (what failed and when), a team lead (what keeps coming back and where) and a manager (what to prioritise and what the logs cannot prove). Every claim links back to the exact log rows and the SQL that produced it.

## How it works

```
question
  -> planner LLM picks 2 to 6 typed, read-only tool calls (searchLogs, getContext, aggregate)
  -> SereneDB runs them on the full corpus (inverted index + BM25, SQL aggregation)
  -> server turns results into numbered facts (F1, F2, ...) with source line ids  = EvidenceBundle
  -> server computes a transparent manager priority score from database counts
  -> three role writers explain the SAME bundle; every finding must cite fact ids
  -> server drops findings without valid evidence and downgrades claims whose numbers are not in the cited facts
```

- The LLM never writes SQL and never invents facts. Tool arguments are validated (zod) and passed as SQL parameters.
- Switching roles changes the explanation, not the evidence.
- If BM25 scoring fails, search falls back to exact matching (`SEARCH_MODE=match` forces it); if the LLM fails, the evidence is still returned and the view shows the error.
- Manager priority: `score = 100 x (0.30 x events + 0.25 x nodes + 0.20 x activeDays + 0.15 x fatalShare + 0.10 x trend)`, each input scaled 0..1 against the largest alert category (events and nodes on a log scale). Trend compares the last quarter of the period with the quarter before.

## Stack

| Part | Choice |
|---|---|
| Database | SereneDB 26.10.1 (Docker, amd64) |
| Ingest | Python 3 + pyarrow: BGL.log to Parquet, then `COPY ... (FORMAT parquet)` |
| Backend | Node.js 26 (runs TypeScript directly), Fastify, node-postgres, zod |
| LLM | DeepSeek V4.1 Flash via Synthetic (OpenAI-compatible API), tool calling + strict JSON schema |
| Frontend | React + TypeScript (Vite) |

## Run it

Requirements: Linux x86-64 with AVX2, Docker, Node.js 26, Python 3 with pyarrow, `psql`, and a Synthetic API key.

```bash
scripts/setup.sh                       # download BGL (md5 checked), parse, start SereneDB, load, index
cd backend && npm install
SYNTHETIC_API_KEY=... npm start        # http://127.0.0.1:8787, warms the example questions
cd ../frontend && npm install && npm run dev
scripts/smoke.sh                       # end-to-end checks against the running backend
```

API: `GET /api/health`, `GET /api/examples`, `POST /api/investigate {"question": "..."}` (`?fresh=1` skips the answer cache). The contract is in `shared/contract.ts`.

## Data

- Loghub BGL, Zenodo record 8196385, `BGL.zip` md5 `4452953c470f2d95fcb32d5f6e733f7a`, 4,747,963 lines, 348,460 alert lines in 41 categories.
- Every line becomes one row; nothing is dropped. 4,713,169 lines parse cleanly, 34,470 have an empty message, 306 have no node, 18 are wrapped continuation lines (`parse_status` column). `raw_line` keeps the original text.
- Times are shown as printed in the log (US Pacific wall time). The epoch column is UTC.
- Derived columns (ours, not in BGL): `line_id` (line number), `is_alert` (label is not `-`), `midplane` (first two parts of the node name), `parse_status`.

## Measured (local, one machine)

AMD Ryzen 7 7745HX laptop, 16 threads, 32 GB RAM, SereneDB 26.10.1 in Docker, 2026-10-18:

| Step | Time |
|---|---|
| Parse BGL.log to Parquet | 69 s |
| COPY 4,747,963 rows | 3.4 s |
| `CREATE INDEX ... USING inverted` returned | 2.3 s |
| Demo SQL queries (phrase search, BM25 top-k, time windows, GROUP BY over all alerts) | 1 to 12 ms each, two runs |
| Database time per investigation | 45 to 136 ms |
| LLM time per investigation | about 28 s (planner about 9 s, role writing about 20 s) |

## What the logs cannot tell you

BGL has no ownership, customer, cost, downtime or SLA data. The agent says so instead of guessing, and marks anything beyond the facts as "inferred".

## Declaration

- Dataset: Loghub BGL (logpai/loghub, Zenodo 8196385), used as published.
- Pre-existing components: SereneDB, Fastify, node-postgres, zod, pyarrow, React, Vite and their licences.
- AI tools: DeepSeek V4.1 Flash (via Synthetic) is the runtime model. Claude (Anthropic) and ChatGPT were used as coding and research assistants during the event.
- All code in this repository was written during the event.
