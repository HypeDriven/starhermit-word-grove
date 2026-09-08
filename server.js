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
  return { ok: true, score: result.score, hash: result.finalHash,
           status: result.status, invalidCount: result.invalidCount, elapsedSec: result.elapsedSec };
}

// ------------------------------------------------------------ dev server ---

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
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
    // Idempotent duplicate rejection: a row keyed by the same command id
    // (spec §5 "Reject duplicates idempotently by command ID") is re-submitted
    // as a no-op rather than occupying another board slot.
    const sessionId = String(payload.replay.commands[0]?.id || Date.now());
    const existing = b.entries.find((e) => e.sessionId === sessionId);
    if (existing) {
      return json(res, 200, { ok: true, rank: b.entries.indexOf(existing) + 1, duplicate: true });
    }
    // Authoritative row: completion, invalid-count and elapsed time come from
    // the replayed state, never hard-coded or trusted from the client.
    const entry = {
      name: String(payload.name || 'Gardener').slice(0, 20),
      score: result.score,
      completed: result.status === 'complete',
      invalidCount: result.invalidCount,
      elapsedSec: result.elapsedSec,
      sessionId,
    };
    b.entries.push(entry);
    b.entries.sort(compareResults);
    const rank = b.entries.findIndex((e) => e.sessionId === sessionId) + 1;
    b.entries = b.entries.slice(0, 100);
    boards.set(boardId, b);
    return json(res, 200, { ok: true, rank });
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
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return; // keep draining so the 413 response flushes cleanly
      data += c;
      if (data.length > 512 * 1024) { tooBig = true; resolve(data); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function startServer(port = 8080) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(req, res, url); }
      catch { return json(res, 400, { error: 'bad-request' }); }
    }
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); }
    catch { return json(res, 400, { error: 'bad-path' }); }
    if (decoded.split(/[\\/]/).some(part => part.startsWith('.'))) return json(res, 403, { error: 'forbidden' });
    let path = normalize(decoded);
    if (path === '/' || path === '\\') path = '/index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
    // Keep design documents and source maps out of the served distribution
    // (spec §6). spec.md is the shipping design doc; block .md/.map wholesale.
    const lowerPath = path.toLowerCase();
    if (lowerPath.endsWith('.md') || lowerPath.endsWith('.map')) {
      return json(res, 403, { error: 'forbidden' });
    }
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
