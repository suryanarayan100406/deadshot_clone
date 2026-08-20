/**
 * Network transport and server-clock estimation.
 *
 * The client never trusts `Date.now()` differences directly. Instead it keeps a
 * rolling *minimum* of `serverTime − clientTime` samples. Minimum, not average:
 * the sample taken on the least-delayed packet is the one closest to the true
 * offset, because every source of error (queueing, GC, scheduler jitter) can
 * only ever push a sample later, never earlier. An average would be biased by
 * exactly the jitter we are trying to remove.
 *
 * The estimate is then allowed to drift upward slowly — otherwise a single
 * unusually fast packet would pin the clock too early forever, and real drift
 * between the two machines could never be corrected.
 *
 * Everything above this layer works in *server time*, which is what snapshots
 * are stamped in and what interpolation is scheduled against.
 */

import {
  ByteReader,
  MSG,
  decodeLobby,
  decodeMatch,
  decodeRoster,
  decodeSnapshot,
  decodeWelcome,
  encodeChat,
  encodeInputBatch,
  encodeJoin,
  encodeLobbyCmd,
  encodePing,
  encodeRespawn,
  encodeSwitch,
  type InputCmd,
  type LobbyMsg,
  type MatchMsg,
  type RosterEntry,
  type Snapshot,
  type WelcomeMsg,
} from '@oneshot/shared';

export type NetStatus = 'idle' | 'connecting' | 'joining' | 'live' | 'closed' | 'error';

export interface NetHandlers {
  onWelcome(m: WelcomeMsg): void;
  onSnapshot(s: Snapshot): void;
  onRoster(r: RosterEntry[]): void;
  onMatch(m: MatchMsg): void;
  onLobby(m: LobbyMsg): void;
  onStatus(status: NetStatus, detail?: string): void;
}

/** How long the offset estimate is allowed to age before it may drift up. */
const DRIFT_PER_SEC = 3;
/** Samples kept for the rolling minimum. ~5 s at 4 Hz pings. */
const OFFSET_WINDOW = 20;
/** Ping cadence. Frequent enough to track a route change, cheap enough to ignore. */
const PING_INTERVAL_MS = 250;

export class Net {
  status: NetStatus = 'idle';
  /** Smoothed round-trip time in ms. */
  rtt = 0;
  /** Best-guess ms to add to a local timestamp to get server time. */
  private offset = 0;
  private offsetSamples: number[] = [];
  private offsetSet = false;
  private lastOffsetAt = 0;

  /** Highest input sequence the server has confirmed. */
  ackSeq = 0;
  /** Our own actor id, once welcomed. */
  selfId = -1;

  /** Bytes in/out over the last second, for the debug readout. */
  bytesIn = 0;
  bytesOut = 0;
  private byteWindowAt = 0;
  private inAcc = 0;
  private outAcc = 0;

  private ws: WebSocket | null = null;
  private handlers: NetHandlers;
  private pingTimer = 0;
  private reader = new ByteReader(new Uint8Array(0));
  private closedByUs = false;

  constructor(handlers: NetHandlers) {
    this.handlers = handlers;
  }

  /* ── Clock ────────────────────────────────────────────────────────────── */

  /** Current best estimate of the server's clock, in ms. */
  now(): number {
    return performance.now() + this.offset;
  }

  /**
   * Render time: far enough behind the newest snapshot that the next one has
   * almost certainly arrived, so interpolation always has two frames to work
   * between and never has to extrapolate.
   */
  renderTime(interpDelayMs: number): number {
    return this.now() - interpDelayMs;
  }

  private sampleOffset(clientSent: number, serverTime: number, nowLocal: number): void {
    const rtt = nowLocal - clientSent;
    if (rtt < 0 || rtt > 4000) return; // Bogus sample; a suspended tab does this.
    this.rtt = this.rtt === 0 ? rtt : this.rtt * 0.8 + rtt * 0.2;

    // Assume the packet spent half the round trip in each direction: at the
    // moment it arrived, the server clock had already advanced by rtt/2.
    const sample = serverTime + rtt * 0.5 - nowLocal;

    this.offsetSamples.push(sample);
    if (this.offsetSamples.length > OFFSET_WINDOW) this.offsetSamples.shift();

    let best = this.offsetSamples[0]!;
    for (let i = 1; i < this.offsetSamples.length; i++) {
      const v = this.offsetSamples[i]!;
      if (v < best) best = v;
    }

    if (!this.offsetSet) {
      this.offset = best;
      this.offsetSet = true;
    } else if (best < this.offset) {
      // A faster path than anything seen before: trust it immediately, since a
      // low sample cannot be an artefact of delay.
      this.offset = best;
    } else {
      // Only creep upward, bounded by elapsed time, so genuine drift is tracked
      // without jitter dragging the clock around.
      const elapsed = (nowLocal - this.lastOffsetAt) / 1000;
      this.offset = Math.min(best, this.offset + DRIFT_PER_SEC * elapsed);
    }
    this.lastOffsetAt = nowLocal;
  }

  /* ── Connection ───────────────────────────────────────────────────────── */

  connect(join: { name: string; primary: string; mode: number; room: string }): void {
    this.disconnect();
    this.closedByUs = false;
    this.setStatus('connecting');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Same-origin `/ws`: in dev Vite proxies it, in production the game server
    // serves the bundle itself, so no URL ever needs configuring.
    const url = `${proto}//${location.host}/ws`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.setStatus('error', 'Could not open a connection');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus('joining');
      this.send(encodeJoin(join));
      this.pingTimer = window.setInterval(() => this.ping(), PING_INTERVAL_MS);
      this.ping();
    };

    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      this.inAcc += e.data.byteLength;
      this.onPacket(e.data);
    };

    ws.onerror = () => {
      if (this.status !== 'live') this.setStatus('error', 'Connection failed');
    };

    ws.onclose = (e) => {
      this.stopPing();
      this.ws = null;
      if (this.closedByUs) {
        this.setStatus('closed');
        return;
      }
      // Codes the server uses deliberately, so they get a real message.
      const reason =
        e.code === 4001
          ? 'That match is full'
          : e.code === 4002
            ? 'Timed out'
            : e.code === 4003
              ? 'Kicked'
              : this.status === 'live'
                ? 'Disconnected'
                : 'Could not reach the server';
      this.setStatus(this.status === 'live' ? 'closed' : 'error', reason);
    };
  }

  disconnect(): void {
    this.stopPing();
    this.closedByUs = true;
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close(1000, 'left');
      } catch {
        /* Already closing. */
      }
    }
    this.selfId = -1;
    this.ackSeq = 0;
    this.offsetSamples.length = 0;
    this.offsetSet = false;
    this.rtt = 0;
    if (this.status !== 'idle') this.setStatus('idle');
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = 0;
    }
  }

  private setStatus(s: NetStatus, detail?: string): void {
    this.status = s;
    this.handlers.onStatus(s, detail);
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /* ── Send ─────────────────────────────────────────────────────────────── */

  private send(bytes: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // A saturated socket means the network is the bottleneck; dropping the
    // newest input is better than growing an unbounded buffer of stale ones.
    if (ws.bufferedAmount > 262144) return;
    this.outAcc += bytes.byteLength;
    ws.send(bytes);
  }

  private ping(): void {
    // u32 of performance.now() rolls over every ~50 days of uptime; the server
    // echoes it verbatim so only the low 32 bits ever matter.
    this.send(encodePing(Math.round(performance.now()) >>> 0));
  }

  /**
   * Sends every command the server has not acked yet, newest last, capped at the
   * protocol's 8. One packet then survives the loss of the previous few.
   */
  sendInputs(pending: readonly InputCmd[]): void {
    if (pending.length === 0) return;
    const from = Math.max(0, pending.length - 8);
    this.send(encodeInputBatch(pending, from));
  }

  sendSwitch(slot: number): void {
    this.send(encodeSwitch(slot));
  }

  sendRespawn(): void {
    this.send(encodeRespawn());
  }

  sendChat(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.send(encodeChat(t));
  }

  /** Ask the room to start, toggle bots, or flip our ready flag. */
  sendLobby(action: number, value = 0): void {
    this.send(encodeLobbyCmd(action, value));
  }

  /* ── Receive ──────────────────────────────────────────────────────────── */

  private onPacket(buf: ArrayBuffer): void {
    const r = this.reader;
    r.reset(buf);
    const type = r.u8v();

    switch (type) {
      case MSG.S_WELCOME: {
        const m = decodeWelcome(r);
        this.selfId = m.id;
        // First authoritative timestamp: seed the clock so the very first
        // snapshot already has a usable offset instead of interpolating from 0.
        if (!this.offsetSet) {
          this.offset = m.serverTime + this.rtt * 0.5 - performance.now();
          this.offsetSet = true;
          this.lastOffsetAt = performance.now();
        }
        this.setStatus('live');
        this.handlers.onWelcome(m);
        break;
      }
      case MSG.S_SNAPSHOT: {
        const s = decodeSnapshot(r);
        if (s.ackSeq > this.ackSeq) this.ackSeq = s.ackSeq;
        // Snapshots are also clock samples, and there are 20 of them a second
        // versus 4 pings — but with only a one-way delay, so they can only
        // ever refine the estimate downward, never establish it.
        this.handlers.onSnapshot(s);
        break;
      }
      case MSG.S_PONG: {
        const sent = r.u32v();
        const serverTime = r.u32v();
        this.sampleOffset(sent, serverTime, performance.now());
        break;
      }
      case MSG.S_ROSTER:
        this.handlers.onRoster(decodeRoster(r));
        break;
      case MSG.S_MATCH:
        this.handlers.onMatch(decodeMatch(r));
        break;
      case MSG.S_LOBBY:
        this.handlers.onLobby(decodeLobby(r));
        break;
      default:
        // Unknown type from a newer server: ignore rather than desync.
        break;
    }
  }

  /** Rolls the bandwidth counters. Call once per second-ish from the game loop. */
  tickCounters(nowLocal: number): void {
    if (nowLocal - this.byteWindowAt < 1000) return;
    this.byteWindowAt = nowLocal;
    this.bytesIn = this.inAcc;
    this.bytesOut = this.outAcc;
    this.inAcc = 0;
    this.outAcc = 0;
  }
}
