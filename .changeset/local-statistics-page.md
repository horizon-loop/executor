---
"executor": minor
"@executor-js/execution": minor
---

Add a Statistics page to the local web UI with a Dashboard tab (context tokens without vs. with Executor over time, tokens saved vs. consumed, activity, success rate, latency, executions by agent, tool calls by integration, execution outcomes, error codes) and a Data tab (agents, integrations, top tools, error codes, recent calls). Recorded only on this machine in `<data dir>/stats.db` (paths, outcomes, error codes, timings, and character-count token estimates; never arguments, results, or code). The execution engine gains an `onToolCall` observer for hosts that record tool usage.
