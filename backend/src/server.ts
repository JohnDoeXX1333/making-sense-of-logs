import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Fastify from "fastify";
import { z } from "zod";
import type { Health, InvestigateEvent, InvestigateResponse, Role } from "../../shared/contract.ts";
import { investigate, type Emit } from "./agent.ts";
import { BGL_EXAMPLES, type Dataset, getDataset, listDatasets, loadRegistry } from "./datasets.ts";
import { query } from "./db.ts";
import { lines, overview } from "./overview.ts";
import { detect, ingest, MAX_UPLOAD_BYTES } from "./upload.ts";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

app.get("/api/health", async (): Promise<Health> => {
  const [v, n] = await Promise.all([
    query<{ v: string }>("SELECT version() AS v"),
    query<{ n: number }>("SELECT count(*) AS n FROM bgl_logs"),
  ]);
  return {
    ok: true,
    serenedbVersion: v.rows[0]?.v.match(/SereneDB [\d.]+/)?.[0] ?? v.rows[0]?.v ?? "unknown",
    rows: n.rows[0]?.n ?? 0,
    searchMode: process.env.SEARCH_MODE === "match" ? "match" : "bm25",
  };
});

app.get("/api/examples", async () => BGL_EXAMPLES);

// ---- datasets ----

app.get("/api/datasets", async () => listDatasets());

function dataset(id: string | undefined, reply: { code: (n: number) => unknown }): Dataset | null {
  try {
    return getDataset(id);
  } catch {
    reply.code(404);
    return null;
  }
}

app.post<{ Querystring: { name?: string }; Body: string }>(
  "/api/datasets/detect",
  { bodyLimit: MAX_UPLOAD_BYTES },
  async (req, reply) => {
    if (typeof req.body !== "string" || req.body.length === 0) return reply.code(400).send({ error: "send the log file as text/plain" });
    const name = (req.query.name ?? "uploaded.log").replace(/[^\w .()-]/g, "_").slice(0, 120);
    try {
      return await detect(req.body, name);
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  },
);

const IngestBody = z.object({
  name: z.string().max(120).optional(),
  spec: z.object({
    pattern: z.string().min(1).max(2000),
    timeFormat: z.enum(["iso", "yymmdd_hhmmss", "yy_slash", "syslog", "apache", "clf", "epoch", "none"]),
    year: z.number().int().min(1970).max(2100).optional(),
  }),
});

app.post<{ Params: { id: string } }>("/api/datasets/:id/ingest", async (req, reply) => {
  const parsed = IngestBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
  try {
    return await ingest(req.params.id, parsed.data.spec, parsed.data.name);
  } catch (err) {
    return reply.code(422).send({ error: (err as Error).message });
  }
});

app.get<{ Params: { id: string } }>("/api/datasets/:id/overview", async (req, reply) => {
  const ds = dataset(req.params.id, reply);
  return ds ? overview(ds) : { error: "unknown dataset" };
});

app.get<{ Params: { id: string }; Querystring: { field?: string; value?: string; unit?: string; alerts?: string } }>(
  "/api/datasets/:id/lines",
  async (req, reply) => {
    const ds = dataset(req.params.id, reply);
    if (!ds) return { error: "unknown dataset" };
    if (!req.query.field || req.query.value === undefined) return reply.code(400).send({ error: "field and value are required" });
    try {
      return await lines(ds, req.query.field, req.query.value, req.query.unit, req.query.alerts === "1");
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  },
);

// ---- investigations ----

const Body = z.object({ question: z.string().trim().min(3).max(500), dataset: z.string().max(20).optional() });

// Answers are cached per dataset and question so demo questions respond instantly; ?fresh=1 recomputes.
const CACHE_FILE = new URL("../cache/answers.json", import.meta.url);
const cache = new Map<string, InvestigateResponse>(
  existsSync(CACHE_FILE) ? Object.entries(JSON.parse(readFileSync(CACHE_FILE, "utf8"))) : [],
);
const cacheKey = (ds: Dataset, q: string) => `${ds.id === "bgl" ? "" : `${ds.id}|`}${q.toLowerCase().replace(/\s+/g, " ").trim()}`;
const ROLE_IDS: Role[] = ["engineer", "team_lead", "manager"];

async function answer(ds: Dataset, question: string, fresh: boolean, emit: Emit = () => {}, firstRole: Role = "engineer"): Promise<InvestigateResponse> {
  const key = cacheKey(ds, question);
  const hit = cache.get(key);
  if (hit && !fresh) {
    for (const call of hit.bundle.toolCalls) emit({ type: "tool", call });
    emit({ type: "bundle", bundle: hit.bundle });
    for (const role of [firstRole, ...ROLE_IDS.filter((r) => r !== firstRole)]) emit({ type: "view", role, view: hit.views[role] });
    return hit;
  }
  const result = await investigate(ds, question, emit, firstRole);
  const failed = Object.values(result.views).some((v) => "error" in v);
  if (!failed) {
    cache.set(key, { ...result, cachedAt: new Date().toISOString() });
    mkdirSync(new URL("../cache/", import.meta.url), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache), null, 1));
  }
  return result;
}

app.post<{ Querystring: { fresh?: string } }>("/api/investigate", async (req, reply) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
  const ds = dataset(parsed.data.dataset, reply);
  if (!ds) return { error: "unknown dataset" };
  return answer(ds, parsed.data.question, req.query.fresh === "1");
});

// Same investigation as /api/investigate, streamed as newline-delimited JSON events.
app.post<{ Querystring: { fresh?: string; first?: string } }>("/api/investigate/stream", async (req, reply) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
  const ds = dataset(parsed.data.dataset, reply);
  if (!ds) return { error: "unknown dataset" };
  const first = ROLE_IDS.find((r) => r === req.query.first) ?? "engineer";
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  const send = (event: InvestigateEvent) => {
    if (!reply.raw.writableEnded) reply.raw.write(`${JSON.stringify(event)}\n`);
  };
  try {
    const response = await answer(ds, parsed.data.question, req.query.fresh === "1", send, first);
    send({ type: "done", response });
  } catch (err) {
    send({ type: "error", error: (err as Error).message });
  }
  reply.raw.end();
});

await loadRegistry();
await app.listen({ port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? "127.0.0.1" });

// Warm the example questions one at a time (the LLM provider serializes requests per key).
if (process.env.WARM_EXAMPLES !== "0") {
  const bgl = getDataset("bgl");
  for (const ex of BGL_EXAMPLES) {
    if (cache.has(cacheKey(bgl, ex.question))) continue;
    try {
      await answer(bgl, ex.question, false);
      app.log.info({ example: ex.id }, "warmed example");
    } catch (err) {
      app.log.warn({ example: ex.id, err: (err as Error).message }, "warming failed");
    }
  }
}
