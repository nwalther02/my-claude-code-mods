# Context Inspector — Design Spec

- Status: approved (2026-10-10)
- Target: Claude Code mods API (type declarations 2.1.292, enabled by default 2.1.287+)
- Location: `context-inspector/` (this repository = the marketplace, alongside agent-profiler)

## 1. Purpose

Let the user see at a glance what the context is filled with in a long session, why the same
information keeps coming back in, and what compaction lost.

1. **Occupancy analysis** — aggregate live items (those still in the current window) by kind, tool, and target (file).
2. **Re-read analysis** — classify why the same file was read again, and show pure waste in ≈tokens.
3. **Similar-output detection** — find clusters of tool outputs that are identical or nearly identical.
4. **Before/after compaction comparison** — retention rate of key entities (edited files, read files, errors, user requests).
5. **Efficiency metrics** — context growth per turn versus the number of code lines changed.
6. **Advice** — rule-based recommendations drawn from the analyses above, each with evidence and ≈savings.

### Non-goals

- Do not change the context. Observe and advise only (if measuring changes what is measured, the analysis lies).
  Every hook returns `next(e)` unchanged, and `session.compact` also passes the result of `await next(e)` through as is.
- Do not claim per-token occupancy or attention inside the model.
- Embedding-based semantic similarity is not in v1. Similarity is **lexical LSH (SimHash)**, and the report says so.
- Do not store raw text. Keep only hashes, sizes, and targets (path/command).

## 2. Core principle: observability grades

| Grade | Meaning | Example |
|---|---|---|
| measured | Value reported by the API | usage of the `turn.step` stop chunk (input + cache_read + cache_creation) |
| observed | Computed directly from raw data the engine passes | character count of a row, hash, message sets before/after compaction |
| estimated | Estimate | per-row token count (character-based, calibrated against measurements), the engine's `/context` breakdown |

Token counts in the report always carry `≈` at the item level. Measured values (request input tokens) are shown without `≈`.

### Token estimation and calibration

- Default: `estTokens = ceil(chars / 4)`.
- Calibration factor `k`: from the difference Δ in measured input tokens between two consecutive requests in the same context (main or agentId)
  and the sum S of the `estTokens` of the items added in between, `k = clamp(ΣΔ / ΣS, 0.5, 2.0)`.
  Intervals that span a compaction or have Δ ≤ 0, and intervals with S < 200, are discarded. With no samples, `k = 1`.
- Report value = `round(estTokens × k)`. The report header shows `k` and the number of samples.

## 3. Events and calls used (confirmed against the 2.1.292 type declarations)

| Event / call | Use |
|---|---|
| `session.append` | Every row entering the conversation. `door` (`tool-result`, `prompt`, `response`, `attachment`, `hook-context`, ...), `uuid`, `agentId`, `origin` (the `tool` name when `kind: 'tool'`), `message.content` (ApiContentBlock[]; `tool_use_id` and `content` of `tool_result` blocks) |
| `tool.call` | `tool_use_id` ↔ tool name and input (file_path, offset/limit, command, pattern, Edit's old/new_string, Write's content). Records the input only and returns `next(e)` |
| `turn.step` | Streaming hook. Measured input tokens from the usage of the stop chunk. Contexts are told apart by `agentId` |
| `turn.start` / `turn.complete` | Main turn boundaries (turn number) |
| `session.compact` | Ignored if `trigger` is `precompute`. Otherwise: `e.messages` (before) and the `messages` of `await next(e)` (after), `tokensBefore/After`. Post-compaction messages that have a `handle` are retained original messages |
| `$.session.messages()` | One-time backfill on load (reload recovery) |
| `$.session.usage()` | `context.percent` for the status line; fixed overhead (system prompt, MCP schemas, memory files, skills) via `{ breakdown: 'summary' }` only when a command runs |
| `session.start` / `command.register` / `command.run` / `ui.render` / `$.ui.status` / `$.ui.toast` / `$.fs.write` / `$.env.get` | UI, commands, export |

`session.append` is the only point where the raw text is visible, so hashing, SimHash, and entity extraction happen there synchronously and the raw text is discarded.

## 4. Architecture

Same structure as agent-profiler: **pure core + thin adapter**.

```
context-inspector/
  .claude-plugin/plugin.json      # userConfig: outputDir, toastAdvice
  hooks/hooks.json                # { "modules": ["./register.tsx"] }
  hooks/register.tsx              # adapter: events → Ledger calls, commands, UI, export
  hooks/core/
    types.ts                      # ContextItem, ReadInfo, EditInfo, CompactionRec, Ledger snapshot
    text.ts                       # blocks → text, normalization, character count
    hash.ts                       # fnv1a64 (exact hash), simhash64, hamming
    tokens.ts                     # estimation and calibration factor
    ledger.ts                     # state machine (items, turns, per-context live set, compaction epoch)
    entities.ts                   # entity extraction for compaction comparison
    lines.ts                      # Edit/Write changed-line count
    analyze/occupancy.ts
    analyze/rereads.ts
    analyze/similar.ts
    analyze/compaction.ts
    analyze/efficiency.ts
    advice.ts                     # rule-based advice
    report.ts                     # text report, status line, panel lines
    export.ts                     # JSONL serialization (no raw text, target redaction)
    format.ts, redact.ts          # copied from agent-profiler (modules cannot be shared between plugins)
  tests/*.test.ts
  README.md
```

### 4.1 Ledger (state machine)

`ContextItem`:

```
{ seq, uuid, ctx: 'main' | agentId, turn, door, tool?, toolUseId?,
  target?: { kind: 'file'|'command'|'pattern'|'url'|'agent'|'other', value, range? },
  chars, est, hash, simhash?, epoch, live, isError?, backfilled? }
```

- An item is one `session.append` row. A row with several `tool_result` blocks yields one item per block.
- `target` is built by joining, via `toolUseId`, the input received earlier from `tool.call`
  (Read/Edit/Write/NotebookEdit → file, Bash → command, Grep/Glob → pattern, WebFetch → url, Agent → agent).
- `simhash` only for tool-results with ≥ 200 characters. The hash input is truncated to the first 256 KiB.
- `live`: an item that remains in the context's current epoch. Updated on compaction by the rules in 4.4.
- The edit record `EditInfo { ctx, turn, seq, path, linesChanged }` is recorded after `tool.call` (Edit/MultiEdit/Write/NotebookEdit) succeeds.
- A measured-input-token sample `{ ctx, turn, seq, inputTokens, epoch }` is taken at every `turn.step` stop chunk.
- Cap: 20,000 items. When exceeded, drop the oldest **non-live** items first and count `dropped`.
  Live items are not dropped (that would distort occupancy analysis); if still over the cap, drop the oldest first and count `droppedLive`.
  The largest seq among dropped items is kept as `trimmedThrough` (also in the snapshot; 0 if nothing was ever dropped). Calibration skips intervals whose first sample seq < `trimmedThrough` (some items in that interval may be gone, which would skew k).
- `version` counter: incremented on every change, used as the summary cache key.

### 4.2 Re-read classification (analyze/rereads.ts)

For a Read-result item R of the same path in the same ctx (when an earlier Read P exists):

| Class | Condition | Counted as waste |
|---|---|---|
| `unchanged-live` | P is still live, no edit to that path between P and R, same range, same hash | Yes (all of R's ≈tokens) |
| `after-edit` | There was an edit to that path between P and R | No |
| `after-compaction` | P was non-live at R's time (dropped by compaction), no edit | Counted separately ("compaction-induced") |
| `different-range` | The range (offset/limit) differs | No |
| `changed-externally` | No edit, same range, different hash | No |

The class is the first that matches, in this order: different-range → after-edit → after-compaction → changed-externally → unchanged-live.
P is the most recent Read of the same path and same range (if only reads with a different range exist, the most recent Read).

Waste is counted two ways: `wasteEst` = session cumulative (all unchanged-live re-reads), `currentWasteEst` = only those whose R is still live.
The waste in the status line and the report header is based on the **current window** (`currentWasteEst` + similar-cluster waste — the similar side only ever counts live items).
The Re-reads section shows both as `waste now ≈X · session ≈Y`. When compaction removes all the copies, current waste drops to 0 but the session cost remains.

### 4.3 Similar outputs (analyze/similar.ts)

- Exact duplicates: same `hash`, tool-result, ≥ 200 characters.
- Near duplicates: 64-bit SimHash over word 3-shingles, Hamming distance ≤ 3, not an exact duplicate.
- Clusters: union-find. Only candidates are compared, via band buckets made by splitting the 64 bits into four 16-bit blocks (roughly O(n)).
  If the Hamming distance is ≤ 3, at least one of the four blocks is equal (pigeonhole), so nothing is missed.
  However, a band bucket keeps and compares at most 256 representatives with distinct hashes (a performance cap). If more than that share one band value, near pairs can be missed — it is approximate, and the README limits section says so.
- Cluster waste ≈ (sum of the live items, excluding those already counted as re-read waste) − the largest of them.
- Normalization: collapse consecutive whitespace, replace digit runs with `#` (so test outputs that differ only in timings or counters are also grouped).

### 4.4 Compaction comparison (analyze/compaction.ts, ledger)

`session.compact`(trigger ≠ precompute):

1. Before: extract entities from `e.messages` — edited files (file_path in toolUses such as Edit/Write), read files, errors (first 120 characters of the first line of isError results),
   user requests (identifier-like tokens of length ≥ 4 in user messages: paths, `snake_case`, `camelCase`, strings inside backticks; at most 50).
2. `const r = await next(e)`. If `r.skip`, record nothing and return r.
3. After: check whether each entity appears in the string made by joining the text of `r.messages` + toolUses input/text + toolResults text (for paths, the basename is also accepted).
4. Live update: let K be the set of `tool_use_id`s remaining in the post-compaction messages that have a `handle`. Among the live items of that ctx,
   only those with `toolUseId ∈ K` stay live; the rest (and items without a toolUseId) become non-live. The epoch is incremented.
   The summary message (the one without a handle) is added as a new item with `door: 'compaction'` (by character count).
5. `CompactionRec { ctx, trigger, at turn, tokensBefore?, tokensAfter?, entities: {type, value, kept}[], keptItems, droppedItems }`.
6. Follow-up: among later `after-compaction` re-reads, link the ≈tokens of those that re-read a file lost in this compaction as the "re-inflow cost".

The hook returns `r` unchanged even on failure (the analysis code is in try/catch).

### 4.5 Efficiency (analyze/efficiency.ts)

Per main turn:
- `growth` = the last measured input tokens of that turn − the last measured input tokens of the previous turn (only within the same epoch; `n/a` if a compaction intervenes).
- `linesChanged` = the sum of EditInfo for that turn. Edit: split old/new into lines and sum the remaining line counts after removing common prefix and suffix lines (deleted + added).
  MultiEdit: the sum over each edit. Write: number of content lines. NotebookEdit: number of new_source lines.
- `tokensPerLine` = growth / linesChanged (if lines = 0 it shows `—`, and that turn is an "exploration turn").
- Session total and median. Exploration is legitimate, so it is shown as information, not as a warning.

### 4.6 Advice (advice.ts)

Each piece of advice is `{ id, severity: 'high'|'medium'|'low', title, evidence, savings≈ }`. Rules:

| id | Condition | Advice |
|---|---|---|
| `reread-unchanged` | unchanged-live waste ≥ 2,000≈ or the same file 3 or more times (savings is session cumulative — a habit recommendation, the title is in the past tense) | The content is already in the context; use Grep/offset for only the part needed |
| `large-read` | single Read ≥ 8,000≈, no offset/limit | Narrow the range with offset/limit or Grep |
| `large-bash` | single Bash result ≥ 5,000≈ | Reduce the output with `| tail -n`, `-q`, or a filter |
| `repeated-output` | cluster waste > 0 and (size ≥ 3 or waste ≥ 3,000≈) | Narrow the scope, e.g. re-run only the failing tests |
| `compaction-lost-edits` | compaction lost edited-file entities | State what to keep with `/compact <instructions>`, or put the plan in a file |
| `compaction-reflow` | after-compaction re-reads ≥ 5,000≈ | Same as above; include a summary of the key files in the instructions |
| `agent-verbose` | Agent result ≥ 4,000≈ | Tell the subagent to limit the summary length |
| `mcp-unused` | MCP server schema in the breakdown ≥ 3,000≈ and 0 calls to that server's tools during the session | Consider disabling the server or lazy loading |
| `memory-large` | a single memory file in the breakdown ≥ 4,000≈ | Trim CLAUDE.md |

`mcp-unused` and `memory-large` apply only when a breakdown exists (when a command runs). Severity: savings ≥ 10,000≈ high, ≥ 3,000≈ medium, otherwise low.
Toast: if userConfig `toastAdvice` (default true), once per session the first time a high advice appears.

## 5. UI and commands

- `/context-inspect [overview|occupants|rereads|similar|compactions|efficiency|advice] [--agents]`
  — Text report (works in every environment; it is the default output because the VS Code panel does not display the mod's graphics).
  The default is overview (top 3 of each section + advice). The default scope is main; with `--agents`, subagent contexts too.
- `/context-pane` — a `$.ui.open({ id: 'context-inspector' })` panel, refreshed when the version changes.
- Status line: `ctx 62% · waste≈8.1k` (percent comes from `$.session.usage()` and is omitted if unavailable; waste = unchanged-live re-reads still in the window + similar-cluster waste, excluding double counting — see 4.2).
- If the report header's k hit a calibration bound (0.5 or 2.0) and there were intervals, it is shown as `k=2.00 (clamped)`.
- `/context-inspect` and the panel, if summarizing or rendering fails, show a single line `context-inspector: report failed: <message>` instead of throwing.
  They refresh only on turn completion and after compaction (merged with `$.clock.after(0)`).
- `/context-export` — `<outputDir>/<sessionId>/context-<loadId>.jsonl`. One per line:
  `{"type":"item"|"edit"|"sample"|"compaction"|"summary", ...}`. No raw text; the target's command/url is truncated to 200 characters after redaction.
  Summary record: `wasteEst` (current), `currentWasteEst`, `sessionRereadEst`, `rereadWasteEst` (= session re-reads), `similarWasteEst`, `compactionReflowEst`, k, advice.
  Default outputDir: `$.env.get('HOME')/.claude/context-inspector`. Above 4 MiB, it is split into several files (`-<n>`).

## 6. Error handling — the inspector never disturbs the session

- Every hook returns `next(e)` unchanged. Analysis and recording are wrapped in try/catch and failures are ignored (one debug log line).
- `.catch(($, e, next) => next(e))` on `tool.call`, `session.append`, `session.compact`, and `session.end`.
- `session.compact`: `next(e)` is called exactly once, and the result is returned unmodified.
- Reload: reset state in `session.start`, then backfill from `$.session.messages()` (items `backfilled: true`, no turn/time information, all treated as live).
  A backfill failure is ignored.
- `/clear` and resume: afterwards the process continues with a new session id and `session.start` does not arrive. Instead, `session.end` arrives with reason `clear` (or `resume` when another session takes over).
  → `session.end` hook: after receiving the result of `next(e)`, if the reason is one of those, do the same reset + deferred backfill as `session.start` (one function, `reset`) and return the result unchanged.
- The deferred backfill runs when the ledger is the same object and there are no `prompt`/`response` items yet (tool results and attachments may arrive before that).
  The backfill skips calls and results whose tool_use_id already has an item in the ledger, so it creates no duplicates (edit records included), and does not attach `backfilled` to items that arrived earlier.
- Performance: the `session.append` path is O(row length). Summaries are cached by version. At 20k items, a summary takes < 200 ms.

## 7. Tests

- Core unit tests (fixture conversations): text extraction, hash/SimHash/Hamming, token calibration, ledger join / live update / cap,
  the five re-read classes, similar clusters (exact / near / no band misses), entity extraction and retention judgment, changed-line count, efficiency, advice rules, report, export redaction.
- Adapter tests (`claude plugin test`): hooks return the next result unchanged, command registration and execution, compact result unmodified.
- Performance test: summary time at 20k items.
- Type check: `tsc -p context-inspector --noEmit` (the type declarations are in the gitignored `.claude-plugin/types/`).

## 8. Review Focus (inputs the spec implies but that are easy to miss)

1. `tool_result.content` is a block array (including images) rather than a string — count only the text, and give images a fixed estimate (1,500≈).
2. A tool-result that arrives without `tool.call` (backfill, subagent, unknown id) — record it without a target and exclude it from re-reads.
3. Subagent compaction (`e.agentId`) — update only that ctx's live set.
4. `next(e)` returns skip or throws — no state change; propagate the result/exception unchanged.
5. A very large single output (several MB) — the hash is cut at 256 KiB, the character count is the full length.

## 9. Behavior by runtime environment

Same as agent-profiler: the terminal gets the status line, panel, toast, and commands; the VS Code chat panel gets only hooks and command text output.
In `claude -p` it only records, with no commands or UI (export is not saved automatically at session.end instead of `/context-export` — v1).

## 10. Facts confirmed with a probe, and the resulting adjustments (2026-10-10, 2.1.292 binary)

Using a probe mod, we observed a real session (`-p`, two Reads + Bash, then `/compact`). Where this section conflicts with the sections above, this section takes precedence.

1. **The engine already blocks unchanged re-reads.** The `tool.call` result of the second Read has `result.type === 'file_unchanged'`,
   and the text the model reads is a short notice ("Wasted call — file unchanged since your last Read…").
   → Add `engine-deduped` to the re-read classes (condition: the tool.call result type is `file_unchanged`; first in the classification order).
   The waste is only the ≈tokens of that short result, and the `reread-unchanged` advice does not count this class.
2. **The Read range is known from the result.** `result.file = { startLine, numLines, totalLines }`.
   Full read = `startLine <= 1 && numLines >= totalLines` (from the result). The range key is the **input**'s `offset:limit` (no key if neither is present = full) —
   if the result's numLines were used as the key, the same full read would be wrongly classified as `different-range` when the file grew between reads.
   `large-read` is decided as "a full read and ≥ 8,000≈".
3. **The same uuid is appended again.** After compaction the engine re-appends retained rows (e.g. the last response) with the same uuid.
   → The Ledger de-duplicates by uuid: if the uuid already exists, it creates no new item and revives that item as live, with the current epoch.
4. **A compaction handle equals the row uuid, and the summary message also has a handle.** So "retained if it has a handle" is wrong.
   → Retained set K_h = (set of handles before ∩ set of handles after), K_t = the tool_use_ids of post-compaction messages whose handle ∈ K_h.
   An item stays live if `uuid ∈ K_h` or `toolUseId ∈ K_t`. The summary row arrives later as a `door: 'compaction'` append, so
   the "add a summary-message item" of 4.4 is handled by the append path (it is not created separately in the compaction hook).
5. **After compaction the engine re-inserts recently read files as an `attachment` (name `file`)** (the body contains `Called the Read tool with the following input: {"file_path":…}`).
   → This item's target is that file_path; it is handled like a Read in the re-read analysis, but classified as `restored` (engine restoration; counted as compaction-induced cost).
6. **Row order**: `tool.call` result → that tool-result append → (that request's) stop chunk. Compaction: `session.compact` hook → compaction rows append → re-append.
   → The calibration factor is computed by telescoping sums over epoch intervals instead of request pairs:
   for the first sample a and last sample b in the same ctx and epoch, Δ = input_b − input_a, S = the sum of est over items with seq ∈ (seq_a, seq_b].
   Use only intervals with S ≥ 2,000, and `k = clamp(ΣΔ/ΣS, 0.5, 2.0)`.
7. **Turn boundary**: `turn.start` comes after the first attachments and is absent for commands such as `/compact`. The main turn number is defined as incrementing by 1 on every `door === 'prompt'` append in the main ctx.
8. **Attachments are big occupants** (skill_listing, agent_listing_delta, mcp_instructions_delta, hook_additional_context, environment …).
   Categories for occupancy analysis = the tool name for tool-results, `attachment:<name>` for attachments and hook-context, and the door for everything else.
   A row with empty content (`[]`) does not become an item.
9. **Tests**: `session.append` cannot be raised in the test runner (the answering hook is skipped). So the event → Ledger conversion is kept as the pure function `ingestAppend` and unit-tested.
   `session.compact` and `session.end` can be raised in the 2.1.292 runner (`$.clock.after` is not implemented in the runner, so the deferred backfill is covered by unit tests). Adapter tests run against the 2.1.292 binary.
10. **An item's birth epoch (`born`)**: give items `born` (the epoch at append time), distinct from `epoch` (the last epoch in which it was live).
    In re-reads, "the earlier read P dropped out through compaction before R" ⇔ `P.epoch < R.born`. (Using only `epoch` would judge the case where R survives compaction and P drops out backwards.)
11. The `file` attachments the engine adds also arise from @mentions in the prompt. So the item is only marked `attached: true`,
    and the `restored` class is given only when "it is attached, an earlier read P exists, and `P.epoch < R.born`".
