// Word Grove — deterministic compact-crossword layout.
// Places words so they cross on shared letters, with no illegal adjacencies:
//  - crossing cells must match letters,
//  - cells immediately before/after a word (along its axis) must be empty,
//  - no parallel adjacency between different words (side-contact) unless crossing.

export function canForm(word, letterCounts) {
  const need = {};
  for (const ch of word) need[ch] = (need[ch] || 0) + 1;
  for (const ch in need) if ((letterCounts[ch] || 0) < need[ch]) return false;
  return true;
}

export function letterCountsOf(letters) {
  const c = {};
  for (const ch of letters) c[ch] = (c[ch] || 0) + 1;
  return c;
}

export function subanagrams(letters, wordList, minLen = 3) {
  const counts = letterCountsOf(letters);
  const out = [];
  for (const w of wordList) {
    if (w.length >= minLen && w.length <= letters.length && canForm(w, counts)) out.push(w);
  }
  return out;
}

// Attempt to lay out `words` (array of strings) into a crossing grid.
// Returns { placements: [{word,x,y,dir}], width, height, minX, minY } or null.
// dir: 0 = across (x increases), 1 = down (y increases).
export function layoutWords(words, rng) {
  const sorted = words.slice().sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const placements = [];
  const occ = new Map(); // "x,y" -> {ch, across: wordIdx|null, down: wordIdx|null}
  const key = (x, y) => x + ',' + y;

  function cellBusyForParallel(x, y, dir, selfIdx) {
    // A new letter at (x,y) with orientation `dir` must not sit side-by-side
    // with a letter of another word running the same direction.
    const n = occ.get(key(x, y));
    if (n) return false; // handled by crossing logic elsewhere
    const side = dir === 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
    for (const [dx, dy] of side) {
      const m = occ.get(key(x + dx, y + dy));
      if (m) {
        const owner = dir === 0 ? m.across : m.down;
        if (owner !== null && owner !== selfIdx) return true;
        // side cell belongs to a perpendicular word ending/continuing here:
        // also illegal (it would form an unintended contact)
        return true;
      }
    }
    return false;
  }

  function tryPlace(word, x, y, dir, idx) {
    // Validate the whole word; returns list of crossings or null.
    const crossings = [];
    for (let i = 0; i < word.length; i++) {
      const cx = dir === 0 ? x + i : x;
      const cy = dir === 0 ? y : y + i;
      const n = occ.get(key(cx, cy));
      if (n) {
        if (n.ch !== word[i]) return null;
        const owner = dir === 0 ? n.across : n.down;
        if (owner !== null) return null; // already used along this axis
        crossings.push(i);
      } else {
        if (cellBusyForParallel(cx, cy, dir, idx)) return null;
      }
    }
    // End caps must be empty.
    const bx = dir === 0 ? x - 1 : x, by = dir === 0 ? y : y - 1;
    const ex = dir === 0 ? x + word.length : x, ey = dir === 0 ? y : y + word.length;
    if (occ.has(key(bx, by)) || occ.has(key(ex, ey))) return null;
    return crossings;
  }

  function commit(word, x, y, dir, idx) {
    for (let i = 0; i < word.length; i++) {
      const cx = dir === 0 ? x + i : x;
      const cy = dir === 0 ? y : y + i;
      const k = key(cx, cy);
      let n = occ.get(k);
      if (!n) { n = { ch: word[i], across: null, down: null }; occ.set(k, n); }
      if (dir === 0) n.across = idx; else n.down = idx;
    }
    placements.push({ word, x, y, dir });
  }

  // First word: longest, horizontal at origin.
  commit(sorted[0], 0, 0, 0, 0);

  for (let wi = 1; wi < sorted.length; wi++) {
    const word = sorted[wi];
    const candidates = [];
    for (let pi = 0; pi < placements.length; pi++) {
      const p = placements[pi];
      for (let i = 0; i < word.length; i++) {
        for (let j = 0; j < p.word.length; j++) {
          if (word[i] !== p.word[j]) continue;
          // Cross perpendicularly to p.
          const dir = p.dir === 0 ? 1 : 0;
          const x = p.dir === 0 ? p.x + j : p.x - i;
          const y = p.dir === 0 ? p.y - i : p.y + j;
          const crossings = tryPlace(word, x, y, dir, wi);
          if (crossings) {
            candidates.push({ x, y, dir, crossings: crossings.length, spread: Math.abs(x) + Math.abs(y) });
          }
        }
      }
    }
    if (!candidates.length) return null;
    // Prefer more crossings, then compact, then deterministic seeded tiebreak.
    candidates.sort((a, b) => b.crossings - a.crossings || a.spread - b.spread);
    const top = candidates.filter((c) => c.crossings === candidates[0].crossings && c.spread === candidates[0].spread);
    const pick = top[rng.int(top.length)];
    commit(word, pick.x, pick.y, pick.dir, wi);
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of placements) {
    const ex = p.dir === 0 ? p.x + p.word.length - 1 : p.x;
    const ey = p.dir === 0 ? p.y : p.y + p.word.length - 1;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, ex); maxY = Math.max(maxY, ey);
  }
  // Normalize to origin.
  for (const p of placements) { p.x -= minX; p.y -= minY; }
  return { placements, width: maxX - minX + 1, height: maxY - minY + 1 };
}
