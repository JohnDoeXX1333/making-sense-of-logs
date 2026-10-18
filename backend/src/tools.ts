import { z } from "zod";
import { query, LOG_COLUMNS, type DbLogRow } from "./db.ts";
import type { Evidence } from "./evidence.ts";

// Accepts "2005-07-11", "2005-07-11 14:03", "2005-07-11T14:03:00Z" and returns "YYYY-MM-DD HH:MM:SS".
// Times are log-local wall time; a trailing Z or offset from the model is ignored on purpose.
const Time = z.string().transform((s, ctx) => {
  const m = s.trim().match(/^(\d{4}-\d\d-\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?$/);
  if (!m) {
    ctx.addIssue({ code: "custom", message: `bad time ${s}` });
    return z.NEVER;
  }
  return `${m[1]} ${m[2] ?? "00"}:${m[3] ?? "00"}:${m[4] ?? "00"}`;
});

const LEVELS = ["INFO", "WARNING", "ERROR", "SEVERE", "FATAL", "FAILURE"] as const;

const Filters = {
  from: Time.optional().describe("Start, log-local time, e.g. 2005-07-11 14:00:00"),
  to: Time.optional().describe("End, log-local time"),
  label: z.string().min(1).max(130).optional().describe("Alert label exactly as listed in the dataset description"),
  level: z.string().regex(/^[A-Z]{1,12}$/).optional().describe("Upper-case level, e.g. " + LEVELS.join(", ")),
  component: z.string().min(1).max(120).optional().describe("Component exactly as listed in the dataset description"),
  midplane: z.string().regex(/^R\d\d-M\d$/).optional().describe("e.g. R05-M0"),
  node: z.string().min(1).max(120).optional(),
  alertsOnly: z.boolean().optional().describe("Only lines with an alert label"),
};

export const SearchArgs = z.object({
  query: z.string().min(1).max(120).describe("Words to find in the log message"),
  phrase: z.boolean().optional().describe("true = words must appear in this order; false = any word, ranked"),
  ...Filters,
  limit: z.number().int().min(1).max(50).optional(),
});

export const ContextArgs = z.object({
  lineId: z.number().int().min(1).describe("Seed log line id from a previous result"),
  beforeSeconds: z.number().int().min(0).max(3600).optional(),
  afterSeconds: z.number().int().min(0).max(3600).optional(),
  sameNode: z.boolean().optional(),
  sameMidplane: z.boolean().optional(),
  alertsOnly: z.boolean().optional().describe("Default true"),
});

const GROUPS = ["label", "component", "level", "node", "midplane", "hour", "day", "week"] as const;
export const AggregateArgs = z.object({
  groupBy: z.enum(GROUPS),
  query: z.string().min(1).max(120).optional().describe("Optional words the message must contain"),
  ...Filters,
  limit: z.number().int().min(1).max(60).optional(),
});

type Params = unknown[];

function where(f: z.infer<typeof SearchArgs> | z.infer<typeof AggregateArgs>, params: Params): string[] {
  const c: string[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    c.push(sql.replace("?", `$${params.length}`));
  };
  if (f.from) add("event_time >= ?::TIMESTAMP", f.from);
  if (f.to) add("event_time < ?::TIMESTAMP", f.to);
  if (f.label) add("label = ?", f.label);
  if (f.level) add("level = ?", f.level);
  if (f.component) add("component = ?", f.component);
  if (f.midplane) add("midplane = ?", f.midplane);
  if (f.node) add("node = ?", f.node);
  if (f.alertsOnly) c.push("is_alert = true");
  return c;
}

function describeFilters(f: Record<string, unknown>): string {
  const parts = Object.entries(f)
    .filter(([k, v]) => v !== undefined && !["query", "phrase", "limit", "groupBy"].includes(k))
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

// Grouped queries read the base table and use the index only to select line ids: on 26.10.1 a GROUP BY
// directly over the inverted index overcounted one group by 2 rows in our tests.
let bm25Broken = process.env.SEARCH_MODE === "match";

export async function searchLogs(ev: Evidence, raw: unknown) {
  const a = SearchArgs.parse(raw);
  const params: Params = [a.query];
  const text = a.phrase ? "message @@ ts_phrase($1)" : "message @@ $1";
  const conds = [text, ...where(a, params)].join(" AND ");
  const limit = a.limit ?? 20;

  const ranked = `SELECT ${LOG_COLUMNS}, BM25(${ev.ds.index}.tableoid) AS score FROM ${ev.ds.index} WHERE ${conds} ORDER BY score DESC, event_time, line_id LIMIT ${limit}`;
  const plain = `SELECT ${LOG_COLUMNS} FROM ${ev.ds.index} WHERE ${conds} ORDER BY event_time, line_id LIMIT ${limit}`;
  let sql = bm25Broken ? plain : ranked;
  let rows: DbLogRow[];
  let ms: number;
  try {
    ({ rows, ms } = await query<DbLogRow>(sql, params));
  } catch (err) {
    if (sql !== ranked) throw err;
    // Relevance scoring failed: keep investigating with exact matching.
    bm25Broken = true;
    sql = plain;
    ({ rows, ms } = await query<DbLogRow>(sql, params));
  }
  if (bm25Broken) ev.searchMode = "match";

  const breakdownSql = `SELECT label, count(*) AS n, count(DISTINCT CASE WHEN node NOT IN ('NULL', '-') THEN node END) AS nodes, min(line_id) AS first_id, max(line_id) AS last_id, min(event_time) AS first_t, max(event_time) AS last_t, min(message) AS sample, sum(count(*)) OVER ()::BIGINT AS total FROM ${ev.ds.table} WHERE line_id IN (SELECT line_id FROM ${ev.ds.index} WHERE ${conds}) GROUP BY label ORDER BY n DESC LIMIT 8`;
  const breakdown = await query<{ label: string; n: number; nodes: number; first_id: number; last_id: number; first_t: string; last_t: string; sample: string; total: number }>(breakdownSql, params);

  const total = breakdown.rows[0]?.total ?? 0;
  const call = ev.addToolCall({ tool: "searchLogs", args: a, sql: `${sql};\n${breakdownSql}`, rowCount: rows.length, ms: ms + breakdown.ms });
  const how = a.phrase ? `the phrase "${a.query}"` : `any of the words "${a.query}"`;
  const facts = [
    ev.addFact(call.id, `Log lines containing ${how}${describeFilters(a)}`, total, rows.slice(0, 5).map((r) => r.line_id)),
  ];
  for (const b of breakdown.rows.slice(0, 5)) {
    const name = b.label === "-" ? "non-alert lines" : `${b.label} alerts`;
    facts.push(
      ev.addFact(call.id, `${name} among those matches: ${b.nodes} distinct named nodes, first ${b.first_t}, last ${b.last_t}; sample message "${b.sample}"`, b.n, [b.first_id, b.last_id]),
    );
  }
  return { facts, rows };
}

function addSeconds(t: string, seconds: number): string {
  const d = new Date(`${t.slice(0, 19).replace(" ", "T")}Z`);
  d.setUTCSeconds(d.getUTCSeconds() + seconds);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function getContext(ev: Evidence, raw: unknown) {
  const a = ContextArgs.parse(raw);
  const seed = await query<DbLogRow>(`SELECT ${LOG_COLUMNS} FROM ${ev.ds.table} WHERE line_id = $1`, [a.lineId]);
  const s = seed.rows[0];
  if (!s) throw new Error(`line ${a.lineId} not found`);
  const before = a.beforeSeconds ?? 60;
  const after = a.afterSeconds ?? 30;
  const from = addSeconds(s.event_time, -before);
  const to = addSeconds(s.event_time, after + 1);
  const params: Params = [from, to];
  const conds = ["event_time >= $1::TIMESTAMP", "event_time < $2::TIMESTAMP"];
  if (a.alertsOnly ?? true) conds.push("is_alert = true");
  if (a.sameNode) {
    params.push(s.node);
    conds.push(`node = $${params.length}`);
  }
  if (a.sameMidplane && s.midplane) {
    params.push(s.midplane);
    conds.push(`midplane = $${params.length}`);
  }
  const w = conds.join(" AND ");
  const groupSql = `SELECT label, level, count(*) AS n, count(DISTINCT CASE WHEN node NOT IN ('NULL', '-') THEN node END) AS nodes, count(DISTINCT midplane) AS midplanes, min(line_id) AS first_id, max(line_id) AS last_id, min(event_time) AS first_t, max(event_time) AS last_t, min(message) AS sample FROM ${ev.ds.table} WHERE ${w} GROUP BY label, level ORDER BY first_t LIMIT 12`;
  const rowsSql = `SELECT ${LOG_COLUMNS} FROM ${ev.ds.table} WHERE ${w} ORDER BY event_time, line_id LIMIT 40`;
  const bucket = before + after <= 300 ? "second" : "minute";
  const chartSql = `SELECT date_trunc('${bucket}', event_time) AS b, label, count(*) AS n FROM ${ev.ds.table} WHERE ${w} GROUP BY 1, 2 ORDER BY 1 LIMIT 400`;
  const [groups, rows, chart] = await Promise.all([
    query<{ label: string; level: string; n: number; nodes: number; midplanes: number; first_id: number; last_id: number; first_t: string; last_t: string; sample: string }>(groupSql, params),
    query<DbLogRow>(rowsSql, params),
    query<{ b: string; label: string; n: number }>(chartSql, params),
  ]);
  const call = ev.addToolCall({
    tool: "getContext",
    args: a,
    sql: [groupSql, rowsSql, chartSql].join(";\n"),
    rowCount: groups.rows.reduce((n, g) => n + g.n, 0),
    ms: seed.ms + Math.max(groups.ms, rows.ms, chart.ms),
  });
  const scope = `${a.sameNode ? ` on node ${s.node}` : ""}${a.sameMidplane ? ` on midplane ${s.midplane}` : ""}`;
  const facts = [
    ev.addFact(call.id, `Seed event at ${s.event_time} on ${s.node}: ${s.label} ${s.level} "${s.message}"`, s.label, [s.line_id]),
  ];
  for (const g of groups.rows) {
    const name = g.label === "-" ? `non-alert ${g.level} lines` : `${g.label} ${g.level} events`;
    facts.push(
      ev.addFact(call.id, `${name} from ${g.first_t} to ${g.last_t} (window ${before}s before to ${after}s after the seed${scope}) on ${g.nodes} named nodes, ${g.midplanes} midplanes; sample message "${g.sample}"`, g.n, [g.first_id, g.last_id]),
    );
  }
  const labels = [...new Set(chart.rows.map((r) => r.label))].slice(0, 5);
  const xs = [...new Set(chart.rows.map((r) => r.b))];
  if (xs.length > 1) {
    ev.addChart({
      title: `Events per ${bucket} around ${s.event_time}${scope}`,
      kind: "bar",
      x: xs.map((x) => x.slice(11, bucket === "second" ? 19 : 16)),
      series: labels.map((l) => ({ name: l, values: xs.map((x) => chart.rows.find((r) => r.b === x && r.label === l)?.n ?? 0) })),
    });
  }
  return { facts, rows: rows.rows };
}

const GROUP_SQL: Record<(typeof GROUPS)[number], string> = {
  label: "label",
  component: "component",
  level: "level",
  node: "node",
  midplane: "midplane",
  hour: "date_trunc('hour', event_time)",
  day: "date_trunc('day', event_time)",
  week: "date_trunc('week', event_time)",
};

export async function aggregate(ev: Evidence, raw: unknown) {
  const a = AggregateArgs.parse(raw);
  const params: Params = [];
  const conds: string[] = [];
  if (a.query) {
    params.push(a.query);
    conds.push(`line_id IN (SELECT line_id FROM ${ev.ds.index} WHERE message @@ $1)`);
  }
  conds.push(...where(a, params));
  const isTime = ["hour", "day", "week"].includes(a.groupBy);
  const g = GROUP_SQL[a.groupBy];
  const limit = a.limit ?? (isTime ? 60 : 12);
  const sql = `SELECT ${g} AS g, count(*) AS n, count(DISTINCT CASE WHEN node NOT IN ('NULL', '-') THEN node END) AS nodes, count(DISTINCT date_trunc('day', event_time)) AS days, sum(CASE WHEN level IN ('FATAL', 'FAILURE') THEN 1 ELSE 0 END)::BIGINT AS fatal, min(line_id) AS first_id, max(line_id) AS last_id, sum(count(*)) OVER ()::BIGINT AS total, count(*) OVER ()::BIGINT AS groups FROM ${ev.ds.table}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""} GROUP BY 1 ORDER BY ${isTime ? "1" : "n DESC"} LIMIT ${limit}`;
  const { rows, ms } = await query<{ g: string | null; n: number; nodes: number; days: number; fatal: number; first_id: number; last_id: number; total: number; groups: number }>(sql, params);
  const call = ev.addToolCall({ tool: "aggregate", args: a, sql, rowCount: rows.length, ms });
  const scope = `${a.query ? ` matching "${a.query}"` : ""}${describeFilters(a)}`;
  const total = rows[0]?.total ?? 0;
  const groups = rows[0]?.groups ?? 0;
  const shown = groups > rows.length ? `; ${groups} ${a.groupBy} groups, ${isTime ? "first" : "top"} ${rows.length} shown` : `; ${groups} ${a.groupBy} groups`;
  const facts = [ev.addFact(call.id, `Total log lines${scope}${shown}`, total, [])];
  const top = isTime ? [...rows].sort((x, y) => y.n - x.n).slice(0, 4) : rows.slice(0, 8);
  for (const r of top) {
    const key = isTime ? String(r.g).slice(0, a.groupBy === "hour" ? 13 : 10) : String(r.g ?? "unknown");
    facts.push(
      ev.addFact(call.id, `${a.groupBy} ${key}${scope}: ${r.nodes} distinct named nodes, ${r.days} active days, ${r.fatal} FATAL/FAILURE lines`, r.n, [r.first_id, r.last_id]),
    );
  }
  if (rows.length > 1) {
    ev.addChart({
      title: `Log lines${scope} by ${a.groupBy}`,
      kind: isTime ? "line" : "bar",
      x: rows.map((r) => (isTime ? String(r.g).slice(0, a.groupBy === "hour" ? 13 : 10) : String(r.g ?? "unknown"))),
      series: [{ name: "lines", values: rows.map((r) => r.n) }],
    });
  }
  return { facts, rows: rows.map((r) => ({ group: r.g, events: r.n, nodes: r.nodes, days: r.days, fatal: r.fatal })) };
}

export const TOOLS = { searchLogs, getContext, aggregate } as const;
export const TOOL_SCHEMAS = { searchLogs: SearchArgs, getContext: ContextArgs, aggregate: AggregateArgs } as const;
export const TOOL_DESCRIPTIONS = {
  searchLogs: "Full-text search over log messages with optional filters. Returns ranked matching lines and a per-label breakdown with counts.",
  getContext: "Timeline around one log line: all (alert) events in a time window before and after it, grouped by label, with sample lines and a per-second chart.",
  aggregate: "Counts log lines grouped by label, component, level, node, midplane, hour, day or week, with distinct nodes, active days and FATAL counts. Use for recurrence, concentration and trends.",
} as const;
