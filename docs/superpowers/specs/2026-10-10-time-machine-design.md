# Agent Time Machine — Design Spec

- Status: Approved (2026-10-10)
- Target: Claude Code mods API (type declarations 2.1.292, enabled by default in 2.1.287+)
- Location: `time-machine/` (this repository = the marketplace, alongside agent-profiler and context-inspector)

## 1. Purpose

When a coding agent changes several files and ends up with an unexpected result, a Git diff only says "what changed".
Time Machine records "in what order, which tool calls, from which file state, produced which result" and lets you go back and look.

```
Session #184
├── ① Read auth.py
├── ② Grep JWT
├── ③ Edit auth.py            └── snapshot A
├── ④ Bash pytest             └── 3 failed
├── ⑤ Edit middleware.py      └── snapshot B
└── ⑥ Bash pytest             └── 12 passed   (fixed by ⑤)
```

Core: when you move to an arbitrary point (step), you can see **the filesystem state at that time** and **the tool call history**.
Extensions (included in v1): restoring a point in time, creating branches, comparing two execution paths, tracing the causality between file edits and test failures, and comparing re-runs with the same input.

### Non-goals and honest boundaries

- **Restoring file state ≠ deterministic reproduction of an LLM run.** v1 only rolls files back and runs tools again; it does not reproduce model responses, external services (WebFetch, MCP), time, or random numbers.
  Model turns are only recorded (summary and hash). The recording and mocking layer needed for reproduction is left as a design only, in §9.
- Files that are `.gitignore`d (build artifacts, `node_modules`, `.env`, etc.) are not subject to snapshot or restore.
- The conversation itself is not forked (`/tm branch` branches only the file state and the timeline).
- It does not replace Claude Code's built-in `/rewind` (file checkpoints for the Edit/Write tools). Time Machine also catches files changed by Bash, and adds timeline, causality, and comparison.

## 2. Observability grades

| Grade | Examples |
|---|---|
| exact | Tracked file contents at the snapshot point (shadow git commit), tool input, tool result text (the beginning) and hash, exit status of test commands |
| parsed | Pass/fail counts read from test output, failing test names, failure location file:line (only in formats the parser knows) |
| inferred | Causal suspect ranking, "fixed by", the divergence point of a path comparison |
| not reproduced | Model responses, external services, time, random numbers |

## 3. Facts confirmed by probe (2.1.292 binary, 2026-10-10)

- `$.process.run(['git', '--git-dir=<shadow>', '--work-tree=<cwd>', …])` works in a mod. `add -A` + `commit` take about 20 ms each in a small repository, so one snapshot ≈ 40 ms.
- Files deleted by Bash (deletions) and new files are caught in the next snapshot. `.gitignore` is applied (`out.log` is excluded). The user's `.git` is not touched (git does not add a `.git` entry).
- `$.fs` has only read (≤ 4 MiB)/write/list/exists/stat and **no delete** → restore and cleanup are done through git and `$.process.run`.
- The test runner's `$` has no `process` (`$.process` is undefined).
- `GIT_INDEX_FILE` can be given per session through the `env` of `$.process.run`. git runs with repository hooks turned off.
- `$.tool.call` calls the tool again through the same `tool.call` event as the engine (including permission checks and dialogs).
- `$.session.append({ message: { type: 'user', content: [text] } })` can put a note that the model reads into the conversation.

## 4. Architecture

Pure core + thin adapter + git wrapper.

```
time-machine/
  .claude-plugin/plugin.json   # userConfig: storeDir, retentionDays, recordModelOutput, skipSearchBash
  hooks/hooks.json
  hooks/register.tsx           # adapter: events → Recorder, commands, pane, notes
  hooks/core/
    types.ts                   # Step, Snapshot, TestRun, Branch, SessionMeta
    timeline.ts                # Recorder state machine (steps, branches, turns), serialization/deserialization
    tools.ts                   # tool classification (mutating/read-only), input summary and target extraction, result summary
    classify.ts                # Bash command classification (copied from agent-profiler)
    testparse.ts               # test output parsers: pytest, jest/vitest, go, cargo, node:test, generic
    causality.ts               # suspects of a failed run, fixed-by
    compare.ts                 # LCS alignment of two paths, divergence point, summary
    render.ts                  # timeline tree, step detail, why, compare, rerun comparison, status line
    store.ts                   # JSONL chunk paths and splitting rules (pure)
    redact.ts                  # secret masking from agent-profiler (copied)
  hooks/git.ts                 # shadow git wrapper: init, snapshot, treeOf, diff, restore, checkoutTo, prune (serial queue)
  tests/*.test.ts
  README.md
```

### 4.1 Store layout

- Root: userConfig `storeDir` (default `~/.claude/time-machine`)/`<projectKey>`/. `projectKey` = the basename of the absolute session root path + `-` + the first 8 characters of fnv1a64(path).
- `shadow.git/`: a bare repository. Per-session index `index/<sessionId>` (`GIT_INDEX_FILE`), per-session ref `refs/tm/<sessionId>/<branch>`.
  Commit author `time-machine <tm@local>`, message = `step <n> <tool> <sessionId>`.
- `sessions/<sessionId>/meta.json`: `{ sessionId, root, startedAt, model?, branches }`.
- `sessions/<sessionId>/<loadId>-<chunk>.jsonl`: timeline records (§4.3). When a chunk exceeds 1 MiB, the next number is used. The current chunk is rewritten in full each time a record is added (`$.fs.write` has no append).

### 4.2 Snapshots

- **Baseline**: one `snapshot(label='baseline')` at session start (or load).
- **After mutating tools**: `snapshot` after Edit, MultiEdit, Write, NotebookEdit, Bash, and (conservatively) unknown tools and MCP tools.
  Read-only tools (Read, Grep, Glob, LS, WebFetch, WebSearch, TodoWrite, Task/Agent itself, etc.) get no snapshot.
  userConfig `snapshotReadOnlyBash` (default false): when false, Bash that classify marks as `search` is skipped.
- **External change detection**: *before* a mutating tool, get the current tree with `treeOf()` (add -A + write-tree); if it differs from the previous snapshot's tree, commit that difference and record it as an `external` step (so that something a person fixed in the IDE is not blamed on the agent).
- `snapshot`: `add -A` → `write-tree` → if the tree is the same as the previous one, do not commit and point at the previous commit as is (`changed: false`). If it differs, `commit-tree -p <prev>` + update the ref.
  Attach the changed file list (`A/M/D/R`) from `diff --name-status <prev> <new>` to the step (up to 200; if more, only the count).
- **Serial queue**: all git calls are serialized through one Promise queue (parallel tool calls, index locking). A snapshot taken while another mutating tool is in progress gets `concurrent: true`.
- **Time budget**: timeoutMs 30 s for each git call. The snapshot time (ms) is recorded on the step, and the report shows the average and maximum.
- **No git / failure**: if the first git call fails, switch to `snapshots: off` for the rest of the session, record only the timeline, and show the reason in the status line and the report.

### 4.3 Timeline records (JSONL)

```
{type:'session', sessionId, root, startedAt, loadId}
{type:'turn', n, at, prompt:{chars, hash, head?}}                              // head: first 200 chars, only when recordModelOutput is on
{type:'step', n, id, turn, agentId?, branch, parent, tool, kind:'tool'|'external'|'restore'|'baseline',
  input, target?, startedAt, endedAt, result:{isError, denied, chars, hash, head}, 
  snapshot?:{commit, changed, files:[{status,path}], ms, concurrent?}, test?:TestRun, rerunOf?}
{type:'model', turn, index, agentId?, model, stopReason, usage, text:{chars, hash, body?}, toolUses:[{id, tool}]}
{type:'branch', name, fromStep, at}
```

- `input`: tool input. String fields are cut at 4 KiB and end with `…(+N chars, hash)`; for Write's `content` and Edit's `old/new_string`, only the first 4 KiB are kept (the full text is in the snapshot).
  Redaction is applied to the Bash `command` and to all string inputs.
- `result.head`: the first 2 KiB of the result text (redaction applied). The full text is not stored (re-run comparison uses hash + head).
- The step number `n` increases monotonically from 1 within a session (regardless of branches). It is displayed as ①②… (as a number past 20).
- `parent`: the previous step n on the same branch (for the first step, the branch point or 0). `branch`: `main` by default.

### 4.4 Test runs and causality

- Classify the `command` of a Bash step → if it is `test`, build `TestRun { framework, passed?, failed?, errors?, skipped?, failures:[{name, file?, line?}], ok }` with `testparse(output, exitCode?)`.
  - pytest: the `=+ (\d+ failed)?, ?(\d+ passed)? … in` summary line, `FAILED path::name`, `path:line:` in the traceback.
  - jest/vitest: `Tests: +(\d+) failed, (\d+) passed`, `● Suite › name`, `FAIL path`, `at … (path:line:col)`.
  - go: `--- FAIL: Name`, `FAIL\tpkg`, `ok\tpkg`, `file_test.go:line:`.
  - cargo: `test result: (ok|FAILED). (\d+) passed; (\d+) failed`, `---- name stdout ----`, `src/x.rs:line:col`.
  - node:test: `# pass N`, `# fail N`, `not ok N - name`.
  - generic: if the result is an error (`isError`) it counts as a failure, otherwise as a pass, with no counts (`framework:'unknown'`).
- **Suspects (why)**: for a failed test run F, the baseline B = the last *passing* test run before F on the same branch (the baseline snapshot if there is none).
  Each file changed between the B snapshot and the F snapshot gets a score: its path (or basename) appears in the failure output +100, file:line appears +50, the closer the step that last changed it is to F +(0..20), log2 of the number of changed lines +(0..10).
  The top 5 are shown with their evidence, together with the step numbers that changed those files.
- **fixed by**: if there is a first passing run P after F, the files changed between F→P and their steps are shown as "fixed by".
- A change in the failure count (for example 3 failed → 1 failed) is marked "improved".

### 4.5 Restore and branch

- `/tm restore <n> [--yes]`: target = the snapshot of step n (if step n has no snapshot, the nearest snapshot before it).
  1) Without `--yes`, dry run: show only the list of files that would change (`A/M/D`) and the count, then stop.
  2) With it: first commit the current state as a `restore-from` snapshot (so that the restore itself can be undone) → `read-tree -u --reset <target>` (with the session index; tracked files are matched to the target and tracked files not in the target are deleted, ignored files are left as they are) → record a `kind:'restore'` step (snapshot = the target commit) → append a note to the conversation:
     `[time-machine] The user restored the working tree to step <n> (<tool> <target>). Files changed: …. Earlier tool results about these files are out of date; re-read before editing.`
  3) If a turn is in progress, refuse (`busy`) and show the reason (commands run between turns).
- `/tm branch <n> [name] [--yes]`: same as restore, but the later steps are recorded on a new branch (`name`, default `b<k>`), a `branch` record is added, and the ref is `refs/tm/<sid>/<name>`.
  The fact that the conversation is not forked is stated in the output and the note.
  The tree of a branch restore step is the same as the tree of step n, so `snapshot.files = []` and `filesTotal = 0` (so that `/tm why` does not treat files changed only on the branch that was left as suspects), and the list of working tree changes is kept for display in the input's `workTree: [{status, path}…]` (up to 200). A restore on the same branch keeps the changed files in `snapshot.files` as they are.
- Restore is run only by a user command (it is not exposed as a tool the model can call).
- Ignored files are not snapshotted, so when the target tree would overwrite or delete a path that is ignored and untracked (the same path, or one being a directory prefix of the other: `out/` ↔ `out`, `d` ↔ `d/f`), the restore refuses without touching anything: `restore would overwrite ignored files that no snapshot holds: <up to 10>; move them aside and run the restore again`. It does not force an add (because ignored secrets would be copied into the shadow repository). The check uses `ls-files -z --others --ignored --exclude-standard --directory` and `ls-tree -r -z --name-only <target>`, inside the serial queue before commit-tree.

### 4.6 Compare

- `/tm compare <a> <b>`: a and b are branch names or `session:<id>[/<branch>]` (the record of another session in the same project).
- Each path = the list of steps that follow that branch (including the common part before the branch point). Key = `tool + ' ' + target` (just tool if there is no target).
- Align with LCS → the first mismatch = the divergence point. Output: the length of the common prefix, each path's steps after the divergence point (up to 20), file diff statistics between each path's last snapshot, each path's last test result, and the total snapshot time.

### 4.7 Re-run

- `/tm rerun <n> [--write] [--isolated]`:
  - Default: call again with the same input through `$.tool.call({ tool, ...input })` (including the permission check). Only read-only tools are allowed; a mutating tool needs `--write`, followed by a snapshot.
    Result comparison: same hash → "identical"; otherwise a line diff summary based on head (+/− line counts, the first 3 differing lines). For tests, compare the TestRun (change in passed/failed).
  - `--isolated` (Bash only): unpack the snapshot just before step n into a temporary directory (`<storeDir>/<projectKey>/tmp/<rand>`) with `git archive | tar -x` (or `checkout-index --prefix`) and run it with `$.process.run(['sh','-lc',command], { cwd: tmp, timeoutMs })` → compare the results → delete the temporary directory.
    Ignored files (dependencies and so on) are absent, so this is best effort, and the output header says so. This path does not go through the permission dialog, so it is run only by a user command, and the command to be run is shown in the output first.
    `--isolated` without `--yes` is a dry run: it shows only the command (`$ <command>`), the snapshot to be used, the cautions, and how to run it, and runs nothing (from any origin). With `--yes` (user-input origin only), it refuses when the command contains the absolute path of the project root ("the command refers to the project's absolute path, so it would not be isolated"); otherwise it checks for external changes before and after the run and records any change made to the project as an `external` step.
- Model responses are not re-run (§9).

### 4.8 UI and commands

All under a single `/tm <sub>` (one registration, `argumentHint`).

| Command | Description |
|---|---|
| `/tm` or `/tm timeline [--all] [--branch b]` | Timeline tree (the latest 30 steps, `--all` for all). For each step: number, tool, target, a one-line result, snapshot marker, test summary |
| `/tm show <n>` | Step detail: input (shown truncated), result head, changed files, test result, snapshot commit and time |
| `/tm diff <a> [b]` | `diff --stat` + patch between the snapshots of step a and b (default: current) (up to 400 lines, truncation is marked if exceeded) |
| `/tm why [n]` | Suspects and fixed-by for failed test run n (default: the last failure) |
| `/tm restore <n> [--yes]` | §4.5 |
| `/tm branch <n> [name] [--yes]` | §4.5 |
| `/tm compare <a> <b>` | §4.6 |
| `/tm rerun <n> [--write] [--isolated]` | §4.7 |
| `/tm sessions` | List of recorded sessions of this project (start time, step count, branches) |
| `/tm-pane` | Live timeline pane |

Status line: `tm ⑫ · 5 snaps · 41ms` (last step number, snapshot count, average snapshot time). When snapshots are off: `tm ⑫ · snapshots off`.

## 5. Events

| Event | Purpose |
|---|---|
| `session.start` | Prepare the store (init), session metadata, load earlier records (on a reload, read and restore the chunks of the same sessionId), retention cleanup, baseline, command registration |
| `session.end` (reason `clear`/`resume`) | Switch the Recorder to the new session id (the new session folder of §4.1), baseline |
| `turn.start` | turn record |
| `tool.call` | If mutating, detect external changes → `next(e)` → record the step → (if mutating) snapshot → parse tests. The result is returned unchanged |
| `turn.step` | stop chunk: model record (usage, stopReason); text chunk length and hash (the body if recordModelOutput is on) |
| `command.run` / `ui.render` | commands and pane |

## 6. Error handling — never disturb the session

- Every hook returns the result of `next(e)` unchanged. Recording, git, and file writes are in try/catch, and a failure is shown in one line in the status line and the report.
- `tool.call` returns after waiting for the snapshot (to pin the state before the next tool changes files). This wait delays tool completion by the git time — the report shows the measured value.
- `.catch(($, e, next) => next(e))` on tool.call, turn.step (generator), and session.end.
- Restore/branch/re-run are explicit user commands, and restore and branch need `--yes`. The current state is always snapshotted before a restore.
- The user's `.git` and ignored files are never written. The shadow repository does not write outside `storeDir` (the temporary directory is inside it too).

## 7. Retention

- At `session.start`, delete session folders older than `retentionDays` (default 14) (`$.process.run(['rm','-rf',dir])`, after checking that the path is under `storeDir/<projectKey>/sessions/`), delete the corresponding refs, and run `git gc --prune=now --quiet` once a day (the last run time is kept in `$.store`).

## 8. Tests

- Core units: Recorder (numbering, branch/parent, serialization round trip), tools (classification, input summary, truncation, redact), classify, testparse (sample output per format), causality (suspect scores, fixed-by, improved), compare (LCS, divergence point), render (tree, detail, why, compare), store (chunk splitting).
- git wrapper: the test runner's `$` has no `process` (confirmed by probe), so real git cannot be run in unit tests. So `git.ts` takes an injected
  `Runner = (args: string[], opts: { env?, cwd?, timeoutMs? }) => Promise<{ exitCode, stdout, stderr }>`,
  and the unit tests use a fake Runner (it records the calls and answers as scripted) to check the command order, arguments, environment (`GIT_INDEX_FILE`), output parsing (name-status, write-tree comparison), and the error path (no git → snapshots off).
  The real behavior (changed/unchanged/deleted/ignored files, including restore deletion, the restore-from commit, branch refs) is verified by E2E.
- Adapter: command responses, tool.call result left unmodified, dry run output.
- E2E (2.1.292 `-p` stream-json, one process): file Read → Edit → failing test (Bash) → Edit → passing test → `/tm` → `/tm why` → `/tm restore 3 --yes` → check the file contents.

## 9. v2 design note: a recording and mocking layer for deterministic reproduction (not implemented)

A structure the mods API makes possible:
1. **Model response cassette**: if a `turn.step` hook emits recorded chunks without `next` (a generator), the engine uses them as the model response. Key = hash of the request messages (`$.session.messages({as:'api'})`) + model + index. If v1's `model` record keeps the body and toolUses input through `recordModelOutput`, it becomes the raw material for this cassette.
2. **Tool result cassette**: the `tool.call` hook answers with `{ result }` without `next`. Key = (tool, input hash, previous snapshot commit). The file state is reconstructed by the shadow git.
3. **External services**: WebFetch/WebSearch/MCP are covered by the tool result cassette. Bash that uses the network is marked as not reproducible without a cassette.
4. **Time and random numbers**: not reproducible if the test depends on them. At recording time, only warn by detecting `date`, seeds, and the like.
5. Reproduction run = new session + baseline restore + cassette mode. The point where the cassette misses is exactly the "non-deterministic divergence point".

## 10. Execution environments

| Environment | Behavior |
|---|---|
| Terminal | All commands, the pane, the status line |
| VS Code chat panel | Hooks and command text only (the pane and status line are not shown) — the `/tm` text is the default output |
| `claude -p` | Recording and snapshots work; commands go in the same process through stream-json input |

## 11. Corrections decided at the planning stage (2026-10-10)

1. **The baseline is taken when git is first needed** (right before the first mutating tool, or at the first `/tm` command that uses git). The hook's `$` can only be trusted while that hook is alive, and this also avoids delaying session start by the git time. Baseline = "the state just before the first recorded change". It replaces "baseline at session start" in §4.2 and §5.
2. **Bash is snapshotted in all cases by default.** Even a command that classify sees as `search` can write a file through a redirection (`cat > f <<EOF`). If nothing changed there is no commit, so the cost is one tree hash. Turning on userConfig `skipSearchBash` (default false) skips `search` commands. It replaces `snapshotReadOnlyBash` of §4.2.
3. **Conditions that turn snapshots off**: off if the session root is `/` or HOME; off if the baseline snapshot takes more than 5 seconds (because every later mutating tool would be that much slower). The reason is shown in the status line and in `/tm`.
4. `turn.step` is a generator hook, so no `.catch` is attached, and all recording is done inside a try.
5. The git wrapper uses, for each hook, a Runner built from that hook's `$` (`git.runner = runnerOf($)`).
6. Re-run input: a step recorded in this load is re-run with the original input kept in memory. Stored input may have been truncated or masked (`inputLossy`), so such a step is not re-run in another load.
7. **Store location**: if `storeDir` (after `~` expansion) is not an absolute path, snapshots are off ("storeDir must be an absolute path"). If the store (`<storeDir>/<projectKey>`) is inside the project, snapshots are off ("the time-machine store is inside the project") — because the snapshot would then contain the store itself.
