// Background-priority scheduler shim (Q-P4).
//
// Tries `scheduler.postTask({priority:'background'})` (Chromium origin
// trial-graduated; available in 94+), falls back to `requestIdleCallback`
// (Chromium + Firefox), and finally `setTimeout(0)` (Safari).
//
// The chunked mount path uses this to drain pendingMountQueue across
// idle ticks instead of doing all mounts synchronously in one rAF.

type Cancel = () => void;

type SchedulerPostTaskFn = (
  cb: () => void,
  opts: { priority: 'background' | 'user-blocking' | 'user-visible' },
) => { catch?: (reason: unknown) => void };

type SchedulerHost = { postTask?: SchedulerPostTaskFn };

export function scheduleBackground(cb: () => void): Cancel {
  const g = globalThis as { scheduler?: SchedulerHost; requestIdleCallback?: typeof requestIdleCallback };
  if (g.scheduler && typeof g.scheduler.postTask === 'function') {
    let cancelled = false;
    const wrapped = () => { if (!cancelled) cb(); };
    const ret = g.scheduler.postTask(wrapped, { priority: 'background' });
    // postTask returns a Promise that rejects when the task is cancelled.
    // We don't await it; we only need cancellation, which we model by
    // flagging `cancelled` and letting the postTask-fired callback no-op.
    if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    return () => { cancelled = true; };
  }
  if (typeof g.requestIdleCallback === 'function') {
    const id = g.requestIdleCallback(cb, { timeout: 500 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(cb, 0);
  return () => clearTimeout(id);
}
