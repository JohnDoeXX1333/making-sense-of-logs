import type { LinesResponse, Overview, OverviewChart } from "../../shared/contract.ts";
import type { Dataset } from "./datasets.ts";
import { LOG_COLUMNS, query, toLogRow, type DbLogRow } from "./db.ts";

export type Unit = "minute" | "hour" | "day";
export const UNIT_MS: Record<Unit, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
export interface Range {
  from: string; // "YYYY-MM-DD HH:MM:SS", inclusive
  to: string; // exclusive
}

export const toMs = (t: string) => Date.parse(`${t.slice(0, 19).replace(" ", "T")}Z`);
export const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

function unitFor(ds: Dataset): Unit {
  if (!ds.timeFrom || !ds.timeTo) return "day";
  const span = toMs(ds.timeTo) - toMs(ds.timeFrom);
  return span > 4 * UNIT_MS.day ? "day" : span > 6 * UNIT_MS.hour ? "hour" : "minute";
}

export const bucketLabel = (t: string, unit: Unit) => t.slice(0, unit === "day" ? 10 : 16);

// Range filter shared by every query that follows a selected period. Returns SQL and the next parameter number.
export function rangeSql(range: Range | null, params: unknown[]): string {
  if (!range) return "";
  params.push(range.from, range.to);
  return ` AND event_time >= $${params.length - 1}::TIMESTAMP AND event_time < $${params.length}::TIMESTAMP`;
}

export interface VolumeRow {
  b: string;
  n: number;
  alerts: number;
}

// Lines per bucket over the whole dataset; short files fall back to finer buckets so the chart has a shape.
export async function volumeSeries(ds: Dataset): Promise<{ unit: Unit; rows: VolumeRow[] }> {
  let unit = unitFor(ds);
  const sql = (u: Unit) =>
    `SELECT date_trunc('${u}', event_time) AS b, count(*) AS n, sum(CASE WHEN is_alert THEN 1 ELSE 0 END)::BIGINT AS alerts FROM ${ds.table} WHERE event_time IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 2000`;
  let rows = (await query<VolumeRow>(sql(unit))).rows;
  while (rows.length < 8 && unit !== "minute") {
    unit = unit === "day" ? "hour" : "minute";
    rows = (await query<VolumeRow>(sql(unit))).rows;
  }
  return { unit, rows };
}

async function top(ds: Dataset, column: string, limit: number, range: Range | null) {
  const params: unknown[] = [];
  const where = `WHERE true${rangeSql(range, params)}`;
  const { rows } = await query<{ v: string; n: number; alerts: number }>(
    `SELECT ${column} AS v, count(*) AS n, sum(CASE WHEN is_alert THEN 1 ELSE 0 END)::BIGINT AS alerts FROM ${ds.table} ${where} GROUP BY 1 ORDER BY n DESC LIMIT ${limit}`,
    params,
  );
  return rows;
}

// Dashboard for any dataset, computed by SereneDB only (no language model). The time chart always covers the
// whole dataset; the other charts and the pattern table follow the selected range.
export async function overview(ds: Dataset, range: Range | null = null): Promise<Overview> {
  const { unit, rows: volume } = await volumeSeries(ds);
  const tp: unknown[] = [];
  const tWhere = `WHERE true${rangeSql(range, tp)}`;
  const pp: unknown[] = [];
  const pWhere = `WHERE is_alert = true${rangeSql(range, pp)}`;
  const [levels, components, nodes, totals, patterns] = await Promise.all([
    top(ds, "level", 8, range),
    top(ds, "component", 10, range),
    top(ds, "node", 10, range),
    query<{ n: number; alerts: number }>(`SELECT count(*) AS n, sum(CASE WHEN is_alert THEN 1 ELSE 0 END)::BIGINT AS alerts FROM ${ds.table} ${tWhere}`, tp),
    query<{ label: string; events: number; nodes: number; first: string | null; last: string | null }>(
      `SELECT label, count(*) AS events, count(DISTINCT CASE WHEN node NOT IN ('NULL', '-') THEN node END) AS nodes, min(event_time) AS first, max(event_time) AS last FROM ${ds.table} ${pWhere} GROUP BY label ORDER BY events DESC LIMIT 10`,
      pp,
    ),
  ]);
  const charts: OverviewChart[] = [];
  if (volume.length > 1) {
    charts.push({
      id: "volume",
      field: "time",
      unit,
      title: `Log lines per ${unit}`,
      kind: "bar",
      x: volume.map((r) => bucketLabel(r.b, unit)),
      // Same series order and colours in every overview chart: other lines first, alert lines second.
      series: [
        { name: "other lines", values: volume.map((r) => r.n - r.alerts) },
        { name: "alert lines", values: volume.map((r) => r.alerts) },
      ],
    });
  }
  const bar = (id: string, field: OverviewChart["field"], title: string, rows: { v: string; n: number; alerts: number }[]) => {
    if (rows.length > 1) {
      charts.push({
        id, field, title, kind: "bar",
        x: rows.map((r) => r.v ?? "-"),
        series: [
          { name: "other lines", values: rows.map((r) => r.n - r.alerts) },
          { name: "alert lines", values: rows.map((r) => r.alerts) },
        ],
      });
    }
  };
  bar("levels", "level", "Log lines by level", levels);
  bar("components", "component", "Log lines by component", components);
  if (nodes.some((n, i) => n.v !== components[i]?.v)) bar("nodes", "node", "Log lines by node or host", nodes);
  return {
    datasetId: ds.id,
    rows: totals.rows[0]?.n ?? 0,
    alerts: totals.rows[0]?.alerts ?? 0,
    charts,
    patterns: patterns.rows,
  };
}

const FIELDS = new Set(["level", "component", "node", "label"]);

// Raw lines behind one bar, pattern or takeaway. field "time" selects one bucket; field "all" only uses the range.
export async function lines(ds: Dataset, field: string, value: string, unit?: string, alertsOnly = false, range: Range | null = null): Promise<LinesResponse> {
  const params: unknown[] = [];
  const conds: string[] = ["true"];
  if (field === "time") {
    const u = (unit && unit in UNIT_MS ? unit : "day") as Unit;
    const start = value.length === 10 ? `${value} 00:00:00` : `${value}:00`;
    params.push(start, fromMs(toMs(start) + UNIT_MS[u]));
    conds.push("event_time >= $1::TIMESTAMP", "event_time < $2::TIMESTAMP");
  } else if (FIELDS.has(field)) {
    params.push(value);
    conds.push(`${field} = $1`);
  } else if (field !== "all") {
    throw new Error(`cannot filter by ${field}`);
  }
  if (alertsOnly) conds.push("is_alert = true");
  const where = conds.join(" AND ") + rangeSql(range, params);
  const sql = `SELECT ${LOG_COLUMNS} FROM ${ds.table} WHERE ${where} ORDER BY event_time, line_id LIMIT 100`;
  const [rows, count] = await Promise.all([
    query<DbLogRow>(sql, params),
    query<{ n: number }>(`SELECT count(*) AS n FROM ${ds.table} WHERE ${where}`, params),
  ]);
  return { total: count.rows[0]?.n ?? 0, rows: rows.rows.map(toLogRow), sql };
}
