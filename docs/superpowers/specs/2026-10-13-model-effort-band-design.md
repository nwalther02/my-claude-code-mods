# Model Effort Band — Design Spec

- Written: 2026-10-13 (Asia/Seoul)
- Status: Implementation, automated verification and independent code review completed after user approval.
- Behavior revision: 2026-10-18, keep the last effort across tool calls, waiting and new turns (user request).
- Mod name / location: `model-effort-band` / `model-effort-band/`
- Purpose: Show the current model and the main conversation's effort at a glance above the Claude Code input box.
- Design basis: The green, blue and purple bordered per-model bands the user attached. The `5.5` in the image is an example; the actual model's version is displayed.

## 1. Interpretation of the Request and Choice

The three lines in the image are interpreted as per-model style examples. The actual screen shows only one band, for the current model. No controls for changing the model or effort are added.

Comparison of alternatives:

| Approach | Advantage | Cost |
|---|---|---|
| `AbovePrompt` band above the input box (chosen) | Reproduces the layout and border of the reference image and is visible even before typing | The border takes up two extra rows in the terminal |
| Existing status line | Uses little space | Hard to implement the border and right-hand badge, and it shares its place with other mods' status lines |
| Separate Pane | Easy to hold detailed information | Opening a panel is needed just to check simple status |

## 2. Display Contract

Format on a wide screen:

```text
╭──────────────────────────────────────────────────────────────╮
│ Sonnet 4.6 │ effort ▰▰▱▱▱ medium · normal            Sonnet │
╰──────────────────────────────────────────────────────────────╯
```

The actual number of cells is calculated from the `bodyColumns` the engine provides. The spacing in the diagram above is for illustration.

- Haiku: green `#8ACFA7`, dark background `#17251F`.
- Sonnet: blue `#8BBEF4`, dark background `#192333`.
- Opus: purple `#B99CE5`, dark background `#241C32`.
- Unknown model: gray `#B5BAC4`, dark background `#202329`, badge `Model`.
- `low` → `▰▱▱▱▱`, `quickly`, green.
- `medium` → `▰▰▱▱▱`, `normal`, blue.
- `high` → `▰▰▰▱▱`, `deep`, yellow `#E4CC75`.
- `xhigh` → `▰▰▰▰▱`, `deeper`, yellow.
- `max` → `▰▰▰▰▰`, `maximum`, yellow.
- Numeric effort: show a finite number of 0 or more as it is, and omit the gauge and the level description. Do not arbitrarily grade the meaning of numbers.
- Effort with no observed value to show, or an invalid one: `unknown · not yet confirmed`, no gauge.
- Unknown string effort: the original string, safely sanitized, with no gauge or level description.
- The effort description is wording to help understand the level; it is not a measurement or guarantee of response speed or quality.
- Every model × every effort combination is allowed. Effort is not inferred from the kind of model.

### Model Name Normalization

- `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5-20251001` → `Sonnet 4.6`, `Opus 4.6`, `Haiku 4.5`.
- Older names such as `claude-3-5-sonnet-20241022` are also displayed as `Sonnet 3.5`.
- The aliases `haiku`, `sonnet`, `opus` show only the family name, with no version attached.
- Known Claude IDs with a Bedrock region prefix, an `anthropic.` prefix, a date and a `:vN` suffix also have the family and version extracted.
- A string is not judged to be a Claude model merely because `opus` appears in the middle of it. The family color is applied only to known Claude ID formats and aliases.
- An unknown model is displayed after removing control characters and normalizing whitespace, up to at most 80 Unicode code points. An empty value is `Unknown model`.
- No fixed table or remote lookup that converts a model alias to a specific latest version is used.

### Space and Accessibility

- `bodyColumns >= 60`, `maxRows >= 3`: rounded border, model name, effort gauge, English level and Korean description, and the family badge on the right.
- `30 <= bodyColumns < 60`, `maxRows >= 3`: border, with only the model name and `effort <value>` shown.
- `bodyColumns < 30` or `maxRows < 3`: abbreviated to a single line `model name | effort <value>`. If there is no space, the band is omitted.
- Text is truncated with an ellipsis and does not wrap. The output width does not exceed the area width.
- Hangul is counted as two cells, ASCII and the gauge as one cell. The layout of known model names is calculated exactly, and for arbitrary Unicode names the renderer's ellipsis is used as the final boundary.
- The meaning can be read from the model name and effort string even without color.
- If `hasSurvey === true`, the band is not drawn and `next(e)` is returned as it is.
- The result of `next(e)` from other `AbovePrompt` mods is preserved and this mod's own band is added after it. Coordinating the overall space with other mods is left to the engine.

## 3. Meaning and Lifetime of the Data

The currently selected model is read with `$.session.model()`. The model name can be displayed even before the first request. If this call fails, that render shows `Unknown model` and `unknown` effort and does not reuse the previous model.

The trustworthy input for effort is `e.effort` received from the main conversation's `turn.step`. It is the request value observed at this mod's registered position in the order, and it does not claim to have confirmed rewrites by other mods that run later. The default effort is not inferred by reading the settings values.

State is stored in a single `BandState` instance created for each register call:

- `observeStep({ model, effort, agentId })`: observes only when there is no `agentId`. If effort is omitted for the same model, the existing value is kept, and if a new value (including the number 0) is passed, it is updated. A request for a different model replaces the observed model and effort even if effort is omitted, so the previous model's value does not carry over.
- `reset()`: clears both the observed model and effort.
- `snapshot(selectedModel)`: returns the observed effort only when the strings of the currently selected model and the observed model are the same. If the model alias and the resolved ID differ, it is safely shown as `unknown`.
- Reset on `session.start` and `session.end`. The main `turn.start` only repaints, so the last observed value is kept on the next turn, during tool calls and on the waiting screen. No previous state remains after `/clear`, resume or reload.
- Reset and invalidate on `classic.PostModelSwitch`.
- Reset and invalidate after a successful `config.set`. To avoid depending on a list of setting keys, the observed effort is invalidated on every successful setting change. A rejected change keeps the state.
- After letting `model`, `effort` and `config` of `command.run` pass through, reset and invalidate. Even if the settings UI is canceled, the conservative behavior of effort being `unknown` until the next request is allowed.
- Call `$.ui.invalidate('ui.render')` after a successful session/turn boundary and after observing a main step. No separate timer or polling is used.

If the requested model and the selected model differ because of an automatic fallback, the selected model is displayed and effort is `unknown`. v1 is a selected-model indicator, not an indicator of the actual requested-model history.

## 4. Architecture and Environment

As with the existing mods, the pure TypeScript core and the thin engine adapter are separated.

```text
model-effort-band/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.tsx       # event observation, render composition, failure isolation
  hooks/core/band.ts       # model/effort normalization, observed state, per-width display data
  tests/band.test.ts       # pure core tests runnable in Node and the engine
  tests/adapter.test.ts    # verifies the event and render contract with the real engine test kit
  tsconfig.json
  README.md
  README_KR.md
```

- No new dependencies are added.
- Node core verification: Node 22.19.0 or later, using the existing loader and `expect`.
- Engine verification baseline: the generated types and binary of local Claude Code 2.1.292. The default Mods support floor is 2.1.287, but this mod's API-combination compatibility is documented based on the 2.1.292 verification result.
- `AbovePrompt` support in the terminal and Desktop. The VS Code chat and headless mode have no visual band.
- No process execution, network, file I/O, model calls, prompt modification, settings modification or persistence.
- No settings options or toggle commands are added in v1. It can be disabled from the plugin management screen.

## 5. Failure Handling and Test Criteria

The observation hook does not change events, streams or the final return value. It isolates invalidate failures and lets subsequent events proceed normally. Downstream execution errors propagate as they are, and `next` is not run again after an error. If building the render fails, the downstream tree already obtained is returned.

Completion criteria:

1. Verify the model name format, model/effort combinations, and missing, arbitrary and control-character values with core tests.
2. Verify layout transitions at widths 0/1/29/30/59/60 and row counts 0/1/2/3.
3. Verify subagent isolation, model change, keeping effort when it is omitted for the same model, updating to a new value, keeping across turns, and session reset.
4. Verify with the real engine kit that streaming chunks and the generator's final result are preserved.
5. Verify with the real engine kit survey pass-through, preservation of other mods' trees, lookup and invalidate failures, and rejection of setting changes.
6. Run `npm test`, the engine mod tests, typecheck and plugin validate. Report existing test failures too, without omission.
7. Distinguish in the documentation and the completion report whether real captures of the terminal and Desktop were verified. Do not claim screen verification from render-tree tests alone.
8. Commit in units of design/plan, core, adapter and install integration, and do not include the existing `loop-detective` work.

## 6. Basis and Current Baseline

- Official guide: https://code.claude.com/docs/en/plugins/mods/create
- Official API reference: https://code.claude.com/docs/en/plugins/mods/reference
- Local basis: `TurnStepInput`, `AbovePrompt`, `session.model`, `config.set`, `PostModelSwitch` and `BoxProps` in `agent-profiler/.claude-plugin/types/claude-code/index.d.ts`.
- `npm test` before implementation: 199 passed, 0 failed (2026-10-13).
- Current default `claude`: 2.1.280. For verification, the 2.1.292 binary of the installed VS Code extension is used explicitly.

## 7. Implementation Verification Record (2026-10-14)

- Feature branch: `feat/model-effort-band`. It was implemented in a separate worktree to protect work in progress.
- TDD: The empty core implementation was run with 38 tests to confirm assertion failures from the missing functionality, and then implemented. For the adapter, the failure of the display tests was confirmed with an empty register. Reload initialization and text-adjacent placement were additionally verified with RED→GREEN regression tests that removed/reproduced the defects.
- Core tests: 237 in total (including 38 for the new mod), 0 failed. All 237 also passed on Node 22.19.0.
- Engine tests: 291 in total on 2.1.292 (59 + 78 + 98 + 56 for the new mod), 0 failed.
- Typecheck of all mods and plugin validate of the new mod passed.
- Real screen: stopped at the CLI's working-folder trust confirmation step. The trust setting was not changed, and the real terminal pixels and Desktop screen are unverified.
- Plan correction: in 2.1.292, `turn.start` is a main-turn event without an `agentId`, so it is reset unconditionally. Downstream hook errors are converted into `HooksError` by the engine, so failure propagation and a single execution are verified instead of the original error string.

### Final Code Review

- Independent reviewer result: Critical 0, Important 0. The 38 new core tests were run separately and all passed.
- Minor documentation finding: the wording that all render failures were verified was narrowed to the model lookup and screen refresh failures that are actually tested. There are no dedicated tests for the `ui.resolve`/element creation failure branch or for a downstream `ui.render` rejection.
- The real terminal and Desktop pixels, arbitrary Unicode ellipsis, and screens where several mods are displayed at the same time are unverified. The width limit, ellipsis, tree preservation and scrolling contracts guaranteed by the code and the engine types are used, and will be reassessed when the real screen is checked.
- The final branch is preserved in `feat/model-effort-band`. Integration into `main`, where other work is in progress, and the remote push are done after a separate choice.

## 8. Effort Retention Fix (2026-10-18)

- Reproduction: omitting effort for the same model cleared the existing value, and a reset also occurred at the start of a new turn, so `unknown` was shown until the next observation.
- Fix: when effort is omitted for the same model, the last value is kept, and no reset occurs at turn start. The resets on session, model and settings changes and the subagent isolation are kept.
- TDD: confirmed that 2 core regressions and 2 adapter regressions fail on the existing implementation. After the fix, all 40 core tests of the new mod and 59 Claude Code 2.1.301 engine tests passed.
- The full `npm test` of 442, the full typecheck and plugin validate also passed. Instead of a live screen capture, the behavior of the state waiting on tool execution, the idle display and retention on the next turn was verified in the engine render tree.
