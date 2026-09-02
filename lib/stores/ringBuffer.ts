/**
 * Fixed-capacity ring buffer over a Float64Array.
 *
 * Telemetry series deliberately live OUTSIDE reactive store state (see
 * lib/stores/README.md): the canvas rAF loop reads them directly at 60 fps,
 * so they must never be copied per commit or wrapped in immutable updates.
 * React learns about new samples only through a version counter in the fleet
 * store — one bump per batch, one render per bump.
 */
export class RingBuffer {
  readonly capacity: number;
  private readonly data: Float64Array;
  private head = 0; // next write index
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.data = new Float64Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  push(value: number): void {
    this.data[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  /** Sample i, 0 = oldest … length-1 = newest. Returns NaN out of range. */
  at(i: number): number {
    if (i < 0 || i >= this.count) return Number.NaN;
    const start = (this.head - this.count + this.capacity) % this.capacity;
    return this.data[(start + i) % this.capacity] ?? Number.NaN;
  }

  last(): number | undefined {
    return this.count === 0 ? undefined : this.at(this.count - 1);
  }

  /**
   * Copy oldest→newest into `target` (zero-alloc read for the canvas loop:
   * allocate one scratch Float64Array per strip, reuse it every frame).
   * Returns the number of samples written (min(length, target.length)).
   */
  copyInto(target: Float64Array): number {
    const n = Math.min(this.count, target.length);
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < n; i += 1) {
      target[i] = this.data[(start + i) % this.capacity] ?? Number.NaN;
    }
    return n;
  }

  /**
   * Copy the NEWEST `n` samples, oldest→newest, into `target[0…]`; returns the
   * number written (`min(n, length, target.length)`, 0 for a non-positive n).
   *
   * `copyInto` for readers that only want the tail. A trend fit over a 15 s
   * window off a 60 s ring is 150 samples of 600, and copying the other 450 to
   * reach them is four fifths of the read spent on samples the caller then
   * skips. Same zero-alloc contract: one reusable scratch array, no
   * subarray, no `Array.from`.
   */
  copyTail(target: Float64Array, n: number): number {
    const count = Math.min(n, this.count, target.length);
    if (count <= 0) return 0;
    const start = (this.head - count + this.capacity) % this.capacity;
    for (let i = 0; i < count; i += 1) {
      target[i] = this.data[(start + i) % this.capacity] ?? Number.NaN;
    }
    return count;
  }

  /** Convenience for tests and non-hot paths; allocates. */
  toArray(): number[] {
    const out = new Array<number>(this.count);
    for (let i = 0; i < this.count; i += 1) out[i] = this.at(i);
    return out;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}
