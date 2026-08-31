// Word Grove — authoritative game script (declared as server=server.js).
// Dual purpose:
//  1. StarHermit authoritative script: validates score submissions by
//     replaying the recorded input log against the deterministic rules
//     engine and the level regenerated from its immutable seed.
//  2. Local dev server: `node server.js [port]` serves the game statically
//     plus a minimal /api/v1 surface (time, score validation, boards).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyReplay } from './js/session.js';
import { getDailyLevel, getChallengeLevel, getPracticeLevel, getJourneyLevel, getTutorialLevel, validateLevel } from './js/content.js';
import { compareResults } from './js/rules.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Regenerate the exact level a submission claims to have played.
export function levelForSeed(seed) {
  if (seed.startsWith('daily:')) return getDailyLevel(seed.slice(6));
  if (seed.startsWith('challenge:')) return getChallengeLevel(seed.slice(10));
  if (seed.startsWith('journey-')) return getJourneyLevel(Number(seed.slice(8)));
  if (seed === 'tutorial-grove') return getTutorialLevel();
  if (seed.startsWith('practice:')) {
    const [, diff, ...rest] = seed.split(':');
    return getPracticeLevel(diff, rest.join(':'));
  }
  return null;
}

// Authoritative score validation. Rejects impossible or stale-version scores.
export function validateScoreSubmission(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'malformed' };
  const { seed, replay, score, contentVersion } = payload;
  if (typeof seed !== 'string' || seed.length > 128) return { ok: false, error: 'bad-seed' };
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100000) {
    return { ok: false, error: 'implausible-score' };
  }
  if (!replay || !Array.isArray(replay.commands) || replay.commands.length > 5000) {
    return { ok: false, error: 'bad-replay' };
  }
  let level;
  try { level = levelForSeed(seed); } catch { level = null; }
  if (!level) return { ok: false, error: 'unknown-content' };
  if (validateLevel(level).length) return { ok: false, error: 'defective-content' };
  if (contentVersion !== level.version) return { ok: false, error: 'stale-version' };
  const result = verifyReplay(level, replay);
  if (!result.ok) return { ok: false, error: result.reason };
  if (result.score !== score) return { ok: false, error: 'score-mismatch', expected: result.score };
  return { ok: true, score: result.score, hash: result.finalHash };
}

// ------------------------------------------------------------ dev server ---

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
  '.opus': 'audio/ogg',
};

const boards = new Map(); // in-memory boards for local play

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/v1/time') return json(res, 200, { now: Date.now() });
  if (url.pathname === '/api/v1/profile') return json(res, 200, { name: 'Gardener', guest: true });

  if (url.pathname === '/api/v1/scores' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.length > 256 * 1024) return json(res, 413, { error: 'payload-too-large' });
    let payload;
    try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); }
    const result = validateScoreSubmission(payload);
    if (!result.ok) return json(res, 422, { error: result.error });
    const boardId = String(payload.board || 'global').slice(0, 64);
    const b = boards.get(boardId) || { entries: [] };
    b.entries.push({
      name: String(payload.name || 'Gardener').slice(0, 20),
      score: result.score,
      completed: true,
      invalidCount: 0,
      elapsedSec: payload.durationSec || 0,
      sessionId: String(payload.replay.commands[0]?.id || Date.now()),
    });
    b.entries.sort(compareResults);
    b.entries = b.entries.slice(0, 100);
    boards.set(boardId, b);
    return json(res, 200, { ok: true, rank: b.entries.findIndex((e) => e.score === result.score) + 1 });
  }

  if (url.pathname.startsWith('/api/v1/boards/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/v1/boards/'.length));
    const b = boards.get(id);
    return json(res, 200, { entries: b?.entries || [], casual: false });
  }

  if (url.pathname === '/api/v1/telemetry' || url.pathname.startsWith('/api/v1/activity') || url.pathname === '/api/v1/presence') {
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not-found' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 512 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function startServer(port = 8080) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path === '/' || path === '\\') path = '/index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
    try {
      const s = await stat(file);
      if (s.isDirectory()) return json(res, 403, { error: 'forbidden' });
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(data);
    } catch {
      json(res, 404, { error: 'not-found' });
    }
  });
  server.listen(port, () => console.log(`Word Grove → http://localhost:${port}`));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer(Number(process.argv[2]) || 8080);
}
