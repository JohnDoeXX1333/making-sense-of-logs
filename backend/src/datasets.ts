import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { DatasetInfo, ExampleQuestion, FormatSpecDto } from "../../shared/contract.ts";
import { query } from "./db.ts";

// A dataset is one SereneDB table plus its inverted index. Uploaded tables use the same columns as bgl_logs,
// so every tool, fact and view works unchanged.
export interface Dataset extends DatasetInfo {
  table: string;
  index: string;
  summary: string; // context for the planner and role writers
  spec?: FormatSpecDto;
}

const REGISTRY_FILE = new URL("../cache/datasets.json", import.meta.url);
const registry = new Map<string, Dataset>();

export const BGL_EXAMPLES: ExampleQuestion[] = [
  { id: "incident", role: "engineer", question: "What happened around the runtime panics at 14:03 on 2005-07-11? Which nodes failed and what came right before?" },
  { id: "recurring", role: "team_lead", question: "Which alert categories keep coming back, where are they concentrated, and are they getting worse?" },
  { id: "priorities", role: "manager", question: "What should we prioritise based on these logs, and what can the logs not tell us?" },
  { id: "unknown", role: "manager", question: "Did the July 11 panics cause customer data loss, and how much did it cost?" },
];

export function getDataset(id: string | undefined): Dataset {
  const ds = registry.get(id ?? "bgl");
  if (!ds) throw new Error(`unknown dataset ${id}`);
  return ds;
}

export function listDatasets(): DatasetInfo[] {
  return [...registry.values()].map(toInfo);
}

export function toInfo(ds: Dataset): DatasetInfo {
  const { table: _t, index: _i, summary: _s, spec: _p, ...info } = ds;
  return info;
}

export function saveUpload(ds: Dataset) {
  registry.set(ds.id, ds);
  mkdirSync(new URL("../cache/", import.meta.url), { recursive: true });
  const uploads = [...registry.values()].filter((d) => d.kind === "upload");
  writeFileSync(REGISTRY_FILE, JSON.stringify(uploads, null, 1));
}

async function topValues(table: string, column: string, where = "", limit = 8) {
  const { rows } = await query<{ v: string; n: number }>(
    `SELECT ${column} AS v, count(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ""} GROUP BY 1 ORDER BY n DESC LIMIT ${limit}`,
  );
  return rows;
}

async function range(table: string) {
  const { rows } = await query<{ first_t: string | null; last_t: string | null; n: number }>(
    `SELECT min(event_time) AS first_t, max(event_time) AS last_t, count(*) AS n FROM ${table}`,
  );
  return rows[0]!;
}

// The day after the last event, so "to" filters include the whole last day.
function dayAfter(t: string | null): string | null {
  if (!t) return null;
  const d = new Date(`${t.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 10)} 00:00:00`;
}

export async function loadRegistry() {
  const r = await range("bgl_logs");
  const labels = await topValues("bgl_logs", "label", "is_alert = true", 25);
  registry.set("bgl", {
    id: "bgl",
    name: "Blue Gene/L supercomputer (Loghub BGL)",
    kind: "builtin",
    rows: r.n,
    timeFrom: r.first_t ? `${r.first_t.slice(0, 10)} 00:00:00` : null,
    timeTo: dayAfter(r.last_t),
    notes: [
      "Times are log time as printed (US Pacific).",
      "Alert labels come from the dataset (\"-\" means not an alert).",
      "midplane is derived from the node name, e.g. R05-M1.",
    ],
    examples: BGL_EXAMPLES,
    createdAt: "2026-10-18T00:00:00.000Z",
    table: "bgl_logs",
    index: "bgl_idx",
    summary: `Dataset: Blue Gene/L supercomputer RAS log (Loghub BGL), ${r.n} lines from ${r.first_t?.slice(0, 19)} to ${r.last_t?.slice(0, 19)} log-local time (US Pacific). Each line has a time, node (e.g. R05-M1-N6-C:J05-U01; midplane = first two parts, e.g. R05-M1), component (KERNEL, APP, MMCS, DISCOVERY, HARDWARE, MONITOR, LINKCARD, CMCS, BGLMASTER), level (INFO, WARNING, ERROR, SEVERE, FATAL, FAILURE), an alert label ("-" means not an alert) and a free-text message. Alert labels with line counts: ${labels.map((x) => `${x.v} ${x.n}`).join(", ")}.`,
  });
  if (existsSync(REGISTRY_FILE)) {
    for (const ds of JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Dataset[]) registry.set(ds.id, ds);
  }
}

// Planner and writer context for an uploaded table, built from the loaded data.
export async function uploadSummary(table: string, name: string, description: string, year?: number) {
  const r = await range(table);
  const [levels, components, nodes, patterns] = await Promise.all([
    topValues(table, "level"),
    topValues(table, "component"),
    topValues(table, "node"),
    topValues(table, "label", "is_alert = true", 15),
  ]);
  const list = (rows: { v: string; n: number }[]) => rows.map((x) => `${x.v} (${x.n})`).join(", ");
  return {
    range: r,
    summary: `Dataset: uploaded log file "${name}" (${description}), ${r.n} lines from ${r.first_t?.slice(0, 19) ?? "unknown"} to ${r.last_t?.slice(0, 19) ?? "unknown"}, times as written in the file${year ? `, year ${year} assumed because the timestamps have no year` : ""}. Columns: level (${list(levels)}); component (${list(components)}); node = host, or the component when there is no host (${list(nodes)}); midplane is not available in this dataset. is_alert = level WARNING or worse, or an error keyword when a line has no level. label = the message pattern of an alert line with numbers and ids replaced by <*>, "-" for other lines; use label values exactly as listed. Most frequent alert labels: ${patterns.map((p) => `"${p.v}" (${p.n})`).join("; ") || "none"}.`,
    timeFrom: r.first_t ? `${r.first_t.slice(0, 10)} 00:00:00` : null,
    timeTo: dayAfter(r.last_t),
  };
}
