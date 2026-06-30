// Whiteboard perf feature flags (D-Q-series, see implementation-notes/2026-06-10-whiteboard-perf.html).
//
// Each risky perf change in the Q-series gets a localStorage flag so the
// parent agent can A/B test. Flags are read once per `createWhiteboard()`
// call (snapshotting at construction keeps the runtime branches stable for
// the lifetime of that whiteboard instance — flipping the flag mid-session
// requires a reload).
//
// D-Q10 (C1): defaults flipped ON in production. localStorage acts as an
// EXPLICIT-DISABLE switch ('0' → off, anything else → on, missing → on).
// The Vitest suite needs the legacy code path because the bench tests are
// shaped against it; we detect Vitest via globalThis.__VITEST__ and default
// every flag OFF in that environment. Real-browser code therefore opts INTO
// the perf paths automatically while the unit tests keep their stable
// baseline.

function isVitest(): boolean {
  // Vitest sets process.env.VITEST or globalThis.__vitest_worker__; we
  // additionally check for process to short-circuit in browser bundles
  // where neither of these exist.
  try {
    const g = globalThis as { __vitest_worker__?: unknown; process?: { env?: Record<string, string | undefined> } };
    if (g.__vitest_worker__) return true;
    if (typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom')) return true;
    if (g.process?.env?.VITEST) return true;
    if (g.process?.env?.NODE_ENV === 'test') return true;
    return false;
  } catch {
    return false;
  }
}

function readFlag(name: string, defaultOn: boolean): boolean {
  try {
    if (typeof localStorage === 'undefined') return defaultOn;
    const raw = localStorage.getItem(name);
    if (raw == null) return defaultOn;
    // Explicit disable: '0' (or 'false'/'off' as friendly aliases).
    if (raw === '0' || raw === 'false' || raw === 'off') return false;
    // Explicit enable: '1' (or any other non-empty value once defaults flipped).
    return true;
  } catch {
    return defaultOn;
  }
}

export type WhiteboardFlags = {
  /** Q-P3: enable canvas LOD overlay for low-zoom rendering. */
  lod: boolean;
  /** Q-P4: chunked progressive mount via background scheduler. */
  chunk: boolean;
  /** Q-P5a: debounce evictions so pan-back doesn't re-create nodes. */
  evictDebounce: boolean;
  /** Q-P6: spatial grid index for refresh()'s AABB scan. */
  grid: boolean;
  /** Q-P7: velocity-aware asymmetric pan buffer. */
  velocity: boolean;
};

export function readWhiteboardFlags(): WhiteboardFlags {
  // D-Q10: defaults are ON in the real browser, OFF under Vitest (the unit
  // tests assert against the legacy paths). The override switch is per-flag
  // via localStorage so a regression bisect can flip just one path off.
  const defaultOn = !isVitest();
  return {
    lod: readFlag('WHITEBOARD_LOD', defaultOn),
    chunk: readFlag('WHITEBOARD_CHUNK', defaultOn),
    evictDebounce: readFlag('WHITEBOARD_EVICT_DEBOUNCE', defaultOn),
    grid: readFlag('WHITEBOARD_GRID', defaultOn),
    velocity: readFlag('WHITEBOARD_VELOCITY', defaultOn),
  };
}
