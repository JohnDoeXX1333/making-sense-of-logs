# Frontend brief (for the second Claude session)

Start that session in `/home/coder/shubki/frontend` and paste this file as the first prompt.

## Goal
A single-page React + TypeScript (Vite) app for "Making Sense of Logs". The user asks one question about the BGL supercomputer logs, the backend investigates with SereneDB, and the page shows the same evidence through three roles: Engineer, Team Lead, Manager. The 3-minute demo video is recorded on this page, so it must be clear and calm at 1080p.

## Ownership
- You own `frontend/` only. Do not edit `backend/`, `shared/`, `ingest/`, `db/` or `data/`.
- The API contract is `shared/contract.ts`. Import its types (Vite alias or relative path). If you need a contract change, ask in chat; do not edit it.
- The backend is live on http://localhost:8787 (started from this machine). The 4 example questions answer instantly from cache; a new question takes about 25 to 30 s. `shared/fixtures/investigate-sample.json` is only for offline work; its chart values are placeholders.
- When a response has `cachedAt`, show a small note "cached answer from <time>".

## API (backend on http://localhost:8787; use a Vite proxy for /api)
- `POST /api/investigate` with `{ "question": string }` returns `InvestigateResponse` in 5 to 20 s. Show progress while waiting.
- `GET /api/health` returns `Health`: show rows (4,747,963), SereneDB version and search mode in a small header badge.
- `GET /api/examples` returns `ExampleQuestion[]`: show them as clickable chips under the question box.

## Screens and behaviour
1. Header: project name, health badge. If `searchMode` is "match", show "relevance scoring unavailable, exact matching in use".
2. Question box with example chips.
3. Role switch: three tabs (Engineer, Team Lead, Manager). All three views arrive in one response, so switching is instant and makes no request. The evidence panel must not change when the role changes; that is the point of the demo.
4. Role view: headline, summary, findings list. Each finding shows status (observed or inferred), confidence, and evidence chips (F1, F2). A view with `error` shows the message and keeps the evidence visible.
5. Manager view: priority table from `priorities` with its inputs (events, nodes, active days, trend, fatal share), so the score is transparent.
6. Evidence drawer: clicking a fact chip opens the fact statement, value, the source log rows (time, node, label, level, message, with the raw line expandable) and the tool call that produced it (tool name, args, SQL, row count, ms).
7. Unknowns: always shown in their own box ("What the logs cannot tell us").
8. One chart from `bundle.charts` (bar or line). Recharts is fine.
9. Footer: timings (DB ms vs LLM ms).

## Constraints
- Times are log-local wall time; label them "log time (US Pacific)". Do not convert time zones.
- No login, no routing, no global state library. Keep dependencies small: react, vite, recharts.
- Every number on screen must come from the response. Do not hard-code values.

## Done when
`npm run dev` shows the fixture in all three roles, the evidence drawer opens from every chip, and `npm run build` passes. Report with a screenshot description and the build output.
