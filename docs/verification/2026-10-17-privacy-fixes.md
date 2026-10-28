# Sequential fix record for secret exposure

Basis: items 1–7 of the [audit report](2026-10-17-privacy-audit.md). The reproduction script's `protectedGroups` checks that secrets are absent for the fixed items. Each item was fixed after confirming that its regression test failed, and the independent plugin distribution structure is kept. Files that were already stored or transmitted are not cleaned up retroactively.

| Item | Fix and version | Verification |
|---|---|---|
| 1 | Agent Profiler 0.1.1: search patterns are also subject to the `exportCommandText` opt-in and masking | core 329/329, profiler engine 60/60, TypeScript passed |
| 2 | Time Machine 0.1.1: files that are currently ignored are excluded from the shadow index before staging; restore conflict protection is kept | core 329/329, time-machine engine 98/98, TypeScript and real Git regression check passed |
| 3 | Time Machine 0.1.2: failing test names are masked at the parsing stage to prevent the JSONL bypass | core 330/330, time-machine engine 99/99, TypeScript and storage path regression check passed |
| 4 | Agent Profiler 0.1.2 / Time Machine 0.1.3 / Loop Detective 0.1.1: synchronized the redactor copies for independent distribution, and improved handling of credential options, URLs, and JSON strings and the lossy determination | core 331/331, engines 60/100/41 passed respectively, full TypeScript, shared corpus of 39 and privacy check passed |
| 5 | Agent Profiler 0.1.3 / Time Machine 0.1.4: truncate after masking in collection, result summaries, and rerun comparison | core 333/333, engines 61/101 passed respectively, full TypeScript and privacy check passed |
| 6 | Context Inspector 0.1.2 / Agent Profiler 0.1.4 / Time Machine 0.1.5 / Loop Detective 0.1.2: handling of escaped quotes in shell headers and JSON credential fields, synchronized across the four mods | core 335/335, engines 101/61/101/41 passed respectively, full TypeScript, shared corpus of 68 and privacy check passed |
| 7 | Agent Profiler 0.1.5 / Context Inspector 0.1.3 / Time Machine 0.1.6: truncate after masking in reports, pane, status, advice, and rerun notices, and keep the original text for execution | core 338/338, all engines 443/443 (62+102+103+41+29+56+50), full TypeScript and privacy 20/20 passed |

## Final state

Audit items 1–7 were fixed in order. Each row gives the version and verification result at that point; when a mod was involved in several items, its version was also raised step by step. The final versions are Agent Profiler 0.1.5, Context Inspector 0.1.3, Time Machine 0.1.6, and Loop Detective 0.1.2. The other three mods had no product code changes.

`npm test`, `npm run typecheck`, `npm run test:privacy`, and the full `npm run test:adapters` on Claude Code 2.1.301 passed. The shared masking corpus is 17 × 4 mods = 68 cases, and all 20 reproductions from the original audit confirm that the secrets are absent. The real Git check confirms that the new secret is not recorded in loose objects as well as in the final tree, and that a restore does not overwrite files that are currently ignored. An additional engine check confirms that the actual rerun tool still receives the original input even after the display is masked.

The engine mock that throws an exception message returns the original string replaced with `no implementation`, so it was not evidence of secret masking. The temporary check that depended on that assumption was removed, and the output paths where real exposure was reproduced and the preservation of the rerun input were verified instead. The engine UI render tree tests did not verify real screen captures or transmission to an external OTLP server.

Existing stored files, past shadow Git objects, and opt-in raw model response records are not cleaned up retroactively. The masking covers known formats and does not guarantee detection of every secret. Nothing was published or pushed to GitHub either.
