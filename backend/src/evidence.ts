import type { Chart, Fact, ToolCall } from "../../shared/contract.ts";
import type { Dataset } from "./datasets.ts";

// Collects everything the database returned for one investigation. Only the server adds facts.
export class Evidence {
  facts: Fact[] = [];
  toolCalls: ToolCall[] = [];
  charts: Chart[] = [];
  unknowns: string[] = [];
  searchMode: "bm25" | "match" = "bm25";

  readonly ds: Dataset;
  private onToolCall?: (call: ToolCall) => void;

  constructor(ds: Dataset, onToolCall?: (call: ToolCall) => void) {
    this.ds = ds;
    this.onToolCall = onToolCall;
  }

  addToolCall(call: Omit<ToolCall, "id">): ToolCall {
    const full = { id: `T${this.toolCalls.length + 1}`, ...call };
    this.toolCalls.push(full);
    this.onToolCall?.(full);
    return full;
  }

  addFact(toolCallId: string, statement: string, value: number | string | undefined, sourceLineIds: number[]): Fact {
    const fact: Fact = {
      id: `F${this.facts.length + 1}`,
      statement,
      ...(value === undefined ? {} : { value }),
      sourceLineIds: [...new Set(sourceLineIds.filter((id) => Number.isInteger(id)))].slice(0, 10),
      toolCallId,
    };
    this.facts.push(fact);
    return fact;
  }

  addChart(chart: Omit<Chart, "id">) {
    this.charts.push({ id: `C${this.charts.length + 1}`, ...chart });
  }

  lineIds(): number[] {
    return [...new Set(this.facts.flatMap((f) => f.sourceLineIds))].slice(0, 200);
  }
}
