# Visualisation ideas for non-experts (COS research, 2026-10-18)

Four ChatGPT research workers (observability products, automatic insights, SQL methods, interaction patterns). Duplicates merged; ranked by value for a manager and for the demo. Effort estimates are the workers' guesses plus mine; none of the SQL has been run on SereneDB yet.

| # | Idea | What the user sees | Effort | Workers |
|---|---|---|---|---|
| 1 | Key takeaways box | 3 rule-based sentences from SQL, e.g. "Alerts peaked on 2005-06-11: 152,183 alert lines, 99.9% from node R30-M0-N9-C:J16-U01." No LLM numbers. | 1 h | 7, 9 |
| 2 | KPI tiles with comparison | Lines, alert lines, alert share, each against the previous period of equal length ("+216% vs previous period"). | 0.5 to 1 h | 7, 8 |
| 3 | Peak and spike markers on the time chart | One annotated peak, plus dots on buckets far above their rolling baseline (mean of previous 24 buckets + 3 standard deviations). | 1 h | 7, 8, 6 (Elastic change points) |
| 4 | What changed? (selected period vs baseline) | Pick a period; top movers by pattern and by node, "+N lines vs the previous period", "new" when the baseline was 0. Click to raw lines. Honeycomb BubbleUp and Elastic log rate analysis do this. | 1.5 h | 6, 7, 8 |
| 5 | Brush a time range to filter everything | Drag across the time chart; dashboard, patterns and lines all follow; Reset button; date inputs for keyboard users. | 1.5 to 2 h | 9 |
| 6 | Node by time heatmap / incident swimlane | Rows = top nodes, columns = time buckets, shade = alert count. Shows blast radius and timing at a glance. | 1.5 h | 8, 9 |
| 7 | New patterns | "First seen on ..." pills for patterns whose first occurrence is in the selected period. | 0.5 to 1 h | 8 |
| 8 | Guided story mode + shareable link | 4 steps: what happened, when, where, proof; URL keeps the filters. | 1 h | 9 |
| 9 | Plain-language labels | "Alert-labelled log lines per day", units and time zone on every chart, one takeaway line under each chart. | 0.5 h | 7 |

Lower priority (higher cost or weaker demo): patterns that occur together (self-join, needs tight limits), "what usually happens before X" (window LAG per node), sparklines in the top-lists.

## Guardrails all workers raised

- Numbers in sentences come from SQL, never from the model; templates with thresholds, deterministic tie-breaks.
- Compare only equal, complete periods; no percentage when the baseline is 0 (say "new" or "previous period had none").
- Words: "alert-labelled lines", not "incidents"; "associated with", never "caused".
- In BGL, 507,103 non-alert lines have level FATAL, so alert share must use the label, not the level.
- Sentence, chart and lines must share the same filters and buckets.

## Sources (from the workers)

- Honeycomb BubbleUp: https://docs.honeycomb.io/investigate/analyze/identify-outliers
- Elastic log rate analysis: https://www.elastic.co/blog/elastic-stack-aiops-labs-8-12-ga-of-log-rate-analysis
- Elastic change point detection: https://www.elastic.co/docs/explore-analyze/discover/detect-change-points
- Grafana Logs Drilldown patterns: https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/patterns/
- New Relic log patterns: https://docs.newrelic.com/docs/logs/ui-data/find-unusual-logs-log-patterns/
- Tableau Data Stories (rule-based narratives, retired Jan 2025): https://help.tableau.com/current/server/en-us/data_stories.htm
- Power BI Smart Narrative: https://learn.microsoft.com/power-bi/visuals/power-bi-visualization-smart-narrative
- Amazon QuickSight autonarratives: https://docs.aws.amazon.com/quick/latest/userguide/narratives-creating.html
- Datawrapper annotation guidance: https://www.datawrapper.de/academy/how-to-create-text-annotations
- Grafana state timeline (swimlane): https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/state-timeline/
