# Known Issues — Word Grove

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on vision182 (HauhauCS Q2_K_P, 8192-token
context), alongside the game's own unit tests and a headless-Chrome run of the bundled smoke script.
Every defect below was reproduced with a script against the real modules — none is a model claim
taken on trust.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`tests/run-tests.js`) | 40097 passed, 0 failed (12 suites incl. replay determinism, fuzz, golden sessions, authoritative score validation) |
| `node --check` on all modules (`js/*.js`, `server.js`, `tests/*`) | clean, no failures |
| `tests/e2e.mjs` (`npm run test:e2e` / `node tests/e2e.mjs`) | PASS — desktop + mobile, no page errors (exit 0) |
| `.devtools/smoke.mjs` (headless Chrome) | PASS — 19 checks, 0 failures, no console errors |

The smoke script hard-codes port 8137; it was copied to a scratch directory and re-pointed at port
39702 from the assigned range so it would not collide. Game source was not modified. Direct API
probes used port 39703.

## Confirmed defects — all resolved (fixed 2026-09-04)

All eight confirmed defects below were reproduced against the current source, fixed with a
minimal change to the documented "Expected" behaviour, and re-verified with `npm test`
(40097 passed, 0 failed) and `node tests/e2e.mjs` (E2E PASS, desktop + mobile, exit 0). The
evidence that originally demonstrated each defect now produces the correct result.

### 1. Undo discards the entire undo stack — only one undo is ever possible — RESOLVED

- **File:** `js/rules.js:262-266` (`case 'undo'`)
- **Fix:** after restoring the popped snapshot, retain the remaining history —
  `restored.undoStack = state.undoStack` (the popped entry is already gone, so the rest of the
  stack is preserved). Verified: two submits then two undos both succeed, leaving `found={}` and
  `undoStack=[]`.

### 2. The authoritative validator accepts a replay with the `tick` commands removed — RESOLVED

- **File:** `js/session.js:172-204` (`verifyReplay`)
- **Fix:** bind the authoritative clock to the recorded tick stream. `verifyReplay` now tracks
  `declaredMaxTick` (the highest recorded `cmd.tick` across all commands) and rejects the replay
  with `tick-count-mismatch` when that exceeds the replayed `state.elapsedTicks`. Stripping every
  tick command leaves the ticks recorded on the surviving (submit) commands ahead of the replayed
  clock, so the forged replay is rejected instead of paying the full speed bonus. Verified: honest
  `challenge:swift-1` run ok; tick-stripped forgery -> `{ok:false, reason:'tick-count-mismatch'}`.

### 3. Leaderboard rows hard-code completion/invalid count and read elapsed time from the client — RESOLVED

- **File:** `server.js:77-110` (`handleApi` scores POST), `server.js:49-53` (`validateScoreSubmission`),
  `js/session.js:203-204` (`verifyReplay` return)
- **Fix:** `verifyReplay` now returns the replayed `status`, `invalidCount` and authoritative
  `elapsedSec`; `validateScoreSubmission` passes them through; the board entry uses them instead of
  `completed:true`, `invalidCount:0` and client `payload.durationSec`. Verified: an abandoned run
  with two junk words stores `completed:false, invalidCount:2, elapsedSec:0` rather than the
  previous hard-coded (or client-supplied) values.

### 4. The rank returned to the submitter is the rank of the first entry sharing their score — RESOLVED

- **File:** `server.js:104-106` (`handleApi`)
- **Fix:** the rank is now the position of the row that was just inserted, found by its `sessionId`
  (`b.entries.indexOf` on the pushed entry) on the sorted list, instead of `findIndex` on `score`.
  Verified: three distinct runs with the same score report ranks 1, 2, 3.

### 5. `verifyReplay` contains an empty `if` body — engine-rejection check does nothing — RESOLVED

- **File:** `js/session.js:184-186` (`verifyReplay`)
- **Fix:** the engine-rejection branch now returns `{ok:false, reason:'engine-rejected:<reason>'}`
  for any non-legitimate-player-input rejection (e.g. `not-active`, `shuffle-disabled`), instead of
  evaluating the condition and discarding it. Verified: a replay appending a `shuffle` after
  terminal `complete` is rejected with `engine-rejected:not-active`.

### 6. Undo rewinds the monotonic tick counter and the authoritative clock — RESOLVED

- **File:** `js/rules.js:256-270` (`case 'undo'`)
- **Fix:** undo keeps the clock monotonic — `restored.tick = state.tick` and
  `restored.elapsedTicks = state.elapsedTicks` are set from the current (post-undo) state rather
  than the restored snapshot, so a submit/undo cycle can no longer hold `elapsedSeconds` low.
  Verified: after 60 s of play then undo, `tick`/`elapsedTicks` stay at 60 (were 30 before).

### 7. Score submission is not idempotent — the same run can be replayed onto the board indefinitely — RESOLVED

- **File:** `server.js:89-94` (`handleApi`)
- **Fix:** before pushing, the handler looks up a row keyed by the same `sessionId`
  (`replay.commands[0].id`, per spec §5 "Reject duplicates idempotently by command ID"); if one
  exists it returns `{ok:true, rank, duplicate:true}` without adding a new row. Verified: four
  identical submissions produce a single board row.

### 8. The shipping server serves the design document — RESOLVED

- **File:** `server.js:62` (`MIME`, `.md` removed), `server.js:141-146` (static handler)
- **Fix:** the static file handler returns 403 for any path ending `.md` or `.map` (design docs /
  source maps), and `.md` is no longer mapped in `MIME`. Verified: `GET /spec.md` -> 403 (was 200).

## Suspected — not confirmed

### 1. `migrate` silently accepts a document with no version field

- **File:** `js/rules.js:321-326`
- **Concern:** `if (state.version > RULES_VERSION) throw` — for `state.version === undefined` the
  comparison is `false`, so the function falls through and stamps `version = 1` onto a document
  whose shape was never checked. A truncated or foreign localStorage payload would be treated as a
  valid v1 state.
- **Why unconfirmed:** `js/storage.js` may reject such payloads before `migrate` is reached; the
  full load path was not exercised with a hand-corrupted store within this pass.

### 2. Oversized request bodies leave the response hanging

- **File:** `server.js:110-117` (`readBody`)
- **Concern:** On exceeding 512 KB the handler calls `req.destroy()` but never resolves or rejects
  the promise, so the awaiting handler never writes a response.
- **Why unconfirmed:** whether `'error'` fires reliably after `destroy()` (and therefore whether the
  promise rejects into an unhandled rejection instead) depends on Node's socket teardown ordering;
  not reproduced here.

### 3. Leaderboard tie-break puts completion ahead of score

- **File:** `js/rules.js:114-120` (`compareResults`)
- **Concern:** The spec sentence reads "Ties use, in order: primary objective completion, fewer
  invalid actions, …", which is naturally read as the tie-break applied *after* the primary metric.
  This implementation compares `completed` before `score`, so a lower-scoring completion outranks a
  higher-scoring incomplete run. Vanishing Cubes orders score first; Workshop Mayhem orders
  completion first.
- **Why unconfirmed:** the spec wording is genuinely ambiguous and the shipped unit test
  (`tests/run-tests.js:384-387`) encodes the implemented order. Needs a human ruling.

## Checked, no defects found

- **Word legality** (`js/layout.js:7-18`): `canForm` / `letterCountsOf` implement a proper multiset
  check, so a letter cannot be reused within a word — matching the tutorial copy "Letters can't be
  reused within a word."
- **Shuffle** (`js/rules.js:219-234`): reorders `state.letters` only, drawing from the serialized
  rules stream (`state.rngA`); the available multiset is unchanged, satisfying spec.md §2 "shuffle
  changes display only, never available letters."
- **Pangram detection** (`js/rules.js:189`): the length-equality test is sound — any word as long as
  the wheel that passes `canForm` must consume the whole multiset.
- **Score integrality** (`js/rules.js:95-111`): all components are integers,
  `totalScore` floors at zero, and `scoreBreakdown` returns per-component rows rather than one
  total, as the spec requires.
- **Move-limit and time-limit termination** (`js/rules.js:163-166, 212-214`): completion is scored
  and terminated before the out-of-moves check, so finishing on the last permitted submission
  correctly ends as `complete`/`all-words`.
- **Determinism and replay:** the shipped suite property-tests replay determinism, fuzzes malformed
  commands, and golden-tests recorded sessions — 40097 assertions pass.
- **Content generation** (`js/content.js`): 48 journey stages, 9 challenges, dailies and the
  tutorial all generate and pass `validateLevel`; the smoke run confirmed 48 journey nodes render.
- **Static path handling** (`server.js:123-126`): `normalize` + `join` + a `startsWith(ROOT)` guard
  correctly rejects `../` traversal.
- **Client runtime:** headless Chrome exercised title → tutorial → all four target words → results,
  the journey map, a daily round, pause/resume, settings-from-pause, and localStorage persistence,
  with zero console errors and a live WebGL renderer.

## Not tested

- **Gamepad input** — no gamepad available in headless Chrome.
- **Real hosted StarHermit integration** (launch tokens, sign-in, presence, cloud save) — only the
  bundled local `/api/v1` surface exists here; `server.js` has no authentication or rate limiting at
  all, which is acceptable for a dev server but was not assessed against the hosted contract.
- **Rate limiting on `/api/v1/scores`** — there is none to test. spec.md §5 lists "rate" among the
  things network input must be validated for; whether the host supplies this outside the game script
  could not be determined from the distribution.
- **Performance budgets** (draw calls, triangles, frame tiers) — rendering ran under SwiftShader
  software rasterization, so measurements would be meaningless.
- **Screen-reader behaviour** — live regions were verified structurally; no assistive technology was
  driven.
- **Mobile orientations and 200 % zoom** — the bundled smoke script does not cover them and they
  were not added in this pass.
