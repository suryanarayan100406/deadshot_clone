/**
 * Which room a joining player ends up in.
 *
 * This lives apart from `index.ts` for one concrete reason: that file opens a
 * listening socket and starts the 60 Hz tick as top-level side effects, so
 * importing it from a test would boot a real server that never exits. Room
 * selection is the part of it that contains actual decisions — public overflow,
 * party isolation, which map a room opens on — and decisions are the part worth
 * testing, so they live somewhere a test can reach.
 *
 * Held as a class rather than module-level maps so that each test gets a clean
 * lobby instead of inheriting rooms from whatever ran before it.
 */

import { MODE, pickMap } from '@oneshot/shared';

import { Room } from './room.js';

/**
 * FNV-1a over the room name, so a join code always resolves to the same map.
 *
 * A hash rather than a counter because private rooms have no ordering — they are
 * created whenever somebody types a code — and rather than `Math.random()`
 * because a party that agrees on a code should get the same level every time they
 * use it. Returned unsigned so no caller has to think about the sign.
 */
export function hashName(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Lobby {
  /**
   * Live rooms, keyed by mode and name. Exposed because the tick loop drives every
   * room in here and `/api/status` reports them; mutated only through the methods
   * below, so the empty-room sweep and the key format stay in one place.
   */
  readonly rooms = new Map<string, Room>();

  /**
   * How many public lobbies have been opened, per mode. The map rotation walks
   * with it, so the second lobby of a mode is a different level from the first
   * rather than everyone who ever plays seeing Dustworks.
   */
  private seq = new Map<number, number>();

  private key(mode: number, name: string): string {
    return `${mode}:${name}`;
  }

  /** Humans across every room, for the menu's online counter. */
  totalPlayers = (): number => {
    let n = 0;
    for (const r of this.rooms.values()) n += r.humanCount;
    return n;
  };

  /**
   * Find a room with space, or open a new one.
   *
   * `requested` is a sanitized party code: non-empty means "put me in this exact
   * room", empty means "anywhere with space". That one distinction is the whole
   * party feature, which is why it needed no new protocol — `JoinMsg.room` could
   * already say it.
   */
  findRoom(mode: number, requested: string, now: number): Room {
    const team = mode === MODE.TDM;

    if (requested) {
      const key = this.key(mode, requested);
      let r = this.rooms.get(key);
      if (!r) {
        r = new Room(requested, mode, pickMap(team, hashName(requested)).id, now, true);
        r.playersOnlineProvider = this.totalPlayers;
        this.rooms.set(key, r);
      }
      return r;
    }

    for (const r of this.rooms.values()) {
      // `!r.party` is load-bearing: a party room is somebody's private match, and
      // matching on space alone would drop the next stranger who pressed Play
      // straight into it — a group's private lobby quietly filling with people
      // they did not invite, with nothing in the interface to explain why.
      if (r.mode === mode && !r.party && !r.isFull) return r;
    }

    let n = 1;
    while (this.rooms.has(this.key(mode, `lobby-${n}`))) n++;
    const nth = (this.seq.get(mode) ?? 0) + 1;
    this.seq.set(mode, nth);
    const r = new Room(`lobby-${n}`, mode, pickMap(team, nth - 1).id, now);
    r.playersOnlineProvider = this.totalPlayers;
    this.rooms.set(this.key(mode, r.id), r);
    return r;
  }

  /**
   * Retire rooms nobody is in.
   *
   * One is always kept, so an idle server still has somewhere for the next
   * connection to land rather than paying room construction on the join.
   */
  sweepEmpty(): void {
    for (const [key, room] of this.rooms) {
      if (room.humanCount === 0 && room.players.size === 0 && this.rooms.size > 1) {
        this.rooms.delete(key);
      }
    }
  }
}
