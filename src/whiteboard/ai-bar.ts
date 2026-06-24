// Inline AI prompt bar for the whiteboard.
//
// Layout: a vertical event toast stack lives ABOVE the input. While a
// submission is in flight, the server streams progress events
// (`status`, `tool-call`, `tool-result`) and each one slides in from the
// bottom, sits for a beat, then slides out the top as newer events arrive.
// The input + status line are unchanged from v1.
//
// The bar itself doesn't talk to the network — it calls back into the host
// (whiteboard.ts → board.ts → src/lib/api.ts:aiArrangeStream). This keeps
// the component pure and easy to test.

import type { AiArrangeEvent } from '../lib/api';

export type AiBarOpts = {
  /** Submit handler. Called with the prompt + a per-submission event sink.
   *  Resolves with the final `{explanation, moved}` when the server's
   *  `done` event has been applied; null on failure. */
  onSubmit: (
    prompt: string,
    onEvent: (ev: AiArrangeEvent) => void,
  ) => Promise<{ explanation: string; moved: number } | null>;
};

export type AiBar = {
  el: HTMLElement;
  focus: () => void;
  /** Tear down listeners + clear any pending dismiss timers. Idempotent.
   *  In-flight aiArrangeStream submissions continue to completion (the bar
   *  itself doesn't own the fetch), but the bar will no-op on status writes
   *  once destroyed so a detached DOM never receives them. Review-finding
   *  fix: the whiteboard's destroy() now wires this through. */
  destroy: () => void;
};

/** How long a toast lingers after its enter animation before it self-fades.
 *  Newer events also push older toasts off the top of the stack early. */
const TOAST_LIFETIME_MS = 2400;
/** Max toasts visible at once. Older ones are dismissed when this is hit. */
const TOAST_MAX = 4;

export function createAiBar(opts: AiBarOpts): AiBar {
  const el = document.createElement('div');
  el.className = 'whiteboard-ai-bar';
  el.innerHTML = `
    <div class="whiteboard-ai-bar-events" data-events aria-live="polite"></div>
    <div class="whiteboard-ai-bar-row">
      <span aria-hidden="true">ai</span>
      <input type="text" placeholder='try: "cluster by tag" or "ring around the selected notes"' aria-label="ai arrange prompt">
      <span class="whiteboard-ai-bar-status" data-status></span>
    </div>
  `;
  const input = el.querySelector<HTMLInputElement>('input')!;
  const status = el.querySelector<HTMLElement>('[data-status]')!;
  const events = el.querySelector<HTMLElement>('[data-events]')!;
  let inflight = false;
  let destroyed = false;
  // Track every dismiss-timer + transitionend-fallback id so destroy() can
  // clear them — otherwise switching views mid-toast leaves orphaned timers
  // poking at detached DOM nodes (harmless, but the review flagged the leak).
  const pendingTimers = new Set<number>();
  function trackTimer(id: number): number {
    pendingTimers.add(id);
    return id;
  }

  function setStatus(msg: string, kind: 'idle' | 'error' = 'idle'): void {
    if (destroyed) return;
    status.textContent = msg;
    status.classList.toggle('error', kind === 'error');
  }

  // --- Toast stack ----------------------------------------------------------
  //
  // One DOM node per event. We append to the bottom (closest to the input),
  // mark .enter to play the slide-up keyframe, then schedule a dismiss
  // (.leave class) that triggers the exit transition. The transitionend
  // listener removes the node. If we exceed TOAST_MAX, the oldest toast is
  // dismissed early so the stack doesn't grow unbounded.

  function pushToast(text: string, kind: 'status' | 'tool' | 'result' | 'error'): void {
    const pill = document.createElement('div');
    pill.className = `whiteboard-ai-bar-event whiteboard-ai-bar-event--${kind}`;
    pill.textContent = text;
    events.appendChild(pill);

    // Force a layout read so the .enter class triggers a transition rather
    // than starting in the final state.
    void pill.offsetWidth;
    pill.classList.add('enter');

    // Auto-dismiss after lifetime.
    const dismissTimer = trackTimer(window.setTimeout(() => {
      pendingTimers.delete(dismissTimer);
      dismiss(pill);
    }, TOAST_LIFETIME_MS));
    (pill as HTMLElement & { __dismiss?: () => void }).__dismiss = () => {
      window.clearTimeout(dismissTimer);
      pendingTimers.delete(dismissTimer);
      dismiss(pill);
    };

    // Trim overflow from the top.
    while (events.children.length > TOAST_MAX) {
      const oldest = events.firstElementChild as HTMLElement | null;
      if (!oldest) break;
      const d = (oldest as HTMLElement & { __dismiss?: () => void }).__dismiss;
      if (d) d(); else dismiss(oldest);
    }
  }

  function dismiss(pill: HTMLElement): void {
    if (pill.classList.contains('leave')) return;
    pill.classList.add('leave');
    // Belt-and-suspenders: remove on transitionend OR after a hard timeout
    // (transition may not fire if the element is detached mid-flight, e.g.
    // when the whole bar is torn down between requests).
    const cleanup = () => pill.remove();
    pill.addEventListener('transitionend', cleanup, { once: true });
    const fallback = trackTimer(window.setTimeout(() => {
      pendingTimers.delete(fallback);
      cleanup();
    }, 600));
  }

  function clearToasts(): void {
    for (const child of Array.from(events.children) as HTMLElement[]) {
      const d = (child as HTMLElement & { __dismiss?: () => void }).__dismiss;
      if (d) d(); else dismiss(child);
    }
  }

  // --- Submit ---------------------------------------------------------------

  async function submit(): Promise<void> {
    const value = input.value.trim();
    if (!value || inflight) return;
    inflight = true;
    setStatus('thinking…');
    clearToasts();
    try {
      const result = await opts.onSubmit(value, (ev) => {
        // Map server events → toast pills. Keep the text short (one phrase).
        switch (ev.type) {
          case 'status':
            pushToast(ev.message, 'status');
            break;
          case 'tool-call':
            pushToast(`→ ${ev.name} (${ev.argsPreview})`, 'tool');
            break;
          case 'tool-result':
            pushToast(`✓ ${ev.name}: ${ev.resultPreview}`, 'result');
            break;
          case 'error':
            pushToast(ev.message, 'error');
            break;
          // 'done' is consumed by the caller; nothing to render here.
        }
      });
      if (!result) {
        setStatus('failed', 'error');
        trackTimer(window.setTimeout(() => {
          if (!destroyed) setStatus('');
        }, 2000));
        return;
      }
      const trimmed = result.explanation.length > 60
        ? result.explanation.slice(0, 57) + '…'
        : result.explanation;
      setStatus(trimmed);
      trackTimer(window.setTimeout(() => {
        if (!destroyed) setStatus('');
      }, 4000));
      input.value = '';
    } catch (err) {
      console.error('[ai-bar] submit threw', err);
      setStatus('error', 'error');
      trackTimer(window.setTimeout(() => {
        if (!destroyed) setStatus('');
      }, 2000));
    } finally {
      inflight = false;
    }
  }

  // --- Focus / keyboard plumbing (unchanged from v1) ------------------------
  //
  // Explicit focus on pointerdown. The whiteboard parent sets
  // `touch-action: none` so our pan/pinch handlers own gestures; on iOS
  // WKWebView (and occasionally desktop Safari) that suppresses the
  // synthesized click that would normally focus a tapped input. Forcing
  // focus from pointerdown sidesteps the whole issue. The whiteboard.ts
  // pointerdown handler still bails out for `.whiteboard-ai-bar` descendants
  // so pan/drag isn't triggered.
  el.addEventListener('pointerdown', (e) => {
    const target = e.target as Node;
    if (target === input) {
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    input.focus();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.value = '';
      setStatus('');
      clearToasts();
      input.blur();
    }
  });

  return {
    el,
    focus: () => input.focus(),
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      // Cancel every pending dismiss / transitionend-fallback / status-clear
      // timer so they don't fire on a detached bar.
      for (const id of pendingTimers) window.clearTimeout(id);
      pendingTimers.clear();
    },
  };
}
