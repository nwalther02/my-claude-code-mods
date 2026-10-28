# Review of secret exposure paths across all mods

This document is the review record from before the fixes. For the results of the sequential fixes, see the [fix record](2026-10-17-privacy-fixes.md). The bundled reproduction script was converted, starting with the fixed items, into a regression check that requires the secrets to be absent.

Review date: 2026-10-17 (Asia/Seoul). Baseline commit: `07b7f04` (Context Inspector 0.1.1).

The scope of the request is credential exposure similar to issue #1. We reviewed the input collection, display, file storage, plugin store, export, and network transmission paths of the 7 mods. Only fake values were used for reproduction, and no real user session, credentials, or external server was accessed. No product code was modified in this review.

P1 below is the priority recommended for fixing first, P2 for follow-up fixes, and P3 for supplementing the display policy. This does not mean that an actual credential leak incident was confirmed. We distinguished the conditions for local storage and for external transmission.

## Problems found

### 1. [P1] Agent Profiler: even with command export turned off, secrets in search patterns remain in OTLP

- Location: `agent-profiler/hooks/core/otlp.ts:185`, `profiler.ts:40`, `hooks/register.tsx:133–184`.
- Reproduction: collect the Grep input `pattern: "API_KEY=FAKE_SEARCH_SECRET"` and call `toOtlp()` with the default options. The fake key remains in the original text in `agent_profiler.search.pattern` of the result.
- Cause: only prompt/Bash pass through `commandText` and the redactor, while the search pattern goes directly into an attribute.
- Impact: even with the default settings, the credential that was searched for is copied into the OTLP file that is recorded automatically. If the user has set `otlpEndpoint`, the same body is sent to the collector. The endpoint default is an empty string, so external transmission does not happen with the default settings. The export of the search pattern itself is described in the documentation, but there is no secret filter.
- Response: exclude the search pattern by default or make it a separate opt-in, and mask it when it is included. Also state the external transmission policy for the other free-form strings such as file paths.

### 2. [P1] Time Machine: secrets added to a file that was later ignored also enter new snapshots

- Location: `time-machine/hooks/git.ts:193–196`.
- Real Git reproduction: record `settings.txt` in the first snapshot → add `settings.txt` to `.gitignore` → change the file to `FAKE_NEWLY_IGNORED_SECRET` → create the next snapshot → confirm the new secret in `git show <new commit>:settings.txt`.
- Cause: `git add -A` is used on files that the shadow index already tracks. `.gitignore` does not exclude files that are already tracked. This is also independent of whether the project Git tracks the file.
- Impact: values from after the user added the ignore setting continue to be copied into the local shadow repository. This is not a claim that files ignored from the start are recorded. It must also be distinguished from the normal behavior of preserving past snapshots.
- Response: exclude files covered by the current ignore policy from the shadow index, and also verify the restore conflict handling for the excluded files. The cleanup policy for secrets that were already stored in the past is handled separately.

### 3. [P2] Time Machine: failing test names bypass the masked result summary and are stored in JSONL

- Location: `time-machine/hooks/core/testparse.ts:146–150`, `hooks/register.tsx:359–360`.
- Reproduction: feed `not ok 1 - API_KEY=FAKE_TEST_NAME\n# pass 0\n# fail 1` as the result. The key is erased in `summarizeResult().head`, but it remains in `parseTestOutput().failures[0].name` and is also recorded as is in the Recorder → ChunkWriter JSONL.
- Cause: the test metadata parsed separately from the full original text is stored in `step.test` without masking. Masking the failure name on screen alone does not protect the record on disk.
- Impact: on the default recording path, a credential contained in a test name remains in the local log. This can happen when a parameterized test includes its input values in the name.
- Response: separate the internal data used for comparison and identity decisions from the data used for storage and display, and mask free-form strings such as failure names just before they are stored.

### 4. [P2] Agent Profiler / Time Machine / Loop Detective: inconsistent masking rules

- Location: `agent-profiler/hooks/core/redact.ts:3–9`, `time-machine/hooks/core/redact.ts:3–9`, `loop-detective/hooks/core/fingerprint.ts:20–30`.
- Agent Profiler: with `exportCommandText=true`, `gh api --token FAKE_COMMAND_SECRET /user` remains in OTLP. The control check, in which this Bash command itself is excluded with the default value false, also passed.
- Time Machine: a token of the same form remains in the default JSONL input, and `inputLossy` is not set either. A URL userinfo password and `{"token":"FAKE_JSON_TOKEN"}` inside a JSON string are also stored. `.gitignore` does not apply to the Write/Edit input log, so file contents that would be excluded from snapshots can also be copied through the input summary.
- Loop Detective: `curl -u alice:FAKE_CURL_PASSWORD`, URL userinfo, `mysql -pFAKE_MYSQL_PASSWORD`, and `--secret FAKE_FLAG_SECRET` remain in the repeated-failure case report. For `--token "FAKE_PREFIX\"FAKE_ESCAPED_TAIL"`, the trailing part of the secret remains. This mod has no file or network export of its own, and the impact is on memory and the report and pane display.
- Control: the real nested object `{ token: "..." }` in Time Machine is masked. If the same content is a JSON string in a field such as `content`, it does not get the object traversal.
- Response: apply the same fake-input corpus to the redactors of all mods. Because of the independent plugin distribution structure, avoid the simple sharing in which one mod directly imports from another mod's directory, and use an approach in which each plugin is self-contained when distributed.

### 5. [P2] Agent Profiler / Time Machine: truncating first lets values that would be masked correctly leak out

- Location: `agent-profiler/hooks/core/profiler.ts:17,27,96`, `time-machine/hooks/core/tools.ts:128`, `time-machine/hooks/core/compare.ts:86`.
- Reproduction: append a sufficiently long string and a closing quote after `--password "FAKE_CUT_RESULT`. Passing the whole string to the redactor erases it, but Time Machine truncates first at 2,048 characters, so the closing quote disappears and the first part of the password remains in the JSONL result head and the rerun comparison.
- Agent Profiler has the same problem: the prompt is truncated at 120 characters and Bash at 512 characters at collection time, and is masked only afterward in the opt-in OTLP export.
- Impact: even for the `--password` form that is already considered supported, a long value is partially exposed. The result summary in Time Machine is recorded by default, while the Agent Profiler command and prompt bodies are opt-in.
- Response: perform masking first and then limit the display and storage length. If the original text is needed for execution classification or replay, separate the data by purpose, and also limit the processing cost of long inputs.

### 6. [P2] Context Inspector 0.1.1: headers with an escaped quote are partially masked, JSON bodies are not masked

- Location: `context-inspector/hooks/core/redact.ts:9` and the string rules as a whole.
- Reproduction: in the header value of `curl -H "x-api-key: FAKE_PREFIX\"FAKE_HEADER_TAIL" https://example.com`, `FAKE_HEADER_TAIL` remains. The header rule treats the escaped quote as the end of the value.
- Additional coverage gap: `curl -d '{"token":"FAKE_CONTEXT_JSON"}' https://example.com` remains in the original text. The earlier fix added CLI options, headers, URLs, and curl credentials, and it does not handle JSON credentials inside strings.
- Impact: both values remain in the `redactSecrets()` output, so they also remain in an export target that uses this function if they are within the length limit. The original 4 reproductions of issue #1 were fixed, but formats beyond those are not fully protected.
- Response: consider handling that accounts for shell quoting, support for the JSON key-value format or excluding free-form commands by default, and test that it fails safely without partial masking.

### 7. [P3] Agent Profiler / Context Inspector: reports and panes bypass the export masking

- Location: `agent-profiler/hooks/core/profiler.ts:11–13`, `core/report.ts:48`; `context-inspector/hooks/core/report.ts:47`, `core/advice.ts:30–32,87`.
- Reproduction: when `API_KEY=FAKE_UI_SECRET ./run.sh` is collected, the original text appears in the `/profile` slowest tool label and in `/context-inspect occupants`. This form is supported by the export redactor.
- Impact: this does not reproduce any remote transmission of its own. It is a path that exposes a secret that was in the original conversation again when sharing the screen, copying a report, or taking a capture. The export masking guarantee in the current documentation cannot be applied to the UI as it is, so this is classified as a display policy supplement.
- Response: keep the original for analysis, but apply the redactor to all display labels and advice evidence before truncating. Time Machine's isolated rerun also displays the original command directly as `$ ...`, so it is subject to the same policy review.

## Scope and results by mod

| Mod | Collection, display, and retention paths | Result |
|---|---|---|
| Agent Profiler | command and search summaries, report/pane/status, OTLP file, HTTP POST when configured | 1, 4, 5, 7 |
| Context Inspector | target/compaction/analysis, report/advice/pane, explicit JSONL export | 6, 7; the original case of existing issue #1 was fixed |
| Time Machine | tool input, results, and test metadata, JSONL, shadow Git, rerun/diff/error display | 2, 3, 4, 5; the original-text display policy also needs review |
| Loop Detective | limited command/cwd/path/failure metadata in memory, report/pane | 4; no file storage or network of its own |
| Pin Memo | explicitly entered memos, a cwd+session-scoped store, display/storage failures | no automatic collection or external export problem of the same kind was found |
| Model Effort Band | selected model and main-thread effort, AbovePrompt display | no command or result collection, permanent storage, or network path of the same kind |
| Token Run | request state, verified game checkpoint/numeric score, store | no credential collection problem of the same kind was found; storage failure is shown with a fixed notice |

Pin Memo's retention of the memo text, Time Machine's opt-in recording of model response text, and snapshots of files that are not ignored are stated features, so they were not counted as bugs in themselves. Pin Memo's error string displays the content of the engine exception, so it can be reviewed in a future common display policy, but whether a real store exception contains a secret was not demonstrated this time. The result that no new problem was found is not a security guarantee.

## Reproduction and verification

From the repository root:

```sh
node --experimental-transform-types docs/verification/2026-10-17-privacy-audit.mjs
```

The bundled script is a **characterization check** that confirms the current exposure behavior. It verifies 20 cases in which fake values remain, plus control cases. The 20 in the output does not mean 20 distinct vulnerabilities; they are grouped into the 7 cause and policy items above. When masking is fixed, the corresponding assertion must fail, and it then has to be changed into a regression test that requires the secrets to be absent. The ShadowGit check uses only real Git in a system temporary folder and removes it on exit. The rest use the in-memory collection, serialization, and display paths of the real core modules, and they do not drive the Claude UI automatically or actually POST to an external collector.

- Reproduction script: exit 0, 20 cases confirmed.
- Existing full core suite: `npm test`, 328 pass / 0 fail.
- Context Inspector 0.1.1 version change: TypeScript check passed, Claude Code 2.1.301 engine tests 99 pass / 0 fail.
- Passing existing tests does not mean the exposure paths above were defended. UI/HTTP end-to-end re-verification of all 7 mods on the engine is not included in this scope.

Recommended fix order: default storage/transmission paths (1–3) → missing formats and masking order (4–6) → unify the display policy (7). After fixing, the plugin version of each affected mod must be raised to distinguish it from cached installs.
