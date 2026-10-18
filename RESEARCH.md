# Making Sense of Logs: verified facts (2026-10-18)

## Submission (schubki.com rules, section 5)
- Deadline 2026-10-18 23:59 Europe/Berlin (API: submissionDeadline 2026-10-18T21:59:00Z).
- Submit via the official form: team name, roster, challenge, project title; short English description (problem, approach, results, limitations); repo link or archive with the submitted commit and jury access (private repo is fine); README with install and run instructions; English demo or walkthrough video of at most 3 minutes; declaration of pre-existing components, datasets, AI tools and licences.
- If the form is down, email the frozen package to team@schubki.com before the deadline.
- AI assistants are allowed but must be declared. Do not send partner data or keys to external AI services without approval (BGL is public Loghub data).
- No public rubric or weights. Jury includes Pavel Ivanov (SereneDB). The jury may rerun the code.
- Official challenge text: "Use SereneDB to find relevant evidence and calculate reliable summaries, then let an AI agent explain the results and recommend next steps ... one clear workflow that works from question to evidence to recommendation."
- 10-second query limit: not found in any public source.

## Dataset (checked locally)
- Zenodo record 8196385, BGL.zip, md5 4452953c470f2d95fcb32d5f6e733f7a. BGL.log is 743,185,031 bytes, 4,747,963 lines, in data/raw/.
- Valid UTF-8 throughout, no CRLF.
- 4,713,493 lines have 10 space-separated fields; 34,470 have 9 (empty message). 306 have node "-" and no node-repeat field. 8 are wrapped continuation lines. 104,215 have node "NULL".
- Epoch field is UTC. Precise-time field is America/Los_Angeles wall time (UTC-7 in summer, UTC-8 in winter).
- 348,460 alert lines across 41 labels. Top: KERNDTLB 152,734, KERNSTOR 63,491, APPSEV 49,651, KERNMNTF 31,531, KERNTERM 23,338, KERNREC 6,145, APPREAD 5,983, KERNRTSP 3,983.
- Levels: INFO, FATAL, ERROR, WARNING, SEVERE, FAILURE. Components: KERNEL, APP, DISCOVERY, MMCS, HARDWARE, MONITOR, LINKCARD, CMCS, BGLMASTER.
- Engineer demo seed (local time 2005-07-11): at 14:03:23, 16 KERNPOW "Power deactivated" on midplane R05-M0; from 14:03:33 to 14:03:39, 148 KERNRTSP "rts panic! - stopping execution" on R01-M0 (80), R05-M1 (34) and R04-M0 (34). The logs show timing, not causation.

## SereneDB 26.10.1 (docs, via COS research; not yet run locally)
- Image serenedb/serenedb:26.10.1 (amd64 only, pulled; 26.09.1.3 has arm64). Port 7890, volume /var/lib/serenedb, user and db postgres.
- `docker run -d --name serenedb -p 7890:7890 -e POSTGRES_PASSWORD=... -v serenedb-data:/var/lib/serenedb -v $PWD/data:/imports:ro serenedb/serenedb:26.10.1`
- Load: `COPY bgl_logs FROM '/imports/bgl.parquet' (FORMAT parquet);` or `INSERT INTO t SELECT * FROM read_parquet(...)`.
- Dictionary: `CREATE TEXT SEARCH DICTIONARY log_text AS split_by_non_alpha(case := 'lower') WITH (frequency, position);` Check with `SELECT ts_lexize('log_text', 'rts panic!');`
- Index: `CREATE INDEX bgl_idx ON bgl_logs USING inverted (line_id, message log_text, node, component, level, label, event_time) INCLUDE (raw_line);` then `VACUUM (REFRESH_TABLE) bgl_logs;`
- Text queries select FROM the index name: `SELECT line_id, BM25(bgl_idx.tableoid) AS score FROM bgl_idx WHERE message @@ ts_phrase('rts panic') AND node = 'x' AND event_time BETWEEN ... ORDER BY score DESC, line_id;`
- GROUP BY, COUNT and date_trunc run on the base table without the index.
- node-postgres works with $1 placeholders. statement_timeout support is unverified.
- The PDF's `(template='text', ...)` dictionary syntax is the old form; do not use it.

## LLM: DeepSeek V4.1 Flash on Synthetic
- OpenAI-compatible: POST https://api.synthetic.new/openai/v1/chat/completions, model `hf:deepseek-ai/DeepSeek-V4.1-Flash`, key in $SYNTHETIC_API_KEY.
- Tool calling: 2 of 2 runs correct, 3.7 to 4.6 s. It makes parallel calls and sends timestamps both with and without Z, so normalize them on the server.
- Strict json_schema: 1 of 2 runs valid. The other hit max_tokens=600 because reasoning used 377 tokens. Use max_tokens of 2000 or more and treat finish_reason=length as an error.
- Quota: $23.99 of $24 left this week.
