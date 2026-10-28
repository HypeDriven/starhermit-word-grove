// Grove preparation off the game's thread (a starhermit:script module
// worker): js/content.js makes the round's level (Daily, Practice and Score
// chase groves are generated: ~150–250 ms natively; the fixed content comes
// from js/levels.js) and js/session.js its bonus-word pool (~80 ms), so the
// grove keeps drawing meanwhile. In: { id, kind, arg, arg2 }. Out:
// { id, level, bonusPool } or { id, error }.
import { getJourneyLevel, getDailyLevel, getPracticeLevel, getChallengeLevel, getTutorialLevel } from "../js/content.js";
import { bonusPoolOf } from "../js/session.js";

export function prepareLevel(kind, arg, arg2) {
  let level;
  if (kind === "journey") level = getJourneyLevel(arg);
  else if (kind === "daily") level = getDailyLevel(arg);
  else if (kind === "practice") level = getPracticeLevel(arg, arg2);
  else if (kind === "challenge") level = getChallengeLevel(arg);
  else level = getTutorialLevel();
  return { level, bonusPool: bonusPoolOf(level) };
}

globalThis.onmessage = (e) => {
  const d = e.data;
  try {
    const r = prepareLevel(d.kind, d.arg, d.arg2);
    postMessage({ id: d.id, level: r.level, bonusPool: r.bonusPool });
  } catch (err) {
    postMessage({ id: d.id, error: String(err && err.message || err) });
  }
};
