# Demo video script (3 minutes maximum, English)

Total target: 2:50, so there is 10 seconds of buffer. Narration is written for one speaker at a calm pace (about 140 words per minute). Every number below is what the app shows for the cached example answers on 2026-10-18; check them once more right before recording.

## Before recording

- Backend running (`cd backend && npm start`), frontend running (`cd frontend && npm run dev`), open http://localhost:5173.
- Browser at 1920x1080, zoom 110 to 125% so text is readable in the video. Close other tabs, hide bookmarks.
- All 4 example questions are cached, so they open instantly. Only scene 6 runs a new question live.
- Before scene 6, pick a question that is not cached, for example "Which nodes had the most KERNSERV alerts and when?" Test it once off camera, then use a different wording on camera so it runs fresh.
- Record with OBS or the system recorder. In the edit, speed up the waiting part of scene 6 and show a small "sped up" label.

## Scene 1: the problem (0:00 to 0:15)

Screen: the start page, no answer loaded yet.

Say: "Logs answer different questions for different people. An engineer needs to know what failed. A team lead needs to know what keeps coming back. A manager needs to know what to prioritise. We built one investigation that gives each of them their answer, from the same evidence."

## Scene 2: the data and the idea (0:15 to 0:30)

Screen: point at the header badge "SereneDB 26.10.1 · 4,747,963 log lines · BM25 ranking".

Say: "This is the full Blue Gene/L supercomputer log, 4.7 million lines, loaded into SereneDB with a full-text index. SereneDB finds and counts the evidence. The AI agent only chooses which read-only queries to run and explains the results. It never writes SQL and it cannot invent facts."

## Scene 3: engineer view (0:30 to 1:05)

Screen: click the Engineer example "What happened around the runtime panics at 14:03 on 2005-07-11?". The Engineer tab opens.

Say: "The engineer asks what happened around the runtime panics on July 11th. The answer: at 14:03:23, sixteen power-deactivation events hit midplane R05-M0. Ten seconds later, 148 nodes on three other midplanes stopped with 'rts panic'."

Screen: move the mouse over the findings, then the box "What the logs cannot tell us".

Say: "Each finding is marked observed or inferred. And the agent says clearly that the logs show the order of events, not the cause."

Screen: click an evidence chip (for example F5 or F6). The drawer opens with the log lines and the SQL.

Say: "Every finding links to the real log lines and the exact query that produced it."

Close the drawer with Escape.

## Scene 4: same evidence, three perspectives (1:05 to 1:40)

Screen: click the Team lead tab. Keep the evidence panel on the right in view.

Say: "Now the team lead. Same evidence on the right, nothing changes there. But the explanation focuses on concentration: 80 nodes on R01-M0, 34 on R05-M1, 34 on R04-M0, and runtime panics as a category that recurs over 124 days."

Screen: point at the team lead finding about "148 panics in 6 seconds" that is marked Inferred.

Say: "Here the model wrote 'six seconds'. That number is not in any fact, so our server automatically marked the claim as inferred."

Screen: click the Manager tab, scroll to the priority table.

Say: "The manager gets plain language and a priority table. The score is a visible formula from database counts: events, nodes, active days, fatal share and trend. It is not an AI guess."

## Scene 5: honesty when the logs cannot answer (1:40 to 2:00)

Screen: click the example "Did the July 11 panics cause customer data loss, and how much did it cost?". Show the headline "Logs show panics, not data loss or cost".

Say: "If we ask about customer data loss and cost, the agent does not make something up. The logs have no customer or cost data, and it says so."

## Scene 6: a new question, live (2:00 to 2:30)

Screen: type the new question and press Investigate. Scroll so the role panel shows the live query list.

Say: "Here is a new question, live. You can see each SereneDB query as it finishes, in a few milliseconds each. After about ten seconds the evidence is ready, and the first view arrives a few seconds later, while the other two are still being written."

Edit: speed up the waiting, show "sped up".

## Scene 7: how it was built (2:30 to 2:50)

Screen: scroll to "How this answer was built". Point at the query list and the timing line.

Say: "This trace shows the whole path: the question, the queries the agent chose, the facts, and the three views. All the database work for one investigation takes about a tenth of a second. One sentence sums it up: SereneDB establishes the facts, the agent changes the perspective, and the evidence keeps every perspective honest."

End on this screen.

## Backup lines if something fails during recording

- The model provider is slow or down: the evidence still appears and the role panel shows the error. Say: "Even if the language model fails, the evidence from SereneDB is still there." Then use a cached example.
- The backend is not reachable: the header shows "Backend unreachable". Restart it with `npm start` and record the scene again.
