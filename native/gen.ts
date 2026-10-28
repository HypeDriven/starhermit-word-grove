// The round's grove prepared on a worker (native/gen-worker.js) so a
// generated Daily / Practice / Score chase grove never stalls a frame;
// main.ts shows a "Growing the grove…" line when it takes over ~300 ms.
// Without a worker (it failed to start) it runs on the game's thread.
import { worker, type Worker } from "starhermit:script";
import { prepareLevel } from "./gen-worker.js";
import type { Level } from "./game.ts";

export type Kind = "journey" | "daily" | "practice" | "challenge" | "tutorial";
export interface Prepared { level: Level; bonusPool: string[] }
type Reply = { id: number; level?: Level; bonusPool?: string[]; error?: string };
let w: Worker | null = null;
let failed = false;
let nextId = 1;
const waiting = new Map<number, (r: Reply | null) => void>();

function ensure(): Worker | null {
  if (w || failed) return w;
  try {
    w = worker("native/gen-worker.js", { type: "module" });
    w.on("message", (m) => {
      const r = m as unknown as Reply;
      const job = waiting.get(r.id);
      if (!job) return;
      waiting.delete(r.id);
      job(r);
    });
    w.on("error", (msg) => { if (!/not responding/i.test(msg)) console.warn(`grove worker: ${msg}`); });
    w.on("stopped", () => {
      failed = true; w = null;
      for (const [id, job] of waiting) { waiting.delete(id); job(null); }
    });
  } catch (e) { console.warn(`grove worker: ${String(e)}`); failed = true; w = null; }
  return w;
}
export function warm(): void { ensure(); }
const sync = (kind: Kind, arg: string | number | undefined, arg2: string | undefined): Prepared =>
  (prepareLevel as unknown as (k: string, a?: string | number, b?: string) => Prepared)(kind, arg, arg2);
/** done(prepared) or done(null, error). */
export function prepare(kind: Kind, arg: string | number | undefined, arg2: string | undefined, done: (p: Prepared | null, err?: string) => void): void {
  const run = (): void => { try { done(sync(kind, arg, arg2)); } catch (e) { done(null, String(e)); } };
  const wk = ensure();
  if (!wk) { run(); return; }
  const id = nextId++;
  waiting.set(id, (r) => {
    if (!r) { run(); return; }
    if (r.error || !r.level) done(null, r.error);
    else done({ level: r.level, bonusPool: r.bonusPool ?? [] });
  });
  try { wk.post({ id, kind, arg: arg ?? null, arg2: arg2 ?? null }); }
  catch (e) { waiting.delete(id); console.warn(`grove worker: ${String(e)}`); run(); }
}
export function busy(): boolean { return waiting.size > 0; }
