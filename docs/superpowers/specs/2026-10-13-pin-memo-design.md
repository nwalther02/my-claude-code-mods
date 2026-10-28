# Pin Memo — Design Spec

- Written: 2026-10-13 (Asia/Seoul)
- Status: Implementation and verification completed after user approval (2026-10-14, Asia/Seoul).
- Mod name / location: `pin-memo` / `pin-memo/`
- Purpose: Pin memos and a checklist above the Claude Code input box, and restore them when the same session is resumed in the same folder.
- Design basis: The dark background, rounded teal border, pin title, check items and dimmed completed items in the attached image. The memo contents in the image are not interpreted as functional instructions.

## 1. Interpretation of the Request and Approach

The default entry point the user asked for is `/pin <memo>`. Memos are not inserted into the regular conversation or the model context; they are managed as UI data for the user. They are displayed while work is in progress, after a turn completes, and after conversation compaction.

“The same session opened in the same folder” is defined as the case where both the folder path and the session ID are the same. The existing list does not appear in a new session in the same folder or in a session in a different folder. `/clear` is a new session, so it starts with an empty list, and the previous session's stored data is preserved.

| Approach | Advantage | Cost / Constraint |
|---|---|---|
| `AbovePrompt` + engine `$.store` (recommended) | The requested placement, restoration on resume and reload, no need to manage a storage path | 4 MiB limit for the whole plugin store; no atomic update API across processes |
| `AbovePrompt` + a separate JSON file | Storage size and file path are managed directly | Handling of directories, writes, corruption and file conflicts must be added |
| Separate Pane | A wide management screen | Does not meet the requirement of being pinned directly above the input box |

No new dependencies, model calls, network requests or background polling are added.

## 2. Command Contract

| Command | Behavior |
|---|---|
| `/pin <memo>` | Add a regular memo |
| `/pin - [ ] <memo>` or `/pin [ ] <memo>` | Add an unchecked check item |
| `/pin - [x] <memo>` or `/pin [x] <memo>` | Add a completed check item (`X` is also allowed) |
| `/pin add <memo>` | Explicit add; reserved words such as `help` and `clear` themselves can also be saved as memos |
| `/pin` or `/pin list` | Print the whole list and the numbers as text |
| `/pin toggle <id>` | Toggle the completion state of a check item |
| `/pin check <id>` / `/pin uncheck <id>` | Set the check state explicitly; a duplicate call does not flip the state again |
| `/pin edit <id> <memo>` | Edit the content; adding a check marker changes it to a check item, omitting it changes it to a regular memo |
| `/pin remove <id>` | Delete the specified item |
| `/pin clear` | Delete the whole list of the current session |
| `/pin help` | Print command usage |

- Only leading and trailing whitespace is removed, and line breaks in the body are preserved. One multi-line input is one memo. The check marker is interpreted only at the start of the body.
- Empty content, content with only a marker, a nonexistent ID, a check command on a regular memo, and a missing command argument return an error message and do not change the stored state.
- IDs are positive integers that increase per session. Numbers are not reused after deletion, and the remaining items are not renumbered. `clear` does not reset the next number either.
- To add content that starts with a reserved word, use `/pin add ...`. An unknown first word is added as a regular memo.
- A maximum of 100 items and 2,000 Unicode code points per item are allowed. Anything over that is explicitly rejected and is not truncated and saved.
- ANSI sequences and C0/C1 control characters (except line breaks) in user input are removed. Content that is empty after cleanup is also rejected.
- The command result is a text response of a registered local command. It does not request a prompt modification or a model run.

## 3. Pinned Area Design and Interaction

```text
╭──────────────────────────────────────────────────────╮
│ 📌 Pin 3 (1 done)                                    │
│ 1 · Check tests before the change                    │
│ [ ] 2 Check .env keys before deploy                  │
│ [x] 3 Upload to Drive when the render finishes       │
╰──────────────────────────────────────────────────────╯
```

- Border: rounded shape, teal `#62B8AD`. Title: warm yellow `#D5C57A`, body: `#D6D9E0`.
- Unchecked check items are shown in the body color, and completed items in dim gray with strikethrough. Completed items are not automatically deleted or reordered.
- The dark background of the image is harmonized with the existing terminal theme, and no pixel-exact reproduction of the picture is promised. The background `#1D2029` is applied within what the engine's Box/Text styles support.
- A regular memo is a Text, and the `[ ]` / `[x]` before a check item is a Button with a stable key. It toggles by click, or by Tab/Enter after focusing the band.
- No numeric hotkey is assigned to the check button. The user's input is not made to conflict with the engine behavior where a number executes a command in an empty input box.
- Focus, collapse and scroll follow the `AbovePrompt` behavior the engine provides. A custom `[Collapse]` button is not added redundantly.
- If `bodyColumns >= 30` and `maxRows >= 3`, the border and title are shown. In a narrower area, the border is omitted and the title and items are shown concisely. If the area width or height is 0, nothing is shown.
- When the width is narrow, only the displayed body is truncated with an ellipsis, and the stored original is kept. The pinned-area display of one item is condensed to one line, and the full content is checked with `/pin list`.
- For many items, the engine's band scroll and the `n more` indicator are used. Rendering itself does not delete items.
- If the list is empty, no pinned area is added.
- When `hasSurvey === true`, where a survey uses the slot, it yields to the engine UI. When the survey ends, the memos are shown again.
- The render tree of other mods' `next(e)` is preserved and this mod's own area is appended to it. If rendering fails, the existing tree already obtained is returned.
- Both the main conversation and the subagent view show the current main session's memos. No per-subagent list is created.
- It targets `AbovePrompt` in the terminal and Desktop. In the VS Code chat and headless environments, only the commands and the storage feature are provided.

## 4. State and Storage Contract

### Storage Key and Document

The key is `pin-memo:v1:` followed by `JSON.stringify([absoluteCwd, sessionId])`. This avoids hash collisions and path-separator interpretation, and treats the path and ID only as string data of the key. The path is the absolute path returned by the engine's `$.session.cwd()`, with only a trailing separator other than the root removed. Different symbolic-link paths are treated as different folders.

```ts
type Memo = { id: number; text: string; checked: boolean | null }
type MemoDocument = { version: 1; nextId: number; items: Memo[] }
```

`checked: null` is a regular memo. When reading a document, the version, whether IDs are positive integers and unique, the increasing relation of nextId, the string contents and length, the item count, and the check state are validated. A bad document is not pretended to be partially recovered.

### Lifetime and Concurrent Execution

- State lives in a controller inside the `register` call. No module-global mutable list is kept.
- On `session.start`, after registering the commands, the stored document of the current identity is loaded. A hot reload loads the same data.
- Every change is saved immediately with `$.store.set`. Saving only in a normal-shutdown hook is not used.
- Changes within one process are handled by a serial queue. After a successful save, the in-memory list is replaced and invalidated. Rapid consecutive checks and additions must not overwrite with an older snapshot.
- A command that arrives during loading waits for the load of that identity to complete. Rendering performs no I/O or state change.
- On clear/resume in `session.end`, the previous view is invalidated, the downstream is passed through, and then the new identity is loaded. The identity is also checked on the main `turn.start` and before command execution to guard against a missed transition.
- Identity and generation are checked so that a previous load completion or a check callback from a previous screen cannot overwrite the new session's state. A change already approved in the previous session can be saved only under the previous session's key.
- A stale UI check callback does not capture the check value and invert it; it toggles the latest item state inside the queue.
- Real-time synchronization of editing the same session from several processes at once is excluded from the v1 scope. Since `$.store` has no compare-and-swap contract, conflict prevention is not guaranteed in this case. This limitation is stated explicitly in the README.
- No automatic expiry or automatic deletion of stored data is added. Exceeding the limit is treated as a save error.

### Failure Handling

- Identity lookup failure: the list of another session is not shown and changes are rejected. It can recover on the next successful lookup.
- Storage read failure / corrupted or unknown version: it is not treated as an empty list and overwritten. An error state is shown and the read is retried. Only an explicit `/pin clear` can reset the current key.
- Write failure: the existing list is kept and “Could not save” is shown. A success message or an on-screen check change is not shown first.
- A UI invalidate failure does not cancel a successful save. The latest state appears on the next render.
- The session/turn observation hooks preserve the downstream's events, return values and exceptions. `next` is not called twice.

## 5. Implementation Boundaries

```text
pin-memo/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.tsx          # command registration, session identity, AbovePrompt/Button
  hooks/core/memo.ts          # document validation, command parsing, immutable state updates
  hooks/core/controller.ts    # injected store, serial changes, session-transition isolation
  hooks/core/view.ts          # title, row text, per-width display data
  tests/memo.test.ts
  tests/controller.test.ts
  tests/view.test.ts
  tests/adapter.test.ts       # real engine render, press and lifecycle contract
  tsconfig.json
  README.md
  README_KR.md
```

Add `pin-memo` to the existing marketplace, the README's mod list, the package.json typecheck, the two test-run scripts, and the generated-types ignore. The `loop-detective` changes currently in progress are preserved.

The Node core tests use Node 22.19.0 or later and the existing loader. Engine verification is based on the installed Claude Code 2.1.292 binary and the types that version generates. The 2.1.280 on the default PATH is not used as a basis for compatibility.

## 6. TDD and Completion Criteria

In each implementation unit, proceed in the order: write the test → confirm failure due to the missing required behavior → minimal implementation → confirm it passes → refactor. Do not report a test that was not run as passing.

1. Commands: verify basic add, check markers, reserved-word escape, multiple lines, edit/delete/explicit check/toggle, input errors, stable IDs, length and count limits, and control-character cleanup.
2. Storage: verify restoration in a new controller of the same identity, isolation of other folders and other sessions, resuming the previous session after clear, save/read failures, and corrupted documents and unsupported versions.
3. Contention: verify adding during load, consecutive toggles, delayed load and save of a previous session, a previous UI callback, and the queue's follow-up work after a failure.
4. Display: verify regular/unchecked/completed, counts, an empty list, Unicode and long memos, widths 0/1/29/30 and heights 0/1/2/3, and preservation of the original with many items.
5. Engine adapter: verify command registration and handling, preservation of the existing `AbovePrompt` tree, yielding to a survey, a real Button press with save and re-render, session transition and reload, and read/write/invalidate failures.
6. Run `npm test`, the engine mod tests, typecheck and plugin validate. Report existing test failures too, together with their names.
7. Record separately whether real terminal and Desktop captures were checked. Do not describe render-tree tests as real screen verification.

## 7. Basis

- Official guide: https://code.claude.com/docs/en/plugins/mods/create
- Local generated types: `AbovePrompt`, `ButtonProps`, `store`, `SessionEndInput`, `session.id` and `session.cwd` in `agent-profiler/.claude-plugin/types/claude-code/index.d.ts`.
- Existing adapter patterns: `context-inspector/hooks/register.tsx`, `loop-detective/hooks/register.tsx`.
- Existing way of running core tests: `scripts/test-core.mjs`, `scripts/core-loader.mjs`.

## 8. Final Verification Record (2026-10-14)

- Following the user's instruction, per-unit commits were kept on main. The temporarily created local `feat/pin-memo` was deleted after the commits were preserved on main.
- `npm test`: 284/284 passed.
- Claude Code 2.1.292 `npm run test:adapters`: 361/361 passed (Pin Memo 29/29).
- `npm run typecheck`, `plugin validate pin-memo`, `git diff --check`: passed.
- Marketplace validation: passed; 1 existing warning about a missing marketplace description.
- After the independent review, the following were fixed with regression tests: new-identity failure / previous-response contention, generation validation of the previous screen's check callback, preservation of backslashes in POSIX paths, and supplementary-plane Unicode width.
- Adding during a store load, and preservation of lifecycle return values and errors, were also verified.
- Real terminal and Desktop pixel capture verification was not performed. It is distinguished from the render-tree and Button press verification results.

- After model-effort-band was integrated into main, the full verification was run again with the latest test runner. The total test counts above include that integration, and Pin Memo itself is 29/29 in the engine.
