import pg from "pg";
import type { LogRow } from "../../shared/contract.ts";

// Keep TIMESTAMP as the literal log-local string; a JS Date would shift it into the host timezone.
pg.types.setTypeParser(1114, (s: string) => s);
pg.types.setTypeParser(20, (s: string) => Number(s));

// SereneDB accepts statement_timeout but does not enforce it, so the budget is client-side.
export const DB_TIMEOUT_MS = Number(process.env.DB_TIMEOUT_MS ?? 8000);

export const pool = new pg.Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 7890),
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "serene",
  database: process.env.PGDATABASE ?? "postgres",
  max: 8,
  query_timeout: DB_TIMEOUT_MS,
});

export async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const started = performance.now();
  const result = await pool.query<T>(sql, params);
  return { rows: result.rows, ms: Math.round(performance.now() - started) };
}

export const LOG_COLUMNS =
  "line_id, event_time, node, midplane, component, level, label, is_alert, message, raw_line";

export interface DbLogRow {
  line_id: number;
  event_time: string;
  node: string;
  midplane: string | null;
  component: string;
  level: string;
  label: string;
  is_alert: boolean;
  message: string;
  raw_line: string;
}

export function toLogRow(r: DbLogRow): LogRow {
  return {
    lineId: r.line_id,
    time: r.event_time,
    node: r.node,
    midplane: r.midplane,
    component: r.component,
    level: r.level,
    label: r.label,
    isAlert: r.is_alert,
    message: r.message,
    rawLine: r.raw_line,
  };
}

export async function fetchRows(table: string, lineIds: number[]): Promise<LogRow[]> {
  if (lineIds.length === 0) return [];
  const ids = [...new Set(lineIds)].map(Number).filter(Number.isInteger);
  const { rows } = await query<DbLogRow>(
    `SELECT ${LOG_COLUMNS} FROM ${table} WHERE line_id IN (${ids.join(",")}) ORDER BY event_time, line_id`,
  );
  return rows.map(toLogRow);
}
