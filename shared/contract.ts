// API contract between backend/ and frontend/. Change only by agreement.
//
// POST /api/investigate  body: InvestigateRequest  -> InvestigateResponse
// GET  /api/health                                 -> Health
// GET  /api/examples                               -> ExampleQuestion[]

export type Role = "engineer" | "team_lead" | "manager";

export interface InvestigateRequest {
  question: string;
  dataset?: string; // DatasetInfo.id, default "bgl"
}

// One raw log record from SereneDB. lineId is the line number in BGL.log.
export interface LogRow {
  lineId: number;
  time: string; // log-local wall time as printed in BGL (US Pacific), "2005-07-11 14:03:33.123456"
  node: string;
  midplane: string | null; // e.g. "R05-M0", derived from node
  component: string;
  level: string; // INFO | WARNING | ERROR | SEVERE | FATAL | FAILURE
  label: string; // "-" for non-alert, else alert category like KERNRTSP
  isAlert: boolean;
  message: string;
  rawLine: string;
}

// A number or statement computed by the server from a tool result. The LLM never creates facts.
export interface Fact {
  id: string; // "F1", "F2", ...
  statement: string;
  value?: number | string;
  sourceLineIds: number[]; // sample rows backing the fact (may be a subset for large counts)
  toolCallId: string;
}

export interface Chart {
  id: string;
  title: string;
  kind: "bar" | "line";
  x: string[]; // category labels or time buckets
  series: { name: string; values: number[] }[];
}

// One executed database query, shown in the "proof" panel.
export interface ToolCall {
  id: string; // "T1", ...
  tool: "searchLogs" | "getContext" | "aggregate";
  args: Record<string, unknown>;
  sql: string;
  rowCount: number;
  ms: number;
  error?: string;
}

export interface EvidenceBundle {
  queryId: string;
  question: string;
  facts: Fact[];
  logs: LogRow[]; // every row referenced by any fact
  charts: Chart[];
  toolCalls: ToolCall[];
  unknowns: string[];
  searchMode: "bm25" | "match"; // "match" = relevance scoring unavailable, exact matching used
}

export interface Finding {
  claim: string;
  evidenceIds: string[]; // Fact ids, e.g. ["F1", "F3"]; always non-empty
  status: "observed" | "inferred";
  confidence: "high" | "medium" | "low";
}

// Manager priority is computed by the server with a visible formula, not by the LLM.
export interface PriorityItem {
  label: string; // alert category
  score: number; // 0..100
  inputs: {
    events: number;
    nodes: number;
    activeDays: number;
    trendPct: number | null; // last window vs previous window
    fatalShare: number; // 0..1
  };
  factIds: string[];
}

export interface RoleView {
  role: Role;
  headline: string;
  summary: string;
  findings: Finding[];
  unknowns: string[];
  recommendedActions: string[];
  priorities?: PriorityItem[]; // manager only
}

export interface InvestigateResponse {
  bundle: EvidenceBundle;
  views: Record<Role, RoleView | { role: Role; error: string }>;
  timings: { dbMs: number; llmMs: number; totalMs: number };
  cachedAt?: string; // ISO time when this answer was computed, present only when served from cache
}

// POST /api/investigate/stream?first=<role>  body: InvestigateRequest
// Response: application/x-ndjson, one InvestigateEvent per line, in this order:
// tool* -> bundle -> view x3 (selected role requested first) -> done. "error" can replace the rest.
export type InvestigateEvent =
  | { type: "tool"; call: ToolCall }
  | { type: "bundle"; bundle: EvidenceBundle }
  | { type: "view"; role: Role; view: RoleView | { role: Role; error: string } }
  | { type: "done"; response: InvestigateResponse }
  | { type: "error"; error: string };

// ---- Datasets: the built-in BGL log plus logs uploaded by the user ----
// GET  /api/datasets                       -> DatasetInfo[]
// POST /api/datasets/detect  body: text/plain log file, ?name=  -> DetectResponse (stores the file, proposes a format)
// POST /api/datasets/:uploadId/ingest  body: { spec, name }  -> DatasetInfo
// GET  /api/datasets/:id/overview          -> Overview
// GET  /api/datasets/:id/lines?field=&value=&from=&to=  -> LinesResponse
// Investigate endpoints accept { question, dataset } (dataset defaults to "bgl").

export interface DatasetInfo {
  id: string;
  name: string;
  kind: "builtin" | "upload";
  rows: number;
  timeFrom: string | null;
  timeTo: string | null;
  notes: string[]; // how derived fields were computed, shown in the UI
  examples: ExampleQuestion[];
  createdAt: string;
}

export interface FormatSpecDto {
  pattern: string;
  timeFormat: "iso" | "yymmdd_hhmmss" | "yy_slash" | "syslog" | "apache" | "clf" | "epoch" | "none";
  year?: number;
}

export interface PreviewLine {
  line: number;
  time: string | null;
  level: string | null;
  component: string | null;
  host: string | null;
  message: string;
  matched: boolean;
}

export interface DetectResponse {
  uploadId: string;
  name: string;
  lines: number;
  bytes: number;
  spec: FormatSpecDto;
  description: string; // the model's description of the format
  matchRate: number; // 0..1 on the checked sample
  timeRate: number; // 0..1
  preview: PreviewLine[];
  unmatchedExamples: string[];
  attempts: number;
  fallback: boolean; // true when no pattern was good enough and the whole line is used as the message
}

export interface OverviewChart extends Chart {
  field: "time" | "level" | "component" | "node" | "label";
  unit?: "minute" | "hour" | "day";
}

export interface Overview {
  datasetId: string;
  rows: number;
  alerts: number;
  charts: OverviewChart[];
  patterns: { label: string; events: number; nodes: number; first: string | null; last: string | null }[];
}

export interface LinesResponse {
  total: number;
  rows: LogRow[];
  sql: string;
}

export interface Health {
  ok: boolean;
  serenedbVersion: string;
  rows: number;
  searchMode: "bm25" | "match";
}

export interface ExampleQuestion {
  id: string;
  role: Role; // role the question is written for; all three views are still returned
  question: string;
}
