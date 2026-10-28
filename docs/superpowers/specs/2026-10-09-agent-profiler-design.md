# Agent Profiler — Design Spec

- Date: 2026-10-09 (rev.2 — switched from the settings-hook approach to a Claude Code **mod** (function hook) approach)
- Status: Draft (awaiting review)
- Target: Claude Code ≥ 2.1.287 (verified on 2.1.292). The mods API is early access, so re-check `.claude-plugin/types/` on every release.

## 1. Purpose

A mod that breaks down "why a Claude Code session takes so long" by time category and shows it in real time.

| Question | Metric that answers it |
|---|---|
| Is the model response slow? | Per-request `model.request` time, TTFT, thinking/output stream time, tokens/second |
| Are Bash commands slow? | Top N run time per command, totals per category (test/build/install/git/…) |
| Is the same file read repeatedly? | Read count per path, count of "re-reads with no intervening edit" |
| Is a subagent the bottleneck? | Wall time and internal breakdown per agent, whether it blocked the parent |
| Do tests use up all the time? | Total of `test` category Bash and its ratio to agent time |

Reconstruct the Agent → Tool → Filesystem → Subagent relationships as a span tree, and export it as OpenTelemetry (OTLP/JSON)
so it can be viewed in Jaeger / Grafana Tempo.

### Non-goals
- Breaking down time inside the model server (queueing/prefill/decoding/GPU). It cannot be observed in principle.
- Cost calculation, a web UI of its own (the OTLP backend takes that role).
- Restoring session data beyond a hot reload. On reload, in-memory state is reset and only the disk snapshot remains.

## 2. Core principle: observability grades

Every span and metric is labeled with its source in `agent_profiler.observability`. The phrase "inference time" is not used.

| Grade | Meaning | Example |
|---|---|---|
| `measured` | Value measured directly by the engine and handed over | `classic.PostToolUse.duration_ms` (tool execution time) |
| `observed` | Interval the mod measured inside the process using event-boundary timestamps | `turn.step` send→first chunk→end, `tool.call` entry→return |
| `reported` | Value reported by the API | `usage.output_tokens`, cache read/creation tokens |
| `inferred` | Residual interval computed from the values above | tool wait = wall − exec, engine overhead = turn − (request ∪ tool) |

### Time categories (one context = main loop or subagent loop)

```
turn (turn.start → turn.complete)                                    observed
├─ model.request (turn.step: next call → stream end)                 observed
│   ├─ ttft            : send → first chunk     (network+queueing+prefill, not separable)
│   ├─ thinking.stream : first thinking chunk → last thinking chunk
│   └─ output.stream   : first text/tool chunk → end
│   + usage (tokens)                                                  reported
├─ tool (tool.call: entry → next return)                              observed
│   ├─ exec    = duration_ms                                          measured
│   └─ wait    = wall − exec                                          inferred
│        if the tool.check decision is 'ask', approval wait (user or auto-mode classifier); otherwise tool.overhead
├─ subagent (classic.SubagentStart → classic.SubagentStop)            observed
│   └─ (recursive) model.request / tool
└─ engine.overhead = turn − (model.request ∪ tool ∪ blocking subagent)     inferred
     (client-side processing between request and tool: context assembly, hooks, compaction, etc.)
idle: turn.complete → next turn.start (excluded from agent time)
```

TTFT and stream time are also not "time the model spent computing" but response wait time observed at the client.
This point is stated explicitly in the report and in span attributes. Engine retries are absorbed within a single `turn.step`, so they show up as a longer TTFT for that request.

## 3. Events used (confirmed with the 2.1.292 type declarations and probes)

| Event | Use | Main fields |
|---|---|---|
| `session.start` | Register commands, obtain session ID (`$.session.id()`) | `surface`, `isInteractive` |
| `turn.start` / `turn.complete` | Turn boundaries | `turnId`, `reason`, `usage` |
| `turn.step` (async generator) | Model request span, first/last timestamps per chunk kind | `turnId`, `index`, `model`, `effort`, `agentId?`, chunk `kind`, `usage` of the stop chunk |
| `tool.call` | Tool span (wall time including the permission prompt) | `tool`, `tool_use_id`, `agentId?`, tool arguments, result `isError`·`text` |
| `tool.check` | Records the permission decision (reads only the decision via `next(e)`) | `tool_use_id`, `decision` |
| `classic.PostToolUse` / `classic.PostToolUseFailure` | Engine-measured execution time | `tool_use_id`, `duration_ms` |
| `classic.SubagentStart` / `classic.SubagentStop` | Subagent lifetime | `agent_id`, `agent_type` |
| `session.end` | Final snapshot and export | `reason` |

The Agent tool may be asynchronous (`status: async_launched`). In that case the tool span ends in a few ms, and the subagent span
continues after the parent turn has ended. The tool span and the subagent span are linked by the `agentId` in the Agent tool result. If they cannot be linked,
fall back to the Agent tool span that was open in the same loop at the time of SubagentStart.

## 4. Architecture

```
Claude Code engine (in-process)
  │ turn.* / tool.* / classic.*
  ▼
hooks/register.tsx ── adapter: event → Profiler method call (timestamps from Date.now())
  │                    UI: Pane, status line / commands: /profile, /profile-pane, /profile-export
  ▼
hooks/core/  (pure TypeScript, no $ → unit-testable)
  profiler.ts  state machine: events → span records
  analyze.ts   category totals, parallelism, Bash categories, repeated reads, subagents, findings
  classify.ts  classifyCommand(cmd) → test|build|install|git|search|other
  report.ts    Markdown report (command output), short status-line string, Pane rows
  otlp.ts      span → OTLP/JSON ExportTraceServiceRequest
  ids.ts       deterministic IDs (FNV-1a 64bit)
```

### 4.1 Profiler (state machine)
- All input methods take an explicit timestamp `t` (ms). This is so that time can be injected in tests.
  `turnStart`, `turnComplete`, `stepStart`, `stepChunk(kind)`, `stepEnd(usage)`, `toolStart`, `toolCheck`,
  `toolEnd`, `toolDuration`, `subagentStart`, `subagentStop`.
- Context key: `agentId ?? 'main'`. Turns are identified by `turnId`, requests by `turnId#index`, tools by `tool_use_id`.
- The order of `classic.PostToolUse` and the `tool.call` return is not guaranteed, so they are merged by `tool_use_id`.
- Memory cap: 20,000 request+tool spans. When exceeded, finished spans are discarded oldest first down to 90%, and the number discarded is shown in the report.
- Spans that have not ended (interrupt, reload) are marked `status=incomplete` and computed truncated at the `now` of the report time.

### 4.2 Analyzer
- Category totals: model.request (ttft/thinking/output), tool.exec, tool.overhead, permission.wait, engine.overhead, subagent wall.
- Parallelism: union of tool intervals relative to the sum of tool times.
- Bash: totals per category and top N commands via `classifyCommand` (commands are truncated to 80 characters).
- Repeated reads: Read count per path. Reading the same path with the same range (offset/limit) again without a Write/Edit/MultiEdit/NotebookEdit in between is `redundant`.
  Reading a large file in separate ranges is not counted as repetition.
  Files modified through Bash are not visible (stated in the report).
- Subagents: wall, request and tool time per agent, and whether it was `blocking` (synchronous Agent call).
- Findings: threshold rules. For example: tests ≥ 25%, re-reading the same file 3 or more times without modification, model wait ≥ 70%,
  permission wait ≥ 20%, a blocking subagent taking 50% or more of the turn.

### 4.3 UI and commands
- `/profile [all|turn]`: returns the Markdown report as command output. It is the only output also visible in the VS Code chat panel and in `-p`.
- `/profile-pane`: opens a live Pane in the terminal/desktop (in-progress requests and tools, category bars, recent findings).
- Status line `$.ui.status`: in the form `⏱ model 61% · tools 28% · ▶ Bash npm test 14s`. Redraws are limited to at most 2 per second.
- `/profile-export`: writes an OTLP JSON file and, if an endpoint is configured, POSTs it. Returns the resulting path and status.

### 4.4 Export
- OTLP/JSON. For HTTP, `POST {endpoint}/v1/traces`, `Content-Type: application/json`, using `$.http.fetch`.
- `traceId` = the session UUID with `-` removed (32hex). `spanId` = FNV-1a 64 (kind+key) (16hex). Because it is deterministic, sending the same session again yields the same spans.
- Resource: `service.name=claude-code`, `session.id`, `agent_profiler.version`.
- Attributes: GenAI semconv first (`gen_ai.operation.name`=`chat`|`execute_tool`|`invoke_agent`, `gen_ai.request.model`,
  `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.agent.id`, `gen_ai.usage.input_tokens`/`output_tokens`),
  the rest as `agent_profiler.*` (`observability`, `category`, `exec_ms`, `wait_ms`, `ttft_ms`, `fs.path`, `bash.category`, `permission`).
- Sub-phases (ttft/thinking/output, exec/wait) are each made into child spans. This is so they show up directly in the Jaeger timeline.
- A subagent span is placed as a child of the Agent tool span even when it is asynchronous. OTel allows a child that outlives its parent.
- Auto-save: on every `turn.complete` and `session.end`, overwrite `<outputDir>/<sessionId>.otlp.json`. If `otlpEndpoint` is set, also POST (failures are ignored and shown once in the status line).
- `userConfig`: `otlpEndpoint` (default ""), `outputDir` (default `~/.claude/agent-profiler`).

## 5. Error handling — the profiler never interferes with the session
- Every observation hook wraps its recording code in `safe()` (try/catch) and always returns the result of `next(e)` unchanged.
- `tool.call` gets `.catch(($, e, next) => next(e))` attached. If `next` has already been called, the settled value is replayed, so the tool is not executed twice.
- The `turn.step` generator `yield`s every chunk unchanged and wraps only the recording in `safe()`.
- `tool.check` returns the decision from `next(e)` as is (it does not change the decision).
- File and HTTP failures are swallowed and shown only once in the status line.

## 6. Tests
- `claude plugin test` (`tests/*.test.ts`). The core modules are pure functions, so time is injected to verify them deterministically.
  - profiler: turn/request/tool pairing, parallel tools, the case where `PostToolUse` arrives first, permission ask, asynchronous and synchronous subagents, incomplete spans.
  - analyze: category total invariant (sum ≤ turn), repeated reads, Bash categories, findings thresholds.
  - otlp: structure, deterministic IDs, parentSpanId relationships, subagent link.
- Integration tests: verify the adapter with `$.tool.call` and `$.command.run('profile')`.
- Static checks: `claude plugin validate`, `tsc -p`.
- Manual E2E: load it into this session via hot reload and check the `/profile` output, then export to Jaeger and check the tree.

## 7. Directory (repository = marketplace)
```
.claude-plugin/marketplace.json          # plugins: [{ name: "agent-profiler", source: "./agent-profiler" }]
agent-profiler/
  .claude-plugin/plugin.json             # includes userConfig
  hooks/hooks.json                       # { "modules": ["./register.tsx"] }
  hooks/register.tsx
  hooks/core/{types,ids,profiler,analyze,classify,report,otlp}.ts
  tests/*.test.ts
  examples/jaeger/docker-compose.yml
  README.md
```
During development, hot reload by symlinking the repository folder into this session's mods folder (`~/.claude/dev-mods/<session>/agent-profiler`).
Install: `/plugin install agent-profiler --marketplace YeonwooSung/my-claude-code-mods`.

## 8. Behavior by runtime environment
| Environment | Hooks·recording·export | Pane/status line | `/profile` text |
|---|---|---|---|
| Terminal `claude` | ✔ | ✔ | ✔ |
| Desktop Code tab | ✔ | ✔ | ✔ |
| VS Code chat panel | ✔ | ✘ (drawing is not displayed) | ✔ |
| `claude -p` / SDK | ✔ | ✘ | ✔ |
