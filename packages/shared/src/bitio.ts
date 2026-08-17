/** Minimal binary reader/writer over a DataView. The hot path (inputs at 60 Hz,
 *  snapshots at 20 Hz) uses these instead of JSON, which keeps a full 12-player
 *  snapshot around 300 bytes. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ByteWriter {
  private view: DataView;
  private u8: Uint8Array;
  private off = 0;

  constructor(capacity = 2048) {
    const buf = new ArrayBuffer(capacity);
    this.view = new DataView(buf);
    this.u8 = new Uint8Array(buf);
  }

  private need(n: number): void {
    if (this.off + n <= this.u8.length) return;
    let cap = this.u8.length * 2;
    while (cap < this.off + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.u8);
    this.u8 = next;
    this.view = new DataView(next.buffer);
  }

  reset(): this {
    this.off = 0;
    return this;
  }

  u8v(v: number): this {
    this.need(1);
    this.view.setUint8(this.off, v & 0xff);
    this.off += 1;
    return this;
  }

  i8v(v: number): this {
    this.need(1);
    this.view.setInt8(this.off, v);
    this.off += 1;
    return this;
  }

  u16v(v: number): this {
    this.need(2);
    this.view.setUint16(this.off, v & 0xffff);
    this.off += 2;
    return this;
  }

  i16v(v: number): this {
    this.need(2);
    this.view.setInt16(this.off, v);
    this.off += 2;
    return this;
  }

  u32v(v: number): this {
    this.need(4);
    this.view.setUint32(this.off, v >>> 0);
    this.off += 4;
    return this;
  }

  f32v(v: number): this {
    this.need(4);
    this.view.setFloat32(this.off, v);
    this.off += 4;
    return this;
  }

  /** Length-prefixed UTF-8, max 255 bytes. */
  str(s: string): this {
    const bytes = encoder.encode(s);
    const n = Math.min(bytes.length, 255);
    this.need(1 + n);
    this.view.setUint8(this.off, n);
    this.off += 1;
    this.u8.set(bytes.subarray(0, n), this.off);
    this.off += n;
    return this;
  }

  /** Yaw quantised to 16 bits over (-PI, PI]. 0.0001 rad of error — invisible. */
  angle16(rad: number): this {
    const t = (rad / (Math.PI * 2) + 0.5) % 1;
    return this.u16v(Math.round((t < 0 ? t + 1 : t) * 65535));
  }

  /** Pitch quantised to 16 bits over [-PI/2, PI/2]. */
  pitch16(rad: number): this {
    const clamped = rad < -Math.PI / 2 ? -Math.PI / 2 : rad > Math.PI / 2 ? Math.PI / 2 : rad;
    return this.i16v(Math.round((clamped / (Math.PI / 2)) * 32767));
  }

  get length(): number {
    return this.off;
  }

  /** A copy sized to the written bytes, safe to hand to a socket. */
  take(): Uint8Array {
    return this.u8.slice(0, this.off);
  }
}

export class ByteReader {
  private view: DataView;
  private u8: Uint8Array;
  private off = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    if (data instanceof Uint8Array) {
      this.u8 = data;
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.u8 = new Uint8Array(data);
      this.view = new DataView(data);
    }
  }

  /**
   * Re-points the reader at a new buffer without allocating a new reader.
   * The client receives 20 snapshots a second and would otherwise churn a
   * ByteReader plus a DataView per packet.
   */
  reset(data: ArrayBuffer | Uint8Array): this {
    if (data instanceof Uint8Array) {
      this.u8 = data;
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.u8 = new Uint8Array(data);
      this.view = new DataView(data);
    }
    this.off = 0;
    return this;
  }

  u8v(): number {
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }

  i8v(): number {
    const v = this.view.getInt8(this.off);
    this.off += 1;
    return v;
  }

  u16v(): number {
    const v = this.view.getUint16(this.off);
    this.off += 2;
    return v;
  }

  i16v(): number {
    const v = this.view.getInt16(this.off);
    this.off += 2;
    return v;
  }

  u32v(): number {
    const v = this.view.getUint32(this.off);
    this.off += 4;
    return v;
  }

  f32v(): number {
    const v = this.view.getFloat32(this.off);
    this.off += 4;
    return v;
  }

  str(): string {
    const n = this.view.getUint8(this.off);
    this.off += 1;
    const s = decoder.decode(this.u8.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }

  angle16(): number {
    return (this.u16v() / 65535 - 0.5) * Math.PI * 2;
  }

  pitch16(): number {
    return (this.i16v() / 32767) * (Math.PI / 2);
  }

  get remaining(): number {
    return this.u8.length - this.off;
  }
}
