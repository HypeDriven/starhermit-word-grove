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
| `tests/e2e.mjs` | not present |
| `.devtools/smoke.mjs` (headless Chrome) | PASS — 19 checks, 0 failures, no console errors |

The smoke script hard-codes port 8137; it was copied to a scratch directory and re-pointed at port
39702 from the assigned range so it would not collide. Game source was not modified. Direct API
probes used port 39703.

## Confirmed defects

### 1. Undo discards the entire undo stack — only one undo is ever possible

- **File:** `js/rules.js:256-267` (`dispatch`, `case 'undo'`) with `js/rules.js:297-302`
  (`snapshotForUndo`)
- **Trigger:** In any mode with `allowUndo` (Practice, Learn/tutorial), make three scoring moves and
  press undo twice.
- **Behaviour:** `snapshotForUndo` deliberately blanks the stack (`s.undoStack = []`) before the
  snapshot is stringified. On undo, that blank array is copied straight back over the live stack:

  ```js
  const snap = JSON.parse(state.undoStack.pop());
  const restored = Object.assign(structuredClone(state), snap);   // snap.undoStack === []
  ```

  The remaining history is destroyed. The second undo returns `nothing-to-undo` and
  `legalActions().canUndo` flips to `false`, so `js/ui.js:225` greys the button out.
- **Expected:** The 50-entry cap at `js/rules.js:148` and the per-action `pushUndo()` show
  multi-level undo is intended. spec.md §2 Modes — "Practice: selectable difficulty, restart, undo
  where rules permit".
- **Evidence:**

  ```
  submit led    ok=true  undoStack=1  canUndo=true
  submit lie    ok=true  undoStack=2  canUndo=true
  submit idea   ok=true  undoStack=3  canUndo=true
  undo #1       ok=true  undoStack=0  canUndo=false
  undo #2       ok=false reason=nothing-to-undo
  undo #3       ok=false reason=nothing-to-undo
  ```

### 2. The authoritative validator accepts a replay with the `tick` commands removed, paying the full speed bonus

- **File:** `js/session.js:172-191` (`verifyReplay`), `js/rules.js:158-169` (`case 'tick'`),
  `js/rules.js:196-198` (`timeBonus`)
- **Trigger:** Play a timed challenge honestly, then strip every `{type:'tick'}` entry from
  `replay.commands` and recompute the terminal hash before submitting.
- **Behaviour:** `elapsedTicks` advances *only* on replayed `tick` commands, and those commands come
  from the client. Nothing binds the tick count to `replay.startedAt`, to wall-clock, or to the
  number of player commands. With the ticks gone, `elapsedSeconds(state)` is 0 and

  ```js
  state.score.timeBonus += Math.max(0, Math.round((timeLimitSec - elapsedSeconds(state)) * 2));
  ```

  pays the maximum. `validateScoreSubmission` recomputes the score from the same tick-free replay,
  so `result.score === score` holds and the submission is accepted.
- **Expected:** spec.md §5 — "Treat client clocks, scores, inventories, roles, physics outcomes, and
  completion claims as untrusted in competitive contexts." `challenge:*` levels are `ranked = true`
  (`js/content.js:312`).
- **Evidence:** `challenge:swift-1` (120 s limit), the same five target words either way:

  ```
  honest: elapsedSec = 110  score = 510  (timeBonus  20)
  forged: elapsedSec =   0  score = 730  (timeBonus 240)
  honest -> {"ok":true,"score":510,"hash":"6ba12e23"}
  forged -> {"ok":true,"score":730,"hash":"c4e070d5"}
  ```

### 3. Leaderboard rows hard-code `completed: true` and `invalidCount: 0`, and read elapsed time from the client

- **File:** `server.js:84-91`
- **Trigger:** Submit any validated replay of a run that was abandoned or that failed on the clock.
- **Behaviour:** The row written to the board is

  ```js
  { name, score: result.score, completed: true, invalidCount: 0,
    elapsedSec: payload.durationSec || 0, sessionId: String(payload.replay.commands[0]?.id || ...) }
  ```

  The replayed state knows the real `status`, `invalidCount` and `elapsedTicks`, but none of them
  are read. `compareResults` (`js/rules.js:114`) orders by completion, then score, then
  `invalidCount`, then `elapsedSec` — with two of those four fields pinned to constants and the
  third supplied by the client, three quarters of the spec's ordering rule is inert, and a submitter
  who omits `durationSec` wins every remaining tie.
- **Expected:** spec.md §2 — "Ties use, in order: primary objective completion, fewer invalid
  actions, lower authoritative elapsed time, then stable session identifier."
- **Evidence:** a run that submitted two junk words, planted one target, then abandoned:

  ```
  true run:     status = failed  completed = false  invalidCount = 2  score = 60
  submit ->     [200, {"ok":true,"rank":1}]
  board entry:  {"name":"quitter","score":60,"completed":true,"invalidCount":0,
                 "elapsedSec":0,"sessionId":"quitter:0:0"}
  ```

### 4. The rank returned to the submitter is the rank of the first entry sharing their score

- **File:** `server.js:95`
- **Trigger:** Three players finish the same board with the same score.
- **Behaviour:** `b.entries.findIndex((e) => e.score === result.score) + 1` matches on score, not on
  the submitter's own row, so every tied player is told they are first. (If the new entry is pushed
  past the 100-row cut, `findIndex` returns `-1` and the response reports `rank: 0`.)
- **Expected:** The rank reported should be the position of the row that was just inserted.
- **Evidence:**

  ```
  alice score 60 -> {"ok":true,"rank":1}
  bob   score 60 -> {"ok":true,"rank":1}
  carol score 60 -> {"ok":true,"rank":1}
  board: 1. alice 60 | 2. bob 60 | 3. carol 60
  ```

### 5. `verifyReplay` contains an empty `if` body — the engine-rejection check does nothing

- **File:** `js/session.js:179-185`
- **Trigger:** Always; this is dead validation.
- **Behaviour:** The block is written as

  ```js
  if (!ok && cmd.type !== 'tick' && !['too-short','letters-unavailable','already-found','unknown-word'].includes(next.lastError)) {
    // Invalid player inputs are legitimate log entries; engine-level rejections are not.
  }
  ```

  The condition is fully evaluated and then nothing happens. The comment states the intent
  ("engine-level rejections are not [legitimate]") but no `return { ok: false, ... }` was ever
  written, so a replay containing commands the engine rejects at the engine level — `not-active`,
  `malformed-word`, `out-of-moves`, `shuffle-disabled`, `undo-disabled`, `unknown-command` — passes
  validation unchallenged.
- **Expected:** spec.md §5 — "Validate all network input for identity, session membership,
  turn/tick, bounds, rate, payload size, and legal action."
- **Evidence:** the source above; there is no statement between the braces.

### 6. Undo rewinds the monotonic tick counter and the authoritative clock

- **File:** `js/rules.js:256-267` (`case 'undo'`)
- **Trigger:** Play for 30 s, submit a word, play another 30 s, press undo.
- **Behaviour:** The undo snapshot is the *whole* pre-command state, so `tick` and `elapsedTicks`
  are restored along with the score — 30 seconds of real play vanish from the clock. Repeated
  submit/undo cycles hold `elapsedSeconds` arbitrarily low.
- **Expected:** spec.md §2 — the engine "must expose ... a monotonically increasing turn/tick
  number". A tick counter that moves backwards is not monotonic, and the same rewind would defeat
  `timeLimitSec` termination and inflate `timeBonus`.
- **Evidence:**

  ```
  t=30s   elapsedSec = 30
  after 60 s, submissions = 1, elapsedSec = 60   (state.tick = 601)
  after undo  elapsedSec = 30                    (state.tick = 300)
  ```

  Impact today is limited because no shipped mode combines `allowUndo` with `timeLimitSec`
  (`js/content.js:216, 243, 272, 302, 327`) and undo modes are unranked — but the state transition
  itself is wrong and the guard is one content edit away from mattering.

### 7. Score submission is not idempotent — the same run can be replayed onto the board indefinitely

- **File:** `server.js:83-94`
- **Trigger:** POST the identical valid payload to `/api/v1/scores` several times.
- **Behaviour:** `b.entries.push(...)` runs unconditionally; nothing checks whether a row with the
  same `sessionId` (or replay hash) already exists. One legitimate run can be used to occupy every
  slot on a board.
- **Expected:** spec.md §5 — "Reject duplicates idempotently by command ID." (Vanishing Cubes
  implements exactly this check at `server.js:327-334`.)
- **Evidence:** four byte-identical submissions of one completed `challenge:swift-1` run:

  ```
  identical submission #1 -> {"ok":true,"rank":1}
  identical submission #2 -> {"ok":true,"rank":1}
  identical submission #3 -> {"ok":true,"rank":1}
  identical submission #4 -> {"ok":true,"rank":1}
  board rows: 4   spammer/dupe:0:0  spammer/dupe:0:0  spammer/dupe:0:0  spammer/dupe:0:0
  ```

### 8. The shipping server serves the design document

- **File:** `server.js:57-62` (`MIME` includes `.md`), `server.js:120-138`
- **Trigger:** `GET /spec.md`
- **Behaviour:** Returns 200 with the full product specification as `text/markdown`.
- **Expected:** spec.md §6 — "Keep source files, secrets, design documents, and source maps outside
  the uploaded distribution." (The sibling game Vanishing Cubes explicitly blocks this and has a
  smoke assertion for it.)
- **Evidence:** `GET /spec.md -> 200  "# Word Grove — Product and Game Specification …"`

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
