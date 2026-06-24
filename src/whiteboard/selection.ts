// Multi-selection state for the whiteboard. Pure Set wrapper + a tiny
// CSS-class sync helper. Selection is a Set<uuid>; the DOM truth is the
// `.selected` class on each `.note` element.
//
// Behavior contract:
//   - click on a note (no shift) → selection becomes { uuid }
//   - shift-click on a note → toggle membership
//   - click on empty whiteboard → clear selection
//   - selection follows note removal (uuid drops out of the set silently)
//
// Perf notes (P3, P7):
//   - `forEach(cb)` exists alongside `values()` so hot paths
//     (pointerdown drag-build, arrow nudge) can iterate without paying for
//     a defensive `new Set(this.set)` copy on every call.
//   - `onChange` callback receives the *live* internal Set as a readonly
//     view (`ReadonlySet<string>`). Callers that need a snapshot must call
//     `.values()` explicitly. This lets the consumer maintain a diff cache
//     against the previous selection without doing two passes per emit.

export class Selection {
  private readonly set: Set<string> = new Set();
  private onChange?: (uuids: ReadonlySet<string>) => void;

  constructor(onChange?: (uuids: ReadonlySet<string>) => void) {
    this.onChange = onChange;
  }

  has(uuid: string): boolean {
    return this.set.has(uuid);
  }

  size(): number {
    return this.set.size;
  }

  /** Defensive snapshot — allocates. Use `forEach` on hot paths. */
  values(): Set<string> {
    return new Set(this.set);
  }

  /** Iterate selected uuids without allocating a snapshot Set. The callback
   *  must not mutate the selection during iteration. */
  forEach(cb: (uuid: string) => void): void {
    this.set.forEach((u) => cb(u));
  }

  /** Replace the selection with exactly `{uuid}`. */
  setOnly(uuid: string): void {
    if (this.set.size === 1 && this.set.has(uuid)) return;
    this.set.clear();
    this.set.add(uuid);
    this.emit();
  }

  /** Replace the selection with exactly `uuids`. No-op if identical. */
  setMany(uuids: Iterable<string>): void {
    const next = new Set(uuids);
    if (next.size === this.set.size) {
      let same = true;
      for (const u of next) if (!this.set.has(u)) { same = false; break; }
      if (same) return;
    }
    this.set.clear();
    for (const u of next) this.set.add(u);
    this.emit();
  }

  /** Toggle membership of `uuid`. */
  toggle(uuid: string): void {
    if (this.set.has(uuid)) this.set.delete(uuid);
    else this.set.add(uuid);
    this.emit();
  }

  /** Drop a uuid (e.g. note deleted). No-op if not present. */
  remove(uuid: string): void {
    if (!this.set.has(uuid)) return;
    this.set.delete(uuid);
    this.emit();
  }

  clear(): void {
    if (this.set.size === 0) return;
    this.set.clear();
    this.emit();
  }

  private emit(): void {
    // Pass the live set as readonly. Saves one allocation per emit (P3) and
    // lets the consumer compute a diff against its cached previous Set
    // without a second copy. Callers needing a snapshot use `.values()`.
    this.onChange?.(this.set);
  }
}
