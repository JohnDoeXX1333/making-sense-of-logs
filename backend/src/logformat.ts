// Format helpers for uploaded logs: timestamp parsing, level normalisation, alert flag and message patterns.
// Pure functions, shared by the parse worker and the format check.

export const TIME_FORMATS = ["iso", "yymmdd_hhmmss", "yy_slash", "syslog", "apache", "clf", "epoch", "none"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

export const FIELDS = ["time", "level", "component", "host", "message"] as const;

export interface FormatSpec {
  pattern: string; // JavaScript regex with named groups from FIELDS; "message" is required
  timeFormat: TimeFormat;
  year?: number; // for formats without a year (syslog)
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const p2 = (n: number) => String(n).padStart(2, "0");

function build(y: number, mo: number, d: number, h: number, mi: number, s: number, frac = ""): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = mo === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(mo) ? 30 : 31;
  if (d > daysInMonth) return null;
  const f = frac ? `.${frac.slice(0, 6).padEnd(6, "0")}` : "";
  return `${String(y).padStart(4, "0")}-${p2(mo)}-${p2(d)} ${p2(h)}:${p2(mi)}:${p2(s)}${f}`;
}

// Returns "YYYY-MM-DD HH:MM:SS[.ffffff]" as written in the log (no timezone conversion), or null.
export function parseTime(text: string | undefined, format: TimeFormat, year = 2000): string | null {
  if (!text) return null;
  const t = text.trim().replace(/^\[|\]$/g, "");
  let m: RegExpMatchArray | null;
  switch (format) {
    case "iso":
      m = t.match(/^(\d{4})[-/](\d\d)[-/](\d\d)[T ](\d\d):(\d\d):(\d\d)(?:[.,](\d{1,9}))?/);
      return m ? build(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!, m[7]) : null;
    case "yymmdd_hhmmss":
      m = t.match(/^(\d\d)(\d\d)(\d\d)[ -]?(\d\d)(\d\d)(\d\d)/);
      return m ? build(2000 + +m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
    case "yy_slash":
      m = t.match(/^(\d\d)\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)(?:[.,](\d{1,9}))?/);
      return m ? build(2000 + +m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!, m[7]) : null;
    case "syslog":
      m = t.match(/^([A-Za-z]{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d)/);
      return m && MONTHS[m[1]!.toLowerCase()] ? build(year, MONTHS[m[1]!.toLowerCase()]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!) : null;
    case "apache":
      m = t.match(/^[A-Za-z]{3} ([A-Za-z]{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d)(?:\.(\d+))? (\d{4})/);
      return m && MONTHS[m[1]!.toLowerCase()] ? build(+m[7]!, MONTHS[m[1]!.toLowerCase()]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, m[6]) : null;
    case "clf":
      m = t.match(/^(\d\d)\/([A-Za-z]{3})\/(\d{4}):(\d\d):(\d\d):(\d\d)/);
      return m && MONTHS[m[2]!.toLowerCase()] ? build(+m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!, +m[4]!, +m[5]!, +m[6]!) : null;
    case "epoch": {
      m = t.match(/^(\d{10})(\d{3})?(?:\.(\d+))?$/);
      if (!m) return null;
      const d = new Date(+m[1]! * 1000);
      return build(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), m[2] ?? m[3]);
    }
    case "none":
      return null;
  }
}

const LEVEL_ALIASES: Record<string, string> = {
  WARN: "WARNING", ERR: "ERROR", CRIT: "CRITICAL", EMERG: "EMERGENCY", INF: "INFO", DBG: "DEBUG", TRC: "TRACE",
  E: "ERROR", W: "WARNING", I: "INFO", D: "DEBUG", F: "FATAL",
};
// WARNING counts: in application logs it is usually the first sign of a problem.
const ALERT_LEVELS = new Set(["WARNING", "ERROR", "FATAL", "CRITICAL", "SEVERE", "FAILURE", "ALERT", "EMERGENCY", "PANIC"]);
const ALERT_WORDS = /\b(error|errors|fail|failed|failure|exception|fatal|panic|denied|refused|timed? ?out|unreachable|break-in)\b/i;

export function normaliseLevel(raw: string | undefined): string | null {
  if (!raw) return null;
  const up = raw.trim().replace(/^\[|\]$/g, "").toUpperCase();
  if (!/^[A-Z]{1,12}$/.test(up)) return null;
  return LEVEL_ALIASES[up] ?? up;
}

// Alert flag for uploaded logs: WARNING or worse, or (when the line has no level) an error keyword.
export function isAlert(level: string | null, message: string): boolean {
  if (level) return ALERT_LEVELS.has(level);
  return ALERT_WORDS.test(message);
}

// Message pattern: tokens that contain a digit (ids, numbers, IPs, hex) become <*>, so repeats group together.
export function messagePattern(message: string): string {
  const masked = message
    .replace(/[^\s=:,;()[\]{}<>"']*\d[^\s=:,;()[\]{}<>"']*/g, "<*>")
    .replace(/(?:<\*>[\s.:,/-]*){2,}/g, "<*> ")
    .replace(/\s+/g, " ")
    .trim();
  return masked.length > 120 ? `${masked.slice(0, 117)}...` : masked || "<empty>";
}

export function compileSpec(spec: FormatSpec): RegExp {
  const re = new RegExp(spec.pattern);
  const groups = [...spec.pattern.matchAll(/\(\?<([a-zA-Z_]+)>/g)].map((m) => m[1]!);
  const unknown = groups.filter((g) => !(FIELDS as readonly string[]).includes(g));
  if (unknown.length) throw new Error(`unknown named groups: ${unknown.join(", ")}`);
  if (!groups.includes("message")) throw new Error("the pattern needs a (?<message>...) group");
  return re;
}

export interface ParsedLine {
  time: string | null;
  level: string | null;
  component: string | null;
  host: string | null;
  message: string;
  matched: boolean;
}

export const MAX_LINE = 4000;

export function parseLine(re: RegExp, spec: FormatSpec, line: string): ParsedLine {
  const m = re.exec(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line);
  if (!m?.groups) return { time: null, level: null, component: null, host: null, message: line, matched: false };
  const g = m.groups;
  return {
    time: parseTime(g.time, spec.timeFormat, spec.year),
    level: normaliseLevel(g.level),
    component: g.component?.trim() || null,
    host: g.host?.trim() || null,
    message: (g.message ?? "").trim(),
    matched: true,
  };
}
