/**
 * Procedural audio.
 *
 * Every sound is synthesised at runtime from noise buffers and oscillators —
 * there are no audio files to download, and weapon character is data-driven from
 * `WeaponDef.sfx` rather than from a pile of assets.
 *
 * ── How a gunshot is built ───────────────────────────────────────────────────
 * A gunshot is a percussive *event*, not a note, and it falls apart the moment
 * it is treated as one. Five layers, in the order the ear picks them out:
 *
 *   1. **Transient** — a few milliseconds of high noise with no attack ramp at
 *      all. This is the layer that makes the brain say "gun". It is also the
 *      first thing distance destroys, which is why far-off gunfire booms.
 *   2. **Blast** — noise driven through a lowpass whose cutoff *sweeps down*
 *      from `crack` to a few hundred Hz across the length of the shot. That
 *      falling sweep is the whole trick: static-cutoff noise is a hiss, swept
 *      noise is a bang.
 *   3. **Punch** — a low sine at `body`, over in a few tens of milliseconds.
 *   4. **Mech** — the bolt or slide, a resonant click a beat behind the shot.
 *      Without it a gun sounds electronic; with it, mechanical.
 *   5. **Tail** — quiet filtered rumble standing in for the room.
 *
 * Two things matter as much as the layers themselves:
 *
 * **Envelopes attack in 0.4 ms and decay in two stages** — a steep drop to about
 * a quarter level, then a slower fall. A single exponential from peak to silence
 * reads as a soft *whump*; the knee is what makes it snap.
 *
 * **Nothing pitched is allowed to last.** Any oscillator audible for longer than
 * ~50 ms stops being a thump and becomes a note, and notes from consecutive
 * shots stack into chords. Every tone here is short and barely sweeps.
 *
 * Per-shot jitter on every frequency and offset is not decoration either: with
 * fixed values, automatic fire is one waveform retriggered fifteen times a
 * second, which the ear immediately hears as a loop rather than as a weapon.
 *
 * The context starts suspended — browsers require a gesture — and is resumed on
 * the first click. Until then every play call is a cheap no-op.
 */

import { weaponById } from '@oneshot/shared';
import type { SettingsStore } from './settings';

/** Distance at which a world sound is inaudible. */
const MAX_AUDIBLE = 90;
/** Speed of sound is ignored; only attenuation and stereo pan are modelled. */
const REF_DIST = 6;
/**
 * Distance over which a shot crosses from "crack" to "boom". Past it the
 * transient is gone and the tail carries the sound, which is how real gunfire
 * behaves and a useful cue for how far away a fight is.
 */
const FAR_SHOT = 30;

/**
 * Cached soft-clip curves, keyed by quantised drive.
 *
 * Saturation is what separates a bang from a pop: clipping the blast generates
 * odd harmonics across the spectrum, which is most of the perceived "weight".
 * The curve is 1024 floats and identical for every shot at a given drive, so it
 * is built once — only the (cheap) node is per-voice.
 *
 * Pinned to `ArrayBuffer` rather than the default `ArrayBufferLike`, because
 * `WaveShaperNode.curve` will not accept an array that might be backed by a
 * `SharedArrayBuffer`.
 */
const curveCache = new Map<number, Float32Array<ArrayBuffer>>();

function softCurve(drive: number): Float32Array<ArrayBuffer> {
  const key = Math.max(1, Math.round(drive * 8));
  const hit = curveCache.get(key);
  if (hit) return hit;
  const n = 1024;
  const c = new Float32Array(n);
  const k = (key / 8) * 55;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // Classic algebraic soft clip: linear near zero, compressing toward ±1.
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  curveCache.set(key, c);
  return c;
}

/** Proportional jitter, ±`amount`. */
function jit(v: number, amount: number): number {
  return v * (1 + (Math.random() * 2 - 1) * amount);
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private comp: DynamicsCompressorNode | null = null;

  /** Shared white noise — generating a buffer per shot would be absurd. */
  private noiseBuf: AudioBuffer | null = null;
  /** Brown noise for tails and rumble: far closer to a room than white is. */
  private rumbleBuf: AudioBuffer | null = null;

  private settings: SettingsStore;
  private started = false;

  /** Listener state, refreshed each frame from the camera. */
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private fwdX = 0;
  private fwdZ = -1;
  private rightX = 1;
  private rightZ = 0;

  /** Rolling budget so a room full of shotguns cannot melt the audio thread. */
  private voices = 0;
  private voiceWindowAt = 0;
  /** When the last tail is due to finish, used to stop tails piling up. */
  private tailUntil = 0;

  constructor(settings: SettingsStore) {
    this.settings = settings;
    settings.onChange(() => this.applyVolumes());
  }

  /** Must be called from a user-gesture handler. Safe to call repeatedly. */
  unlock(): void {
    if (this.started) {
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    this.started = true;

    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    this.ctx = ctx;

    // A limiter keeps a burst of simultaneous shots from clipping. The attack is
    // deliberately slow enough (3 ms) to let gunshot transients through before it
    // clamps down — a faster attack would flatten the very thing that reads as a
    // gun, leaving the shots dull exactly when several people are firing.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -11;
    comp.knee.value = 10;
    comp.ratio.value = 7;
    comp.attack.value = 0.003;
    comp.release.value = 0.19;
    this.comp = comp;

    const master = ctx.createGain();
    const sfx = ctx.createGain();
    this.master = master;
    this.sfxBus = sfx;

    sfx.connect(comp);
    comp.connect(master);
    master.connect(ctx.destination);
    this.applyVolumes();

    this.noiseBuf = makeNoise(ctx, 0.6);
    this.rumbleBuf = makeRumble(ctx, 2.0);

    void ctx.resume();
  }

  private applyVolumes(): void {
    if (!this.master || !this.sfxBus || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.get('master'), t, 0.02);
    this.sfxBus.gain.setTargetAtTime(this.settings.get('sfx'), t, 0.02);
  }

  /** Refresh the listener transform. Cheap; call every frame. */
  setListener(x: number, y: number, z: number, yaw: number): void {
    this.lx = x;
    this.ly = y;
    this.lz = z;
    // Same convention as the shared math: yaw 0 faces −Z.
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    this.fwdX = -s;
    this.fwdZ = -c;
    this.rightX = c;
    this.rightZ = -s;
  }

  /* ── Internals ────────────────────────────────────────────────────────── */

  private ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running' && this.settings.get('master') > 0;
  }

  /** Rate-limits voice creation; returns false when the budget is spent. */
  private budget(now: number, cost = 1): boolean {
    if (now - this.voiceWindowAt > 0.1) {
      this.voiceWindowAt = now;
      this.voices = 0;
    }
    if (this.voices + cost > 46) return false;
    this.voices += cost;
    return true;
  }

  /** How full the voice budget is, 0–1. Drives how many layers a shot gets. */
  private load(now: number): number {
    if (now - this.voiceWindowAt > 0.1) return 0;
    return this.voices / 46;
  }

  private distTo(x: number, y: number, z: number): number {
    return Math.hypot(x - this.lx, y - this.ly, z - this.lz);
  }

  /**
   * Builds the gain/pan chain for a positioned sound.
   * Returns null when the source is out of range or inaudibly quiet.
   */
  private spatial(x: number, y: number, z: number, gain: number): GainNode | null {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus) return null;

    const dx = x - this.lx;
    const dy = y - this.ly;
    const dz = z - this.lz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > MAX_AUDIBLE) return null;

    // Inverse-distance rolloff with a near-field plateau, then a linear fade to
    // silence at MAX_AUDIBLE so distant shots do not hang around at -60 dB.
    const roll = REF_DIST / Math.max(REF_DIST, dist);
    const fade = 1 - dist / MAX_AUDIBLE;
    const vol = gain * roll * fade * fade;
    if (vol < 0.0006) return null;

    const g = ctx.createGain();
    g.gain.value = vol;

    if (dist > 0.6) {
      const inv = 1 / dist;
      const pan = (dx * this.rightX + dz * this.rightZ) * inv;
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      p.connect(bus);
    } else {
      g.connect(bus);
    }

    // Distance eats high frequencies; a one-pole lowpass is enough. Sounds
    // behind the listener lose a little more, which is a cheap front/back cue
    // that a stereo panner alone cannot give.
    const behind = dist > 0.6 ? (dx * this.fwdX + dz * this.fwdZ) / dist < -0.2 : false;
    if (dist > 10 || behind) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(600, (behind ? 9000 : 17000) - dist * 175);
      const wrap = ctx.createGain();
      wrap.connect(lp);
      lp.connect(g);
      return wrap;
    }
    return g;
  }

  /**
   * One filtered noise burst.
   *
   * `f1` is where the filter cutoff ends up: passing something well below `f0`
   * gives the downward sweep that makes noise read as an impact rather than as
   * hiss. `drive` above zero inserts a soft clipper for grit.
   */
  private noise(
    dest: AudioNode,
    at: number,
    dur: number,
    gain: number,
    type: BiquadFilterType,
    f0: number,
    f1: number,
    q = 1,
    long = false,
    drive = 0,
  ): void {
    const ctx = this.ctx;
    const buf = long ? this.rumbleBuf : this.noiseBuf;
    if (!ctx || !buf || gain <= 0.0002) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Random start offset and a slight rate change keep repeated shots from
    // sounding like the same sample retriggered.
    src.playbackRate.value = jit(1, 0.06);
    const offset = Math.random() * Math.max(0, buf.duration - dur - 0.05);

    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(Math.max(30, f0), at);
    if (Math.abs(f1 - f0) > 1) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(30, f1), at + dur * 0.85);
    }

    const g = ctx.createGain();
    percussive(g.gain, at, gain, dur);

    src.connect(filt);
    let node: AudioNode = filt;
    if (drive > 0) {
      const ws = ctx.createWaveShaper();
      ws.curve = softCurve(drive);
      // Saturation folds harmonics above Nyquist back down as aliasing without
      // this; 2× is enough to keep it out of the audible range.
      ws.oversample = '2x';
      filt.connect(ws);
      node = ws;
    }
    node.connect(g);
    g.connect(dest);
    src.start(at, offset, dur + 0.05);
    src.stop(at + dur + 0.05);
  }

  /** One-shot oscillator with an optional pitch drop. Keep `dur` short. */
  private tone(
    dest: AudioNode,
    at: number,
    dur: number,
    gain: number,
    from: number,
    to: number,
    type: OscillatorType = 'sine',
  ): void {
    const ctx = this.ctx;
    if (!ctx || gain <= 0.0002) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    if (Math.abs(to - from) > 1) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + dur);
    }

    const g = ctx.createGain();
    percussive(g.gain, at, gain, dur);

    osc.connect(g);
    g.connect(dest);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  /* ── Public sounds ────────────────────────────────────────────────────── */

  /**
   * A gunshot at a world position.
   * `own` shots skip spatialisation entirely — they should sit dead centre and
   * carry low end the way a first-person weapon always does.
   */
  shot(weaponId: number, x: number, y: number, z: number, own: boolean): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    const w = weaponById(weaponId);
    const s = w.sfx;

    const dist = own ? 0 : this.distTo(x, y, z);
    if (dist > MAX_AUDIBLE) return;

    // Layer count scales back under load: the transient and blast are the shot,
    // the mech and tail are trimming, so those are what get dropped when the
    // whole lobby is firing rather than degrading everything equally.
    const full = this.load(now) < 0.6;
    if (!this.budget(now, full ? 4 : 2)) return;

    let dest: AudioNode | null;
    let vol: number;
    if (own) {
      dest = this.sfxBus;
      vol = s.gain;
    } else {
      dest = this.spatial(x, y, z, s.gain * 1.2);
      // The spatial node already carries the level.
      vol = 1;
    }
    if (!dest) return;

    const p = s.punch;

    if (w.fireMode === 'melee') {
      // A swing, not a shot. The whoosh sweeps *upward* as the blade accelerates
      // past the ear, then the steel rings. No report, so no tail.
      this.noise(dest, now, p, 0.6 * vol, 'bandpass', s.crack * 0.45, jit(s.crack, 0.12), 1.3);
      this.tone(dest, now + p * 0.38, 0.07, 0.14 * vol, jit(s.body, 0.05), s.body * 0.55, 'triangle');
      this.noise(
        dest,
        now + p * 0.42,
        0.075,
        0.34 * s.mech * vol,
        'bandpass',
        jit(s.mechFreq, 0.08),
        jit(s.mechFreq, 0.08),
        6,
      );
      return;
    }

    // Distance rebalances the layers rather than just turning them down: up
    // close a shot is nearly all transient, far away it is nearly all tail.
    const far = own ? 0 : Math.min(1, dist / FAR_SHOT);
    const near = 1 - far * 0.85;

    // 1. Transient — no ramp, a handful of milliseconds, the top of the spectrum.
    if (near > 0.25) {
      const f = jit(6400, 0.14);
      this.noise(dest, now, 0.008, 1.2 * vol * near, 'highpass', f, f, 0.45);
    }

    // 2. Blast — the falling filter sweep, saturated. This is the shot.
    this.noise(
      dest,
      now,
      p,
      1.0 * vol,
      'lowpass',
      jit(s.crack, 0.1) * (0.35 + near * 0.65),
      340,
      1.1,
      false,
      s.grit,
    );
    // A resonant throat under the blast gives it a size; without it the sweep
    // alone is thin.
    this.noise(
      dest,
      now,
      p * 0.72,
      0.52 * vol,
      'bandpass',
      jit(s.body * 4.5, 0.12),
      s.body * 1.8,
      1.7,
      false,
      s.grit * 0.6,
    );

    // 3. Punch — short, barely sweeps, so it stays a thump and never a note.
    this.tone(dest, now, p * 0.55, 0.92 * vol, jit(s.body, 0.05), s.body * 0.62, 'sine');
    // Your own weapon gets a sub octave for chest. Only yours: from across the
    // map this would be a bass rumble with no direction, which reads as a bug.
    if (own) {
      this.tone(dest, now, p * 0.85, 0.46 * vol, s.body * 0.52, s.body * 0.4, 'sine');
    }

    // 4. Mech — bolt or slide, a beat behind, and mostly a close-range detail.
    if (full && s.mech > 0 && near > 0.3) {
      const f = jit(s.mechFreq, 0.1);
      this.noise(
        dest,
        now + jit(p * 0.34, 0.22),
        0.03,
        0.44 * s.mech * vol * near,
        'bandpass',
        f,
        f * 0.8,
        3.2,
      );
    }

    // 5. Tail. Louder with distance, and ducked when one is already running —
    // at 900 RPM the tails would otherwise overlap into a continuous drone.
    if (s.tail > 0 && (full || far > 0.35)) {
      let g = 0.3 * vol * (0.45 + far * 1.1);
      if (now < this.tailUntil) g *= 0.5;
      this.tailUntil = now + s.tail * 0.55;
      this.noise(
        dest,
        now + p * 0.3,
        s.tail * (1 + far * 0.5),
        g,
        'lowpass',
        jit(680 + s.body * 3, 0.15),
        200,
        0.8,
        true,
      );
    }
  }

  /** Bullet striking geometry. `material` 0 = world, 1 = flesh, 2 = headshot. */
  impact(x: number, y: number, z: number, material: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    if (!this.budget(now, 2)) return;

    const dest = this.spatial(x, y, z, material === 0 ? 0.55 : 0.5);
    if (!dest) return;

    if (material === 0) {
      // Stone and metal: a hard tick with a downward sweep, and sometimes a
      // ricochet whine, which is what stops a firefight sounding like typing.
      const f = jit(4200, 0.3);
      this.noise(dest, now, 0.006, 1.0, 'highpass', f, f, 0.5);
      this.noise(dest, now, 0.075, 0.8, 'lowpass', jit(5200, 0.2), 500, 1.2, false, 0.4);
      this.tone(dest, now, 0.04, 0.28, jit(420, 0.2), 150, 'triangle');
      if (Math.random() < 0.22) {
        const r = jit(2300, 0.25);
        this.tone(dest, now + 0.012, 0.2, 0.1, r, r * 2.4, 'sine');
      }
    } else {
      // Flesh: no high-frequency crack at all, just a wet low slap. A headshot
      // gets a harder, brighter one so it is audible without the hitmarker.
      const head = material === 2;
      this.noise(dest, now, head ? 0.075 : 0.1, 0.75, 'lowpass', head ? 1500 : 900, 320, 1.1, false, 0.3);
      this.tone(dest, now, head ? 0.055 : 0.08, 0.42, head ? 250 : 165, 60, 'sine');
    }
  }

  /**
   * Local confirmation that your bullet connected.
   *
   * Short filtered pings rather than raw square waves: a square at 1.2 kHz is a
   * buzz, and hearing it fifteen times a second during a burst is the fastest
   * way to make a gunfight unpleasant.
   */
  hitmarker(head: boolean, killed: boolean): void {
    if (!this.ready() || !this.settings.get('hitSound')) return;
    const ctx = this.ctx!;
    const bus = this.sfxBus;
    if (!bus) return;
    const now = ctx.currentTime;
    if (!this.budget(now, 2)) return;

    if (killed) {
      // A rising two-note figure so a kill is unmistakable mid-fight.
      this.noise(bus, now, 0.012, 0.34, 'bandpass', 3400, 3400, 2.5);
      this.tone(bus, now, 0.07, 0.26, 1046, 1046, 'triangle');
      this.tone(bus, now + 0.007, 0.06, 0.1, 2092, 2092, 'sine');
      this.tone(bus, now + 0.072, 0.13, 0.24, 1568, 1568, 'triangle');
      this.tone(bus, now + 0.079, 0.1, 0.09, 3136, 3136, 'sine');
    } else {
      const f = head ? 2100 : 1380;
      this.noise(bus, now, 0.008, 0.22, 'bandpass', f * 1.8, f * 1.8, 2.2);
      this.tone(bus, now, 0.045, 0.2, f, f * 0.9, 'triangle');
      if (head) this.tone(bus, now, 0.03, 0.08, f * 2, f * 1.8, 'sine');
    }
  }

  /** You took a hit. */
  hurt(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const bus = this.sfxBus;
    if (!bus) return;
    const now = ctx.currentTime;
    if (!this.budget(now, 2)) return;
    this.noise(bus, now, 0.14, 0.5, 'lowpass', 900, 260, 0.9, false, 0.3);
    this.tone(bus, now, 0.16, 0.32, 185, 58, 'sine');
  }

  /** Local death sting. */
  died(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const bus = this.sfxBus;
    if (!bus) return;
    const now = ctx.currentTime;
    this.noise(bus, now, 0.5, 0.34, 'lowpass', 1400, 180, 0.7, true, 0.25);
    this.tone(bus, now, 0.6, 0.3, 240, 44, 'sawtooth');
    this.tone(bus, now + 0.02, 0.5, 0.14, 120, 33, 'sine');
  }

  /** Respawn / round start. */
  spawn(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const bus = this.sfxBus;
    if (!bus) return;
    const now = ctx.currentTime;
    this.tone(bus, now, 0.16, 0.18, 440, 660, 'triangle');
    this.tone(bus, now + 0.085, 0.22, 0.16, 660, 880, 'triangle');
    this.noise(bus, now, 0.2, 0.1, 'bandpass', 1800, 3600, 1.2);
  }

  /**
   * Reload, as a sequence of distinct mechanical stages rather than a row of
   * identical clicks: catch release, magazine out, magazine in, action closed.
   *
   * Spacing is derived from the weapon's own reload time, so the last stage
   * always lands as the weapon becomes usable — the animation, the timer and the
   * sound are all reading from the same number.
   */
  reload(weaponId: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const bus = this.sfxBus;
    if (!bus) return;
    const now = ctx.currentTime;
    if (!this.budget(now, 4)) return;

    const w = weaponById(weaponId);
    const t = Math.max(0.3, w.reloadTime);

    // A tube-fed shotgun is shells going in one at a time, not a magazine.
    if (w.fireMode === 'pump') {
      const shells = Math.min(6, Math.max(2, w.magSize));
      for (let i = 0; i < shells; i++) {
        const at = now + t * (0.1 + (i * 0.72) / shells);
        this.noise(bus, at, 0.045, 0.24, 'bandpass', jit(1250, 0.12), 700, 2.6, false, 0.3);
        this.tone(bus, at, 0.03, 0.1, jit(260, 0.1), 120, 'triangle');
      }
      // Pump the action closed.
      this.noise(bus, now + t * 0.88, 0.07, 0.32, 'bandpass', 900, 480, 2.2, false, 0.4);
      this.noise(bus, now + t * 0.95, 0.06, 0.34, 'bandpass', 1700, 900, 3.0, false, 0.4);
      return;
    }

    // Magazine catch: small, high, dry.
    this.noise(bus, now + t * 0.08, 0.03, 0.2, 'bandpass', jit(2600, 0.1), 1800, 4.5);
    // Magazine out: a rattle with some weight.
    this.noise(bus, now + t * 0.24, 0.09, 0.22, 'bandpass', jit(1100, 0.12), 520, 1.8, false, 0.25);
    // Magazine in: the heaviest event in the sequence.
    const seatAt = now + t * 0.6;
    this.noise(bus, seatAt, 0.06, 0.34, 'lowpass', jit(1500, 0.1), 380, 1.0, false, 0.45);
    this.tone(bus, seatAt, 0.05, 0.22, jit(150, 0.08), 70, 'sine');
    // Action home: two-part, pull then snap, so it reads as a mechanism.
    this.noise(bus, now + t * 0.84, 0.05, 0.2, 'bandpass', jit(1900, 0.1), 1100, 2.4, false, 0.3);
    this.noise(bus, now + t * 0.94, 0.04, 0.3, 'bandpass', jit(3000, 0.1), 1600, 4.0, false, 0.35);
  }

  /** Weapon swap. */
  swap(weaponId: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const bus = this.sfxBus;
    if (!bus) return;
    const now = ctx.currentTime;
    if (!this.budget(now, 2)) return;
    const w = weaponById(weaponId);
    // Cloth and a handful of metal, pitched by how big the weapon is.
    this.noise(bus, now, 0.075, 0.2, 'bandpass', 1400, 700, 1.1);
    this.noise(bus, now + 0.045, 0.035, 0.2, 'bandpass', jit(2400, 0.1), 1500, 3.4);
    this.tone(bus, now + 0.045, 0.04, 0.1, 260 - w.viz.bodyLen * 90, 110, 'triangle');
  }

  /** Dry trigger. */
  empty(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const bus = this.sfxBus;
    if (!bus) return;
    const now = ctx.currentTime;
    if (!this.budget(now)) return;
    // A hammer falling on nothing: hard, tiny, metallic, no body whatsoever.
    this.noise(bus, now, 0.005, 0.34, 'highpass', 4800, 4800, 0.6);
    this.noise(bus, now, 0.035, 0.26, 'bandpass', jit(2900, 0.08), 1500, 5.0, false, 0.3);
  }

  /** Boots on the ground, `hard` for a real landing impact. */
  footstep(hard: boolean): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const bus = this.sfxBus;
    if (!bus) return;
    const now = ctx.currentTime;
    if (!this.budget(now)) return;
    const g = hard ? 0.26 : 0.085;
    // Scuff plus body. The jitter matters more here than anywhere: footsteps
    // repeat more often than any other sound in the game.
    this.noise(bus, now, hard ? 0.14 : 0.06, g, 'lowpass', jit(hard ? 1400 : 2000, 0.18), 400, 0.9);
    this.tone(bus, now, hard ? 0.1 : 0.04, hard ? 0.18 : 0.05, jit(hard ? 125 : 190, 0.1), 50, 'sine');
  }

  /** Another player's footstep, positioned. */
  footstepAt(x: number, y: number, z: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    if (!this.budget(now)) return;
    const dest = this.spatial(x, y, z, 0.5);
    if (!dest) return;
    // Brighter than your own steps so an enemy nearby is a cue you can act on.
    this.noise(dest, now, 0.07, 0.8, 'bandpass', jit(1500, 0.2), 700, 1.3);
    this.tone(dest, now, 0.045, 0.3, jit(160, 0.12), 62, 'sine');
  }

  /** UI click. */
  ui(kind: 'click' | 'hover' | 'error' = 'click'): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const bus = this.sfxBus;
    if (!bus) return;
    const now = ctx.currentTime;
    if (kind === 'hover') {
      this.tone(bus, now, 0.03, 0.045, 1600, 1600, 'sine');
    } else if (kind === 'error') {
      this.tone(bus, now, 0.1, 0.16, 220, 165, 'triangle');
      this.tone(bus, now + 0.09, 0.12, 0.14, 165, 124, 'triangle');
    } else {
      this.noise(bus, now, 0.006, 0.1, 'bandpass', 3200, 3200, 2);
      this.tone(bus, now, 0.05, 0.12, 880, 1320, 'triangle');
    }
  }

  /** Match-over fanfare. */
  matchEnd(won: boolean): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const bus = this.sfxBus;
    if (!bus) return;
    const now = ctx.currentTime;
    const notes = won ? [523, 659, 784, 1047] : [523, 440, 349, 262];
    notes.forEach((f, i) => {
      this.tone(bus, now + i * 0.13, 0.3, 0.18, f, f, 'triangle');
      // A quiet octave gives the figure some shine without another voice's worth
      // of level.
      this.tone(bus, now + i * 0.13, 0.22, 0.05, f * 2, f * 2, 'sine');
    });
  }
}

/**
 * Percussive gain envelope: effectively instant attack, then a two-stage decay.
 *
 * The 0.4 ms ramp is short enough to be a transient but long enough to avoid the
 * discontinuity a bare `setValueAtTime` would leave. The knee at a quarter level
 * is what makes the result snap — a single exponential to silence is a soft
 * *whump* no matter how short you make it.
 */
function percussive(param: AudioParam, at: number, peak: number, dur: number): void {
  param.setValueAtTime(0, at);
  param.linearRampToValueAtTime(peak, at + 0.0004);
  param.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.26), at + dur * 0.17);
  param.exponentialRampToValueAtTime(0.0001, at + dur);
}

/** White noise, decorrelated per channel so it images wide in stereo. */
function makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  return buf;
}

/**
 * Brown noise for tails: white noise integrated with a leak, which tilts the
 * spectrum down at roughly 6 dB per octave.
 *
 * White noise is uniform across the spectrum and sounds like a hiss, so a white
 * tail reads as tape noise behind the shot. Real reverberation loses its highs
 * first, so the tail needs to be weighted low to read as a room at all.
 */
function makeRumble(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.028 * white) / 1.028;
      // The integrator lands well below full scale, so normalise back up.
      data[i] = Math.max(-1, Math.min(1, last * 11));
    }
  }
  return buf;
}
