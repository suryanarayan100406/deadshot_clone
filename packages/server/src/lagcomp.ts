/**
 * Lag compensation.
 *
 * The server keeps a rolling second of every player's position. When a client
 * reports a shot, we rewind every *other* player to where that client was seeing
 * them at the moment they pulled the trigger — roughly `rtt/2 + interpolation
 * delay` in the past — and resolve the shot against that reconstructed world.
 *
 * Without this, a player on 80 ms ping has to lead a moving target by most of a
 * body width, which feels broken. With it, what looked like a hit is a hit.
 */

import { LAGCOMP_HISTORY_MS, TICK_MS } from '@oneshot/shared';

export interface Sample {
  id: number;
  x: number;
  y: number;
  z: number;
  height: number;
  alive: boolean;
}

interface Frame {
  time: number;
  count: number;
  samples: Sample[];
}

const FRAME_COUNT = Math.ceil(LAGCOMP_HISTORY_MS / TICK_MS) + 4;
const MAX_TRACKED = 32;

function emptyFrame(): Frame {
  const samples: Sample[] = new Array(MAX_TRACKED);
  for (let i = 0; i < MAX_TRACKED; i++) {
    samples[i] = { id: -1, x: 0, y: 0, z: 0, height: 0, alive: false };
  }
  return { time: 0, count: 0, samples };
}

export interface Recordable {
  id: number;
  alive: boolean;
  move: { pos: { x: number; y: number; z: number }; height: number };
}

export class History {
  /** Ring buffer, preallocated so recording never allocates. */
  private frames: Frame[] = Array.from({ length: FRAME_COUNT }, emptyFrame);
  private head = -1;
  private filled = 0;

  /** Snapshot the world at `time` (ms). Called once per simulation tick. */
  record(time: number, players: Iterable<Recordable>): void {
    this.head = (this.head + 1) % FRAME_COUNT;
    if (this.filled < FRAME_COUNT) this.filled++;
    const f = this.frames[this.head]!;
    f.time = time;
    let n = 0;
    for (const p of players) {
      if (n >= MAX_TRACKED) break;
      const s = f.samples[n]!;
      s.id = p.id;
      s.x = p.move.pos.x;
      s.y = p.move.pos.y;
      s.z = p.move.pos.z;
      s.height = p.move.height;
      s.alive = p.alive;
      n++;
    }
    f.count = n;
  }

  private frameAt(offsetFromNewest: number): Frame | null {
    if (this.filled === 0) return null;
    if (offsetFromNewest >= this.filled) return null;
    const idx = (this.head - offsetFromNewest + FRAME_COUNT * 2) % FRAME_COUNT;
    return this.frames[idx]!;
  }

  /**
   * Reconstruct positions at `time`, interpolating between the two bracketing
   * frames. Writes into `out` and returns how many samples were written.
   */
  rewind(time: number, out: Sample[]): number {
    if (this.filled === 0) return 0;

    const newest = this.frameAt(0)!;
    if (time >= newest.time) return copyFrame(newest, out);

    const oldest = this.frameAt(this.filled - 1)!;
    if (time <= oldest.time) return copyFrame(oldest, out);

    // Walk back to the first frame at or before `time`.
    let older: Frame | null = null;
    let newer: Frame = newest;
    for (let i = 1; i < this.filled; i++) {
      const f = this.frameAt(i)!;
      if (f.time <= time) {
        older = f;
        break;
      }
      newer = f;
    }
    if (!older) return copyFrame(newest, out);

    const span = newer.time - older.time;
    const t = span > 0 ? (time - older.time) / span : 0;

    let n = 0;
    for (let i = 0; i < older.count && n < MAX_TRACKED; i++) {
      const a = older.samples[i]!;
      const b = findSample(newer, a.id);
      const s = out[n] ?? (out[n] = { id: -1, x: 0, y: 0, z: 0, height: 0, alive: false });
      s.id = a.id;
      s.alive = a.alive;
      if (b) {
        s.x = a.x + (b.x - a.x) * t;
        s.y = a.y + (b.y - a.y) * t;
        s.z = a.z + (b.z - a.z) * t;
        s.height = a.height + (b.height - a.height) * t;
      } else {
        s.x = a.x;
        s.y = a.y;
        s.z = a.z;
        s.height = a.height;
      }
      n++;
    }
    return n;
  }
}

function findSample(f: Frame, id: number): Sample | null {
  for (let i = 0; i < f.count; i++) {
    if (f.samples[i]!.id === id) return f.samples[i]!;
  }
  return null;
}

function copyFrame(f: Frame, out: Sample[]): number {
  for (let i = 0; i < f.count; i++) {
    const a = f.samples[i]!;
    const s = out[i] ?? (out[i] = { id: -1, x: 0, y: 0, z: 0, height: 0, alive: false });
    s.id = a.id;
    s.x = a.x;
    s.y = a.y;
    s.z = a.z;
    s.height = a.height;
    s.alive = a.alive;
  }
  return f.count;
}
