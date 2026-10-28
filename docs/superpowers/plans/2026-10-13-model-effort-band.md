# Model Effort Band Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. No per-task subagent delegation is needed.

**Goal:** Show the currently selected model and the observed main effort as a band above the input box, as in the reference image.

**Architecture:** A pure core builds the display data and state. An adapter connects the engine's model lookup and request events and renders them together with other mods' trees. The install integration extends the existing marketplace and test runner.

**Tech Stack:** TypeScript/TSX, Claude Code 2.1.292 Mods API, Node 22.19.0, existing engine testing/Node loader. No new packages.

**Spec:** `docs/superpowers/specs/2026-10-13-model-effort-band-design.md`

**Status:** Tasks 1–3 implemented, verified and independently code-reviewed after user approval. Preserved on the feature branch.

## Global Constraints

- No new dependencies are added.
- `AbovePrompt` support in the terminal and Desktop. The VS Code chat and headless mode have no visual band.
- No process execution, network, file I/O, model calls, prompt modification, settings modification or persistence.
- No settings options or toggle commands are added in v1.
- Every model × every effort combination is allowed. Effort is not inferred from the kind of model.
- Do not change the existing `loop-detective` files and uncommitted documents, and do not include them in commits.

## Review Focus

1. Aliases, legacy IDs and Bedrock IDs extract the version exactly, and arbitrary names do not cause the family to be misjudged.
2. After a missing effort, a different model or a reset, the previous effort is not shown.
3. A subagent's step does not affect the main state.
4. On narrow screens, with too few rows, and with a survey, the input area and other mods' trees are preserved.
5. On downstream failure, lookup failure or settings rejection, execution is not repeated and no wrong state is shown.

## Execution Preparation

- [x] Review and finalize the display meaning, layout and scope of the spec.
- [x] Finalize the work isolation method. When using a worktree, do not move the original uncommitted files. When using the same checkout, create a feature branch and stage by path.
- [x] Re-confirm the baseline with `npm test`. At the time of writing, 199 passed.
- [x] Record the RED/GREEN commands, results and commit hash of each unit in the log.

## Task 1: Pure Core — Display Data and Observed State

**Files:** `model-effort-band/hooks/core/band.ts`, `model-effort-band/tests/band.test.ts`

**Interfaces:**

```ts
export type Family = 'haiku' | 'sonnet' | 'opus' | 'unknown'
export type ModelView = { name: string; family: Family; badge: string; color: string; background: string }
export type EffortView = { value: string; meter: string; description: string; color: string }
export type BandView = { model: ModelView; effort: EffortView; layout: 'full' | 'compact' | 'inline' | 'hidden' }
export function modelView(model: unknown): ModelView
export function effortView(effort: unknown): EffortView
export function bandView(model: unknown, effort: unknown, columns: number, rows: number): BandView
export class BandState {
  observeStep(step: { model: string; effort?: unknown; agentId?: string }): void
  reset(): void
  snapshot(selectedModel: string): { model: string; effort: unknown }
}
```

- [x] **RED: Write the normalization and state tests first.** Wrong family extraction, keeping the previous effort, and a subagent overwriting state must each make a test fail. Keep the expected values as hand-written literals.

```ts
import { expect, test } from 'claude-code/testing'
import { BandState, bandView, effortView, modelView } from '../hooks/core/band.ts'

test('extracts current and legacy model versions without inventing alias versions', () => {
  expect(modelView('claude-sonnet-4-6').name).toBe('Sonnet 4.6')
  expect(modelView('claude-haiku-4-5-20251001').name).toBe('Haiku 4.5')
  expect(modelView('claude-3-5-sonnet-20241022').name).toBe('Sonnet 3.5')
  expect(modelView('us.anthropic.claude-opus-4-6-v1:0').name).toBe('Opus 4.6')
  expect(modelView('opus').name).toBe('Opus')
  expect(modelView('my-opus-proxy').family).toBe('unknown')
})

test('unknown inputs cannot leak terminal control characters', () => {
  expect(modelView('\u001b[31mcustom\nmodel').name).not.toContain('\u001b')
  expect(modelView('').name).toBe('Unknown model')
  expect(effortView(Number.NaN).value).toBe('unknown')
  expect(effortView(-1).value).toBe('unknown')
  expect(effortView(42).value).toBe('42')
  expect(effortView(42).meter).toBe('')
})

test('effort comes from the main request and is cleared when absent or changed', () => {
  const state = new BandState()
  state.observeStep({ model: 'opus', effort: 'low' })
  state.observeStep({ model: 'haiku', effort: 'max', agentId: 'a1' })
  expect(state.snapshot('opus').effort).toBe('low')
  expect(state.snapshot('sonnet').effort).toBeUndefined()
  state.observeStep({ model: 'opus' })
  expect(state.snapshot('opus').effort).toBeUndefined()
  state.observeStep({ model: 'opus', effort: 'high' })
  state.reset()
  expect(state.snapshot('opus').effort).toBeUndefined()
})

test('layout respects body width and rows', () => {
  expect(bandView('opus', 'high', 60, 3).layout).toBe('full')
  expect(bandView('opus', 'high', 59, 3).layout).toBe('compact')
  expect(bandView('opus', 'high', 30, 3).layout).toBe('compact')
  expect(bandView('opus', 'high', 29, 3).layout).toBe('inline')
  expect(bandView('opus', 'high', 60, 2).layout).toBe('inline')
  expect(bandView('opus', 'high', 1, 1).layout).toBe('inline')
  expect(bandView('opus', 'high', 0, 3).layout).toBe('hidden')
  expect(bandView('opus', 'high', 60, 0).layout).toBe('hidden')
})
```

- [x] After running the command, confirm that it fails because the new functionality is missing:

```sh
node --experimental-transform-types --import ./scripts/core-loader.mjs --test model-effort-band/tests/band.test.ts
```

- [x] **GREEN:** In `modelView`, implement a regular expression that allows only known Claude ID formats, and control-character cleanup. `effortView` converts only the spec's five strings into a gauge. `BandState` keeps a single observed value per register and returns effort only on a strict model string match.
- [x] Repeat the same RED→GREEN cycle for each model family × five efforts, an unobserved value, a future effort string, the 80-character limit, `NaN`/infinite widths, and the boundaries of numeric effort. Non-finite widths and row counts are normalized to 0.
- [x] Once green, extract the duplicated display-string cleanup logic and run the tests again.
- [x] Also run the whole existing `npm test`, then commit the core unit:

```sh
git add model-effort-band/hooks/core/band.ts model-effort-band/tests/band.test.ts
git commit -m "feat(model-effort-band): normalize model and effort display state"
```

## Task 2: Engine Adapter — Transparent Observation and a Responsive Band

**Files:** `model-effort-band/hooks/register.tsx`, `hooks/hooks.json`, `.claude-plugin/plugin.json`, `tsconfig.json`, `tests/adapter.test.ts`, `.gitignore`

**Consumes:** `BandState` and `bandView` from Task 1.

**Produces:** `export const register: Register` and an installable standalone mod.

- [x] Write the manifest needed to run the tests (`name: model-effort-band`, `version: 0.1.0`, no settings), `modules: ["./register.tsx"]`, and a tsconfig identical to the existing mods. Add the generated types directory to `.gitignore`. Do not write product code yet.
- [x] **RED:** Verify the main behaviors below with the real `claude-code/testing`. The render fixture fills all `AbovePrompt` props of the 2.1.292 generated types. Do not create incomplete fixtures that bypass type checking.

```ts
import { expect, test } from 'claude-code/testing'

test('wraps downstream AbovePrompt content instead of replacing it', async ($, on) => {
  on('session.model', () => ({ value: 'claude-opus-4-6' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['other-mod'] }))
  const render = await $.ui.render({
    component: 'AbovePrompt', surface: 'terminal', requestId: 'band',
    viewport: { columns: 100, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 95,
      scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  const content = JSON.stringify(render)
  expect(content).toContain('other-mod')
  expect(content).toContain('Opus 4.6')
  expect(content).toContain('unknown')
})
```

This fixture was written based on `RenderInputOf`, `SiteScroll` and `SiteView` in the local 2.1.292 declarations. Mismatches are discovered using the engine-generated types and are not hidden with `as never`.

- [x] Run the test and confirm the assertion failure “there is no band”. Use only an empty `register` for the first module discovery.

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 /Users/ywsung/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude plugin test model-effort-band
```

- [x] **GREEN:** Create the state inside `register`. The lifecycle/step hooks call `next(e)` only once. A full pass-through of a step uses `return yield* next(e)`. After receiving the result of a model/config change, clear the state, and isolate an invalidate failure as an observation failure.

```ts
const state = new BandState()
on('turn.step', async function* ($, e, next) {
  if (e.agentId === undefined) {
    state.observeStep(e)
    try { $.ui.invalidate('ui.render') } catch { /* repaint unavailable */ }
  }
  return yield* next(e)
})
```

- [x] `AbovePrompt` first obtains the downstream tree. If it is a survey, it is returned as it is. Otherwise, build the display data with `$.session.model()` and add the band after the existing tree using Box/Text from `$.ui.resolve(e)`. Full uses a round border, compact omits the description and badge, and inline has no border. Line wrapping is prevented with the Text's `wrap="truncate-end"`.
- [x] Make each additional test fail first: survey tree preservation, no display at 0 width/0 rows, effort unchanged after a subagent step, unknown after a model change, unknown after a missing effort, session.end/turn.start reset, state kept when a setting is rejected, unknown when session.model is rejected, next called once on an invalidate failure, a downstream throw propagated once.
- [x] The stream fixture returns `thinking`/`text`/`stop` and a final `TurnStepResult`. On the consuming side, call `.next()` step by step and also compare the value of the last `done: true`. The final return value cannot be verified with `for await` alone.
- [x] Verify the returned tree for repeated renders and for the terminal/desktop surfaces. Check that the color, border and key strings are included and that downstream siblings remain.
- [x] Generate the target engine's types and run `tsc`/validate and the core suite. Commit after resolving failures:

```sh
./node_modules/.bin/tsc -p model-effort-band
/Users/ywsung/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude plugin validate model-effort-band
npm test
git add .gitignore model-effort-band
git commit -m "feat(model-effort-band): render live model and effort above prompt"
```

## Task 3: Installation and Verification Path

**Files:** `.claude-plugin/marketplace.json`, `scripts/test-core.mjs`, `scripts/test-adapters.mjs`, `package.json`, `README.md`, `model-effort-band/README.md`, `model-effort-band/README_KR.md`

- [x] Before adding it to the core runner's mod list, confirm that the new suite is not counted. After adding it, confirm that the new suite runs in the actual `npm test` output. Do not create source-string-matching tests.
- [x] Add `model-effort-band` to the mod lists and typecheck commands of both runners and add an entry to the marketplace:

```json
{
  "name": "model-effort-band",
  "source": "./model-effort-band",
  "description": "Shows the selected model and observed main-thread effort in a colored band above the prompt"
}
```

- [x] In the English/Korean README, record installation, local loading, per-model preview, the meaning of effort observation, the initial unknown, narrow widths, survey, surface limits, alias/resolved ID mismatch, and the 2.1.292 verification binary.
- [x] Installation example (repository name confirmed from the existing README and the git remote):

```text
/plugin marketplace add YeonwooSung/my-claude-code-mods
/plugin install model-effort-band@my-claude-code-mods
```

- [x] Local loading is `claude --plugin-dir ./model-effort-band`. In an environment where the default binary is 2.1.280, specify the verification binary explicitly.
- [x] Run the whole core suite, the existing and new engine suites, the whole typecheck, and plugin validate:

```sh
npm test
CLAUDE_BIN=/Users/ywsung/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude npm run test:adapters
npm run typecheck
/Users/ywsung/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude plugin validate model-effort-band
git diff --check
```

- [x] If the interactive UI is available, check the three model kinds, each effort level, width changes, survey and use together with other mods on the real screen. If Desktop cannot be reached, record it as unverified.
- [x] Check each item of the spec against the implementation, tests and known constraints. Fix omissions, and prove behavior changes with RED→GREEN.
- [x] Commit the integration unit, and report the commit history, the test results and whether the real screen was verified to the user. Do not push.

```sh
git add .claude-plugin/marketplace.json scripts/test-core.mjs scripts/test-adapters.mjs package.json README.md model-effort-band/README.md model-effort-band/README_KR.md
git commit -m "docs(model-effort-band): register mod and document installation"
```
