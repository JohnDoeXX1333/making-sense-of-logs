import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Fastify from "fastify";
import { z } from "zod";
import type { ExampleQuestion, Health, InvestigateResponse } from "../../shared/contract.ts";
import { investigate, loadDatasetSummary } from "./agent.ts";
import { query } from "./db.ts";

const EXAMPLES: ExampleQuestion[] = [
  { id: "incident", role: "engineer", question: "What happened around the runtime panics at 14:03 on 2005-07-11? Which nodes failed and what came right before?" },
  { id: "recurring", role: "team_lead", question: "Which alert categories keep coming back, where are they concentrated, and are they getting worse?" },
  { id: "priorities", role: "manager", question: "What should we prioritise based on these logs, and what can the logs not tell us?" },
  { id: "unknown", role: "manager", question: "Did the July 11 panics cause customer data loss, and how much did it cost?" },
];

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

app.get("/api/examples", async () => EXAMPLES);

const Body = z.object({ question: z.string().trim().min(3).max(500) });

// Answers are cached per question so the demo questions respond instantly; ?fresh=1 recomputes.
const CACHE_FILE = new URL("../cache/answers.json", import.meta.url);
const cache = new Map<string, InvestigateResponse>(
  existsSync(CACHE_FILE) ? Object.entries(JSON.parse(readFileSync(CACHE_FILE, "utf8"))) : [],
);
const cacheKey = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();

async function answer(question: string, fresh: boolean): Promise<InvestigateResponse> {
  const key = cacheKey(question);
  const hit = cache.get(key);
  if (hit && !fresh) return hit;
  const result = await investigate(question);
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
  return answer(parsed.data.question, req.query.fresh === "1");
});

await loadDatasetSummary();
await app.listen({ port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? "127.0.0.1" });

// Warm the example questions one at a time (the LLM provider serializes requests per key).
if (process.env.WARM_EXAMPLES !== "0") {
  for (const ex of EXAMPLES) {
    if (cache.has(cacheKey(ex.question))) continue;
    try {
      await answer(ex.question, false);
      app.log.info({ example: ex.id }, "warmed example");
    } catch (err) {
      app.log.warn({ example: ex.id, err: (err as Error).message }, "warming failed");
    }
  }
}
