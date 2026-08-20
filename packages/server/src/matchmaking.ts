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
   * Live rooms, keyed by `party:CODE` or `pub:MODE:NAME`. Exposed because the tick
   * loop drives every room in here and `/api/status` reports them; mutated only
   * through the methods below, so the empty-room sweep and the key format stay in
   * one place.
   */
  readonly rooms = new Map<string, Room>();

  /**
   * How many public lobbies have been opened, per mode. The map rotation walks
   * with it, so the second lobby of a mode is a different level from the first
   * rather than everyone who ever plays seeing Dustworks.
   */
  private seq = new Map<number, number>();

  /**
   * A party's key is its code and nothing else.
   *
   * This used to include the mode, and that single detail broke the whole feature.
   * Two friends typing the same code with different modes selected got two
   * different rooms — each with its own `pickMap` draw — so they were on different
   * levels, could not see each other, and nothing anywhere said why. The room they
   * both wanted was the one named by the code; the mode is a property *of* that
   * room, not part of its identity, and whoever opens it decides it.
   */
  private partyKey(code: string): string {
    return `party:${code}`;
  }

  /**
   * Public rooms stay keyed by mode and name, and are prefixed so that a party
   * code can never collide with an auto-generated lobby name.
   */
  private publicKey(mode: number, name: string): string {
    return `pub:${mode}:${name}`;
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
   * room", empty means "find me a game". That one distinction is the whole party
   * feature, which is why it needed no new protocol — `JoinMsg.room` could already
   * say it.
   *
   * `mode` is what the caller *asked* for, which is not necessarily what they get:
   * joining a party adopts the room's mode. Callers must read the mode and map back
   * off the room (the welcome packet does), never assume the request was honoured.
   */
  findRoom(mode: number, requested: string, now: number): Room {
    if (requested) return this.partyRoom(requested, mode, now);
    return this.bestPublicRoom(mode) ?? this.openPublicRoom(mode, now);
  }

  /**
   * The room a code names, opening it if this is the first one in.
   *
   * The creator's mode becomes the room's mode and picks its map. Everyone after
   * them adopts both — which is the point: a party is a group of people who agreed
   * on a code, and a code has to mean one room on one level or it means nothing.
   */
  private partyRoom(code: string, mode: number, now: number): Room {
    const key = this.partyKey(code);
    const existing = this.rooms.get(key);
    if (existing) return existing;

    const r = new Room(code, mode, pickMap(mode === MODE.TDM, hashName(code)).id, now, true);
    r.playersOnlineProvider = this.totalPlayers;
    this.rooms.set(key, r);
    return r;
  }

  /**
   * The best public room to drop a quick-match player into, or null if there is none.
   *
   * "Best" is the one with the most humans in it, ties broken toward fewer bots.
   * This used to return the *first* room with space, which spread arrivals across
   * every open lobby and left a server with plenty of people on it feeling like a
   * server full of bots — the opposite of what pressing Quick Match asks for.
   * Filling one room before opening another is what makes real opponents likely.
   *
   * `!r.party` is load-bearing: a party room is somebody's private match, and
   * matching on space alone would drop the next stranger who pressed Play straight
   * into it — a group's private lobby quietly filling with people they did not
   * invite, with nothing in the interface to explain why.
   */
  private bestPublicRoom(mode: number): Room | null {
    let best: Room | null = null;
    let bestScore = -Infinity;
    for (const r of this.rooms.values()) {
      if (r.party || r.mode !== mode || r.isFull) continue;
      // Humans dominate, bots only ever break a tie, and a room showing its result
      // card loses the last tie — a new arrival there waits out somebody else's
      // scoreboard before playing.
      const score = r.humanCount * 1000 - r.botCount * 10 - (r.isOver ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return best;
  }

  private openPublicRoom(mode: number, now: number): Room {
    let n = 1;
    while (this.rooms.has(this.publicKey(mode, `lobby-${n}`))) n++;
    const nth = (this.seq.get(mode) ?? 0) + 1;
    this.seq.set(mode, nth);
    const r = new Room(`lobby-${n}`, mode, pickMap(mode === MODE.TDM, nth - 1).id, now);
    r.playersOnlineProvider = this.totalPlayers;
    this.rooms.set(this.publicKey(mode, r.id), r);
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
