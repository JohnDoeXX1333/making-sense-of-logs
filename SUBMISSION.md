# Submission form content

Deadline: Sunday 2026-10-18, 23:59 Europe/Berlin. If the form does not work, email the frozen package to team@schubki.com before the deadline.

Fields marked FILL IN are only known to the team.

## Team name
FILL IN

## Roster
FILL IN (2 people: names and emails as registered)

## Challenge
Making Sense of Logs: The Right Insights for the Right People (SereneDB)

## Project title
One Investigation, Three Perspectives

## Short description

**Problem.** The same logs must answer different questions for different people. An engineer needs to know what failed and when, a team lead needs to know what keeps coming back and where, and a manager needs to know what to prioritise. A generic chatbot over logs gives everyone the same answer and often invents causes or business impact that the logs do not contain.

**Approach.** We load the full Loghub BGL supercomputer log (4,747,963 lines, every line kept) into SereneDB 26.10.1 with an inverted index and BM25 ranking. For each question, an AI agent (DeepSeek V4.1 Flash) chooses two to six typed, read-only tools: full-text search, a timeline around one event, and grouped counts. The server validates the arguments and runs parameterised SQL; the agent never writes SQL. Results become numbered facts with their source log lines and the exact SQL. Three role writers then explain the same facts for an engineer, a team lead and a manager. The server drops any finding that does not cite a fact and marks a claim as "inferred" when its numbers are not in the cited facts. The manager's priority score is a visible formula from database counts (events, nodes, active days, fatal share, trend), not an AI guess. The web app streams the queries live, shows the evidence first and each role view as it arrives, and opens the real log lines and SQL behind every claim. Users can also upload their own log file: the model proposes a parsing pattern from 40 lines, the server tests it on 2,000 lines in an isolated worker before loading, and every line goes into its own SereneDB table and index. An SQL-only dashboard with click-through to raw lines opens at once, and the same three-role investigation works on the new data.

**Results.** On the full corpus, search, timeline and aggregation queries take 1 to 12 ms, and all database work for one investigation took 45 to 136 ms in our runs (one laptop). For the 2005-07-11 incident the agent finds that 16 power-deactivation events on midplane R05-M0 were followed ten seconds later by 148 "rts panic" events on three other midplanes, and it says that the logs show the order of events, not the cause. When asked about customer data loss or cost, it answers that the logs cannot tell. On six public Loghub samples in different formats (HDFS, Linux syslog, Apache, OpenSSH, Zookeeper, Spark), one detection run each matched 100% of lines and parsed 100% of timestamps in 4 to 9 seconds, and loading 2,000 lines took 6 to 7 seconds. An end-to-end smoke test passes on our machine, and its first version passed on a clean copy from download to answer. While building, we found that a GROUP BY directly over the inverted index overcounted one group by 2 rows on 26.10.1; we documented a reproduction in the README and group on the base table instead.

**Limitations.** A new question takes about 30 seconds, almost all of it language model time (in our test the evidence appeared after 9 to 12 seconds and the first role view after about 17). Two fresh runs of the same question can choose different queries, so we cache answers for repeatable demos. BGL contains no ownership, customer, cost or downtime data, so those are always reported as unknown. The priority weights are our own choice. For uploaded logs, "alert" is our rule (WARNING or worse, or an error keyword), and syslog files need the user to supply the year. Uploaded samples and facts are sent to the language model provider, which the upload screen states. Measurements come from one machine, and the SereneDB 26.10.1 image is amd64 only.

## Repository
https://github.com/JohnDoeXX1333/making-sense-of-logs (private). Give the jury access before submitting: add the jury's GitHub accounts as collaborators, or upload a zip of the submitted commit if the form allows it. Submitted commit: FILL IN (run `git rev-parse HEAD` after the final push).

## Demo video
https://github.com/JohnDoeXX1333/making-sense-of-logs/releases/tag/demo-2026-10-18 (demo_elevenlabs.mp4, 2:46; the repo is private, so the jury needs access, or upload the same file to an unlisted YouTube or Drive link)

## Declaration of pre-existing components, datasets, AI tools and licences

- Dataset: Loghub BGL (logpai/loghub, Zenodo record 8196385, BGL.zip md5 4452953c470f2d95fcb32d5f6e733f7a), used as published. For testing the upload feature we used the public Loghub 2k samples of HDFS, Linux, Apache, OpenSSH, Zookeeper and Spark from the same repository. Please check the dataset licence on the Loghub page before submitting.
- Database: SereneDB 26.10.1 (official Docker image serenedb/serenedb:26.10.1).
- Libraries: Fastify, node-postgres (pg), zod, TypeScript (backend); React, Vite (frontend); pyarrow (ingest). Each is used under its own open-source licence.
- AI at runtime: DeepSeek V4.1 Flash through the Synthetic API (OpenAI-compatible). It receives only the user's question, BGL-derived facts and sample BGL log lines, which are public data. No partner data is sent.
- AI assistants during development: Claude (Anthropic) wrote and tested most of the code with us; ChatGPT was used for the initial research report and for checking documentation.
- Demo video: recorded from the running app with Playwright; voice-over generated with ElevenLabs text to speech (voice Eric, model eleven_v4).
- All project code was written during the event, on 2026-10-18.
