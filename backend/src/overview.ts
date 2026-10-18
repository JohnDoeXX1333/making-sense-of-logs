import type { LinesResponse, Overview, OverviewChart } from "../../shared/contract.ts";
import type { Dataset } from "./datasets.ts";
import { LOG_COLUMNS, query, toLogRow, type DbLogRow } from "./db.ts";

type Unit = "minute" | "hour" | "day";
const UNIT_MS: Record<Unit, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

function unitFor(ds: Dataset): Unit {
  if (!ds.timeFrom || !ds.timeTo) return "day";
  const span = Date.parse(`${ds.timeTo.replace(" ", "T")}Z`) - Date.parse(`${ds.timeFrom.replace(" ", "T")}Z`);
  return span > 4 * UNIT_MS.day ? "day" : span > 6 * UNIT_MS.hour ? "hour" : "minute";
}

const label = (t: string, unit: Unit) => t.slice(0, unit === "day" ? 10 : 16);

async function top(ds: Dataset, column: string, limit: number) {
  const { rows } = await query<{ v: string; n: number; alerts: number }>(
    `SELECT ${column} AS v, count(*) AS n, sum(CASE WHEN is_alert THEN 1 ELSE 0 END)::BIGINT AS alerts FROM ${ds.table} GROUP BY 1 ORDER BY n DESC LIMIT ${limit}`,
  );
  return rows;
}

// Dashboard for any dataset, computed by SereneDB only (no language model).
export async function overview(ds: Dataset): Promise<Overview> {
  let unit = unitFor(ds);
  const volumeSql = (u: Unit) =>
    `SELECT date_trunc('${u}', event_time) AS b, count(*) AS n, sum(CASE WHEN is_alert THEN 1 ELSE 0 END)::BIGINT AS alerts FROM ${ds.table} WHERE event_time IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 2000`;
  let volume = (await query<{ b: string; n: number; alerts: number }>(volumeSql(unit))).rows;
  // Short files: fall back to finer buckets so the chart has a shape.
  while (volume.length < 8 && unit !== "minute") {
    unit = unit === "day" ? "hour" : "minute";
    volume = (await query<{ b: string; n: number; alerts: number }>(volumeSql(unit))).rows;
  }
  const [levels, components, nodes, totals, patterns] = await Promise.all([
    top(ds, "level", 8),
    top(ds, "component", 10),
    top(ds, "node", 10),
    query<{ n: number; alerts: number }>(`SELECT count(*) AS n, sum(CASE WHEN is_alert THEN 1 ELSE 0 END)::BIGINT AS alerts FROM ${ds.table}`),
    query<{ label: string; events: number; nodes: number; first: string | null; last: string | null }>(
      `SELECT label, count(*) AS events, count(DISTINCT CASE WHEN node NOT IN ('NULL', '-') THEN node END) AS nodes, min(event_time) AS first, max(event_time) AS last FROM ${ds.table} WHERE is_alert = true GROUP BY label ORDER BY events DESC LIMIT 10`,
    ),
  ]);
  const charts: OverviewChart[] = [];
  if (volume.length > 1) {
    charts.push({
      id: "volume",
      field: "time",
      unit,
      title: `Lines per ${unit}`,
      kind: "bar",
      x: volume.map((r) => label(r.b, unit)),
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
  bar("levels", "level", "Lines by level", levels);
  bar("components", "component", "Top components", components);
  if (nodes.some((n, i) => n.v !== components[i]?.v)) bar("nodes", "node", "Top nodes or hosts", nodes);
  return {
    datasetId: ds.id,
    rows: totals.rows[0]?.n ?? 0,
    alerts: totals.rows[0]?.alerts ?? 0,
    charts,
    patterns: patterns.rows,
  };
}

const FIELDS = new Set(["level", "component", "node", "label"]);

// Raw lines behind one bar or pattern of the dashboard.
export async function lines(ds: Dataset, field: string, value: string, unit?: string, alertsOnly = false): Promise<LinesResponse> {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (field === "time") {
    const u = (unit && unit in UNIT_MS ? unit : "day") as Unit;
    const start = value.length === 10 ? `${value} 00:00:00` : `${value}:00`;
    const end = new Date(Date.parse(`${start.replace(" ", "T")}Z`) + UNIT_MS[u]).toISOString().slice(0, 19).replace("T", " ");
    params.push(start, end);
    conds.push("event_time >= $1::TIMESTAMP", "event_time < $2::TIMESTAMP");
  } else if (FIELDS.has(field)) {
    params.push(value);
    conds.push(`${field} = $1`);
  } else {
    throw new Error(`cannot filter by ${field}`);
  }
  if (alertsOnly) conds.push("is_alert = true");
  const where = conds.join(" AND ");
  const sql = `SELECT ${LOG_COLUMNS} FROM ${ds.table} WHERE ${where} ORDER BY event_time, line_id LIMIT 100`;
  const [rows, count] = await Promise.all([
    query<DbLogRow>(sql, params),
    query<{ n: number }>(`SELECT count(*) AS n FROM ${ds.table} WHERE ${where}`, params),
  ]);
  return { total: count.rows[0]?.n ?? 0, rows: rows.rows.map(toLogRow), sql };
}
