# Word Grove — specification

Word Grove is a solo word puzzle: drag across a wheel of 5–7 letters (or type them) to spell words of three or more letters. Words on the compact crossword grid plant themselves and grow a flower in a 3D grove; other real words are bonus words. It is a StarHermit engine script game (engine 1.24.0, `engine.minor=24`) played natively by the StarHermit client and in browsers by the engine's web runtime.

## Rules

- A word uses each wheel letter at most once. Words shorter than 3 letters, words the wheel can't spell, words already found and words outside the dictionary are refused with a reason (invalid tries count against Challenge move limits).
- Grid words score 20 + 10 × length; a word using every letter adds 50; bonus words score 5 × length. Finishing the grid adds 100 + 10 × the word count, plus 15 per spared try (move limits) and 2 per second left (time limits). Each hint reveals one hidden grid letter and costs 25. The total never drops below 0, and the results list every part.
- Shuffle only rearranges the wheel's look (a seeded rules stream). Undo exists in Practice and the lesson.
- The rules run on a fixed 10 Hz clock (`js/rules.js`, `js/session.js`), advanced by the runtime's fixed steps while the round shows, so rounds replay exactly.

## Modes and content

- **Learn**: a seven-step lesson bar over the lesson grove; steps wait for the action they teach (select, plant a word, a refused word, shuffle, hint). Finishing it (or Skip) marks the lesson done.
- **Journey**: six groves × eight stages (stage 8 of each grove is a mastery stage with a bigger wheel); stars: 1 for finishing, +1 at or above par, +1 without hints. Stages unlock in order.
- **Daily**: one grove per UTC day, from the platform clock (`serverNow()`; the device's UTC date offline). Difficulty rotates over four days.
- **Practice**: Easy / Medium / Hard / Expert, a fresh seed each time, undo allowed, unranked.
- **Challenge**: nine fixed stages with move limits, time limits, no shuffle, no hints, or all of these.
- **Score chase**: type any seed (or take a random one) to play the grove it grows; a friend with the same seed plays the same grove. Results go to a local chase board for that seed.
- Content is generated deterministically from seeds (`js/content.js`, dictionary `js/dictionary.js`). The fixed content (48 Journey stages, the challenges, the lesson) is generated offline into `js/levels.js` (`npm run levels`; `tests/content.test.mjs` checks it against the generator). Daily, Practice and Score chase groves are generated when played, on a script worker (`native/gen-worker.js`, which also builds the round's bonus-word pool); a "Growing the grove…" line shows when that takes over 300 ms (measured natively: Daily ≈ 0.75 s on first use including the worker's dictionary load, Practice 0.15–0.25 s, fixed content < 0.05 s).

## Screens

Title (Play — Learn & play / Continue journey / Play daily —, the six mode cards, Theme, Settings, Help, Sign in, Invite, the gardener line with blooms and cloud status), Journey, Challenges, Score chase, the round, Results, and the sheets: Pause (Resume, Settings, Help, Restart level, Leave round), Settings, How to play, Practice setup and the gardener name (signed out only; signed in, the account name is used). Every screen is reachable from the title. The theme button cycles the themes unlocked by blooms (Dawn 0, Rain 30, Autumn 80, Dusk 150, Night 250).

The round: the HUD (Pause, mode and words found, the timer, tries left in move-limit challenges, the score), the lesson bar, the crossword grid (hidden, revealed, hinted and just-planted cells), the current word with its feedback line, the wheel buttons (Shuffle, Hint, Undo when allowed, Clear, Submit — reversed with left-handed controls) and the bonus line. Portrait and desktop windows stack HUD, grid, wheel and controls; a phone held sideways uses HUD rail | lesson + grid column | wheel. The camera frames the wheel in the band the UI leaves (view offset + fit).

Results: headline, words / bonus / time, Journey stars, the score breakdown, achievements earned, the leaderboard line, the local board (Daily, Challenge, Score chase; signed in, the Daily shows the platform's high-score board), and Next / Retry / Home.

## Controls

- Pointer or finger: press a letter and drag across the others (dragging back onto the previous letter removes it); release submits when "Submit word on release" is on (default), otherwise press Submit. A tap without dragging appends the letter (or removes it when it is the last one).
- Keyboard (rebindable in the runtime's Options): letters A–Z pick the first free tile with that letter; Enter submits, Backspace removes the last letter, Escape clears the word or pauses, S shuffle, H hint, U undo, P pause, arrows move a highlight around the wheel and Space picks it. A Shuffle / Hint / Undo / Pause key that is a letter acts only while no word is being spelled; otherwise it types.
- Gamepad: D-pad / left stick move around the wheel, South picks, East removes, West shuffles, North hints, right shoulder submits, Start pauses. Menus use the runtime's UI navigation.
- Each letter is a named target ("Letter A") for screen readers and play scripts; sounds have optional spoken captions.

## Settings

The runtime's Options own volumes and mute, graphics level and frame rate, language, key and pad bindings, reduced motion, high contrast and text size. The game's own options (engine settings, synced with the account): captions for audio cues, gentle camera sway, show timer, colour palette (letter ink for colour-vision needs), left-handed controls, submit on release, haptics, and Replay tutorial. The browser build's account settings for these are adopted once; its other keys are retired.

## Look and sound

`native/render.ts` ports the browser build's three.js r160 grove to `starhermit:scene` with the page's own light, shadow and environment values (minor 24 = three r185 units, so no compensation): sky dome, displaced ground with grass speckle, hills, seeded trees, rocks, pond with ripple normals and lily pads, instanced grass, the log-slice wheel with brass rim, glazed letter tokens, the glowing selection path, flowers for every word, leaf bursts, fireflies (dusk/night) and pollen. Reflections are the page's sky environment prefiltered with `PMREMGenerator.fromScene`, given to each material at its own `envMapIntensity` (r160 behaviour). Post effects (GTAO, bloom, display-space grade + vignette, FXAA/SMAA/MSAA) follow the runtime's quality tier (`native/quality.ts`, the old four presets and budgets). Sounds are the authored `sfx/*.opus`; ambience (birds, rain, wind, crickets) and the adaptive chord music are rendered into looping clips.

## Platform

- Save: `{ progress, boards }` in the engine save (device + cloud); conflicts merge with `mergeProgress` / `mergeBoards`; the browser build's cloud slot is read as a foreign save, merged and replaced once. The interrupted round is kept on the device and offered again (paused) for a day.
- Scores: signed in, every finished round except the lesson posts its total to the `high-score` board through `score-script.js` (range-checked: 0–100,000). Solo scores are not replay-verified by the platform; local boards are local.
- Invite link and sign-in buttons on the title; the Daily uses the platform clock.

## Checks

`npm test`: the rules suite (`tests/run-tests.js`), content, save and translation tests, then `tests/native.mjs` (tsc, `starhermit check`, the web index, and the play scripts in `tests/native/`: menus at a desktop window, a full Journey stage by keyboard, the lesson on a DPR-3 phone by touch, Practice on a sideways phone). `npm run test:browser` plays the web package in GPU Chrome at desktop, phone and landscape. `npm run package` rewrites `index.html` and `starhermit-files.json` after every change.

## Known limitations

- The anonymous usage-stats option is gone: the browser build only kept those events in memory.
- The grass tufts' wind bend is an instance-matrix shear rather than the page's quadratic vertex bend.
- `server.js` is the browser build's local dev server and replay validator (used by the rules tests); it is not part of the package.
