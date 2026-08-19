// Word Grove — deterministic seeded randomness and hashing.
// Separate streams are used for rules, content decoration, and audiovisual
// variants so cosmetic randomness never changes rules outcomes.

export function hashString(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function makeRng(seed) {
  // mulberry32
  let a = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
  const rng = function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (n) => Math.floor(rng() * n);
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.pick = (arr) => arr[rng.int(arr.length)];
  rng.shuffle = (arr) => {
    const a2 = arr.slice();
    for (let i = a2.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [a2[i], a2[j]] = [a2[j], a2[i]];
    }
    return a2;
  };
  rng.fork = (label) => makeRng((a >>> 0) ^ hashString(String(label)));
  return rng;
}

// State hashing for replay envelopes / determinism checks.
export function hashState(obj) {
  return hashString(stableStringify(obj)).toString(16).padStart(8, '0');
}

export function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function checksum(str) {
  return hashString(str).toString(16).padStart(8, '0');
}
