import {
  chatWithNotesStream,
  createAgentSession,
  deleteAgentSession,
  getAgentHistory,
  getAgentSession,
  getAgentCodexAuth,
  getSuggestedQuestions,
  listAgentSessions,
  pollAgentCodexDeviceAuth,
  startAgentCodexDeviceAuth,
  stopAgentSession,
  saveAgentMessageTurn,
  saveChatNote,
  saveWikiPage,
  streamPiTurn,
  type ChatMessage,
  type ChatSourceNote,
} from './lib/api';
import type { AgentCodexAuthStatus, AgentCodexDeviceStart, AgentEvent, AgentSession, AgentThinkingLevel, AgentTurn, Note } from './lib/types';
import { noteBgFor } from './lib/colors';
import { noteDisplayTitle, notePreviewText, noteSourceHost } from './lib/link-note';
import { fmtDate } from './lib/format';

type AgentViewOpts = {
  onNoteSaved?: (note: Note) => void;
  onOpenSource?: (uuid: string) => void;
  getAllTags: () => string[];
};

type AgentActivityKind = 'status' | 'thinking' | 'writing' | 'tool' | 'result' | 'error';
type AgentTraceKind = 'status' | 'thinking' | 'tool' | 'result' | 'error';
type AgentTraceRow = { key: string; kind: AgentTraceKind; label: string; text: string; append?: boolean };

const AGENT_SESSION_KEY = 'agentSessionId';
const AGENT_STARTUP_DEBUG_KEY = 'agentStartupDebug';
const AGENT_AUTO_STOP_MS = 15 * 60 * 1000;
const AGENT_READY_POLL_MS = 2_000;
const AGENT_READY_POLLS = 15;
const AGENT_MODEL_OPTIONS = [
  { label: 'default (codex 5.5)', value: '' },
  { label: 'codex 5.5', value: 'openai-codex/gpt-5.5' },
  { label: 'codex 5.4', value: 'openai-codex/gpt-5.4' },
  { label: 'opus 4.6', value: 'amazon-bedrock/us.anthropic.claude-opus-4-6-v1' },
  { label: 'opus 4.7', value: 'amazon-bedrock/us.anthropic.claude-opus-4-7' },
  { label: 'sonnet 4.5', value: 'amazon-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0' },
  { label: 'haiku 4.5', value: 'amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0' },
];
const AGENT_EFFORT_OPTIONS: AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export function createAgentView(opts: AgentViewOpts): {
  el: HTMLElement;
  startFromNote: (note: Pick<Note, 'text' | 'tags'>) => Promise<void>;
} {
  const el = document.createElement('section');
  el.className = 'agent-view';
  el.hidden = true;
  el.innerHTML = `
    <div class="agent-shell">
      <section class="agent-chat">
        <div class="agent-runtime-strip">
          <p data-runtime-summary>ask a question; <code>Cloudflare Sandbox</code> starts automatically.</p>
          <button type="button" class="agent-setup-open" data-open-setup>setup</button>
        </div>
        <dialog class="agent-setup-modal" data-setup-dialog>
          <div class="agent-setup-card">
            <button type="button" class="agent-setup-close" data-close-setup aria-label="close setup">×</button>
            <p class="agent-empty-kicker">Codex setup</p>
            <h2>Use your Codex subscription</h2>
            <p class="agent-setup-copy">Start login, open OpenAI’s device page, enter the code, and Links saves Codex automatically.</p>
            <dl class="agent-runtime-meta" data-runtime-meta></dl>
            <div class="agent-codex-device">
              <button type="button" class="agent-send" data-start-codex-device>start Codex login</button>
              <div class="agent-codex-code" data-codex-device hidden>
                <span>enter this code</span>
                <strong data-codex-user-code></strong>
                <a data-codex-link target="_blank" rel="noopener">open OpenAI device page</a>
              </div>
              <p class="agent-codex-status" data-codex-status></p>
            </div>
            <div class="agent-setup-actions">
              <button type="button" class="agent-save agent-save--ghost" data-startup-debug></button>
              <button type="button" class="agent-save agent-save--ghost" data-start-session>start sandbox</button>
              <button type="button" class="agent-save agent-save--ghost" data-stop-session>stop sandbox</button>
            </div>
          </div>
        </dialog>
        <div class="agent-history-bar">
          <button type="button" class="agent-history-btn" data-history-toggle>history</button>
          <button type="button" class="agent-history-btn" data-new-chat>new</button>
          <button type="button" class="agent-history-btn agent-history-btn--danger" data-delete-chat disabled>delete</button>
        </div>
        <div class="agent-history-panel" data-history-panel hidden></div>
        <div class="agent-chat-log" data-log>
          <section class="agent-empty-state" data-empty-state>
            <p class="agent-empty-kicker">Ask your links</p>
            <h2>What should we work through?</h2>
          </section>
        </div>
        <div class="agent-composer-wrap">
          <form class="agent-composer" data-form>
            <textarea data-input rows="1" placeholder="Ask anything…" aria-label="ask your links" autocomplete="off" autocapitalize="sentences" enterkeyhint="send"></textarea>
            <div class="agent-composer-foot">
              <div class="agent-composer-controls" aria-label="agent settings">
                <select class="agent-composer-select" data-model aria-label="model">${AGENT_MODEL_OPTIONS.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')}</select>
                <select class="agent-composer-select" data-effort aria-label="effort">${AGENT_EFFORT_OPTIONS.map((level) => `<option value="${level}"${level === 'medium' ? ' selected' : ''}>${level}</option>`).join('')}</select>
              </div>
              <span class="agent-status" data-status></span>
              <button type="submit" class="agent-send">ask</button>
            </div>
          </form>
          <div class="agent-suggestions" data-suggestions aria-label="suggested questions"></div>
        </div>
      </section>

    </div>
  `;

  const log = el.querySelector<HTMLElement>('[data-log]')!;
  const composerWrap = el.querySelector<HTMLElement>('.agent-composer-wrap')!;
  const form = el.querySelector<HTMLFormElement>('[data-form]')!;
  const input = el.querySelector<HTMLTextAreaElement>('[data-input]')!;
  const modelSelect = el.querySelector('[data-model]') as unknown as HTMLSelectElement;
  const effortSelect = el.querySelector('[data-effort]') as unknown as HTMLSelectElement;
  const suggestions = el.querySelector<HTMLElement>('[data-suggestions]')!;
  const emptyState = el.querySelector<HTMLElement>('[data-empty-state]')!;
  const status = el.querySelector<HTMLElement>('[data-status]')!;
  const runtimeSummary = el.querySelector<HTMLElement>('[data-runtime-summary]')!;
  const runtimeMeta = el.querySelector<HTMLElement>('[data-runtime-meta]')!;
  const historyPanel = el.querySelector<HTMLElement>('[data-history-panel]')!;
  const historyToggleBtn = el.querySelector<HTMLButtonElement>('[data-history-toggle]')!;
  const newChatBtn = el.querySelector<HTMLButtonElement>('[data-new-chat]')!;
  const deleteChatBtn = el.querySelector<HTMLButtonElement>('[data-delete-chat]')!;
  const openSetupBtn = el.querySelector<HTMLButtonElement>('[data-open-setup]')!;
  const setupDialog = el.querySelector<HTMLDialogElement>('[data-setup-dialog]')!;
  const closeSetupBtn = el.querySelector<HTMLButtonElement>('[data-close-setup]')!;
  const startupDebugBtn = el.querySelector<HTMLButtonElement>('[data-startup-debug]')!;
  const startSessionBtn = el.querySelector<HTMLButtonElement>('[data-start-session]')!;
  const stopSessionBtn = el.querySelector<HTMLButtonElement>('[data-stop-session]')!;
  const startCodexDeviceBtn = el.querySelector<HTMLButtonElement>('[data-start-codex-device]')!;
  const codexDevicePanel = el.querySelector<HTMLElement>('[data-codex-device]')!;
  const codexUserCode = el.querySelector<HTMLElement>('[data-codex-user-code]')!;
  const codexDeviceLink = el.querySelector<HTMLAnchorElement>('[data-codex-link]')!;
  const codexStatus = el.querySelector<HTMLElement>('[data-codex-status]')!;

  const history: ChatMessage[] = [];
  const answerByMessage = new WeakMap<HTMLElement, string>();
  const sourcesByMessage = new WeakMap<HTMLElement, ChatSourceNote[]>();
  let inflight = false;
  let session: AgentSession | null = null;
  let sessionStartPromise: Promise<AgentSession | null> | null = null;
  let autoStopTimer: number | null = null;
  let suggestedQuestions: string[] = [];
  let suggestionsRefreshing = false;
  let sessions: AgentSession[] = [];
  let sessionsRefreshing = false;
  let codexAuth: AgentCodexAuthStatus | null = null;
  let codexDevice: AgentCodexDeviceStart | null = null;
  let codexDevicePollTimer: number | null = null;
  let scrollToBottomRaf: number | null = null;
  let shouldStickToBottom = true;
  let startupDebugEnabled = loadStartupDebugEnabled();
  let startupTrace: {
    started: number;
    createMs?: number;
    waitMs?: number;
    bootstrapMs?: number;
    firstEventMs?: number;
    server?: {
      readyMs?: number;
      turnMs?: number;
      streamMs?: number;
      firstByteMs?: number;
      firstPiEventMs?: number;
      firstThinkingMs?: number;
      doneMs?: number;
    };
    serverLocked?: boolean;
  } | null = null;

  void refreshCodexAuth();
  void restoreSession();
  void refreshSessionList();
  void refreshSuggestedQuestions();
  renderStartupDebugToggle();

  const updateStickToBottom = () => {
    shouldStickToBottom = isNearPageBottom();
  };
  window.addEventListener('scroll', updateStickToBottom, { passive: true });
  log.addEventListener('scroll', updateStickToBottom, { passive: true });

  suggestions.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const refresh = target.closest<HTMLButtonElement>('[data-suggestions-refresh]');
    if (refresh && !inflight) {
      void refreshSuggestedQuestions({ force: true });
      return;
    }
    const chip = target.closest<HTMLButtonElement>('[data-suggestion]');
    if (!chip || inflight) return;
    input.value = chip.dataset.suggestion || chip.textContent || '';
    form.requestSubmit();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    e.preventDefault();
    form.requestSubmit();
  });

  historyToggleBtn.addEventListener('click', () => {
    historyPanel.hidden = !historyPanel.hidden;
    if (!historyPanel.hidden) void refreshSessionList();
  });

  historyPanel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const del = target.closest<HTMLButtonElement>('[data-delete-session]');
    const load = target.closest<HTMLButtonElement>('[data-load-session]');
    if (del?.dataset.deleteSession) void deleteConversation(del.dataset.deleteSession);
    else if (load?.dataset.loadSession) void loadConversation(load.dataset.loadSession);
  });

  newChatBtn.addEventListener('click', () => { void startNewChat(); });
  deleteChatBtn.addEventListener('click', () => { if (session) void deleteConversation(session.id); });
  startupDebugBtn.addEventListener('click', () => {
    startupDebugEnabled = !startupDebugEnabled;
    persistStartupDebugEnabled(startupDebugEnabled);
    renderStartupDebugToggle();
    renderRuntimeMeta();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message || inflight) return;
    inflight = true;
    suggestedQuestions = [];
    setChatEnabled(false);
    status.textContent = 'asking…';
    appendMessage('user', message);
    history.push({ role: 'user', content: message });
    input.value = '';

    let assistantNode: HTMLElement | null = null;
    let streamedAnswer = '';
    let turnSources: ChatSourceNote[] = [];
    const activityChips = new Map<string, HTMLElement>();
    const traceRows = new Map<string, HTMLElement>();
    const setAssistantText = (text: string) => {
      if (!assistantNode) assistantNode = appendMessage('assistant', '');
      renderMessageText(assistantNode, 'assistant', text);
      scrollChatToEnd();
    };
    const showActivity = (key: string, text: string, kind: AgentActivityKind) => {
      if (!assistantNode) assistantNode = appendMessage('assistant', '');
      let activity = assistantNode.querySelector<HTMLElement>('.agent-activity');
      if (!activity) {
        activity = document.createElement('div');
        activity.className = 'agent-activity';
        activity.setAttribute('aria-live', 'polite');
        assistantNode.appendChild(activity);
      }
      let chip = activityChips.get(key);
      if (!chip) {
        chip = document.createElement('span');
        chip.dataset.activityKey = key;
        activityChips.set(key, chip);
        activity.appendChild(chip);
      }
      chip.className = `agent-activity-chip agent-activity-chip--${kind}`;
      chip.textContent = text;
      while (activity.children.length > 6) {
        const oldest = activity.firstElementChild as HTMLElement | null;
        if (!oldest) break;
        activityChips.delete(oldest.dataset.activityKey || '');
        oldest.remove();
      }
      scrollChatToEnd();
    };
    const clearActivity = (key: string) => {
      activityChips.get(key)?.remove();
      activityChips.delete(key);
    };
    const ensureTrace = () => {
      if (!assistantNode) assistantNode = appendMessage('assistant', '');
      let trace = assistantNode.querySelector<HTMLDetailsElement>('.agent-trace');
      if (!trace) {
        trace = document.createElement('details');
        trace.className = 'agent-trace';
        trace.open = false;
        trace.innerHTML = '<summary><span class="agent-trace-summary">model thinking</span></summary><div class="agent-trace-list"></div>';
        const body = assistantNode.querySelector<HTMLElement>('.agent-msg-body');
        if (body) assistantNode.insertBefore(trace, body);
        else assistantNode.appendChild(trace);
      }
      return trace;
    };
    const showTrace = (row: AgentTraceRow) => {
      const trace = ensureTrace();
      const list = trace.querySelector<HTMLElement>('.agent-trace-list')!;
      let item = traceRows.get(row.key);
      if (!item) {
        item = document.createElement('article');
        item.className = `agent-trace-row agent-trace-row--${row.kind}`;
        item.dataset.traceKey = row.key;
        item.innerHTML = '<div class="agent-trace-label"></div><pre class="agent-trace-body"></pre>';
        traceRows.set(row.key, item);
        list.appendChild(item);
      }
      item.className = `agent-trace-row agent-trace-row--${row.kind}`;
      item.querySelector<HTMLElement>('.agent-trace-label')!.textContent = row.label;
      const body = item.querySelector<HTMLElement>('.agent-trace-body')!;
      body.textContent = row.append ? `${body.textContent || ''}${row.text}` : row.text;
      while (list.children.length > 40) {
        const oldest = list.firstElementChild as HTMLElement | null;
        if (!oldest) break;
        traceRows.delete(oldest.dataset.traceKey || '');
        oldest.remove();
      }
      scrollChatToEnd();
    };
    const modelId = modelSelect.value || undefined;
    const thinkingLevel = effortSelect.value as AgentThinkingLevel;
    const readySession = await ensureReadySession(message);
    const firstEventAt = { seen: false, started: Date.now() };
    let firstEventTimer: number | null = null;
    const stopFirstEventTimer = () => {
      if (firstEventTimer !== null) {
        window.clearInterval(firstEventTimer);
        firstEventTimer = null;
      }
    };
    const markFirstEvent = () => {
      if (!readySession || firstEventAt.seen) return;
      firstEventAt.seen = true;
      stopFirstEventTimer();
      if (startupTrace && startupTrace.firstEventMs == null) {
        startupTrace.firstEventMs = Date.now() - firstEventAt.started;
        renderRuntimeMeta();
      }
    };
    if (readySession) {
      status.textContent = 'pi running… waiting for first event';
      firstEventTimer = window.setInterval(() => {
        if (firstEventAt.seen) return;
        status.textContent = `pi running ${formatStartupMs(Date.now() - firstEventAt.started)}`;
      }, 250);
    }
    const fallbackSession = readySession ? null : session;
    if (!readySession) {
      status.textContent = 'sandbox unavailable; using links chat fallback…';
      showTrace({ key: 'fallback', kind: 'status', label: 'runtime', text: 'sandbox unavailable; using links chat fallback' });
      if (fallbackSession) await saveAgentMessageTurn(fallbackSession.id, 'user', message);
    } else {
      showActivity('thinking', 'thinking', 'thinking');
      showTrace({ key: 'turn-start', kind: 'status', label: 'turn', text: 'stream started' });
    }
    const recordStartupServerPhase = (phase: string, elapsedMs: number) => {
      if (!startupDebugEnabled || !startupTrace || startupTrace.serverLocked) return;
      const server = startupTrace.server ??= {};
      switch (phase) {
        case 'session-ready':
          if (server.readyMs == null) server.readyMs = elapsedMs;
          break;
        case 'turn-created':
          if (server.turnMs == null) server.turnMs = elapsedMs;
          break;
        case 'stream-start':
          if (server.streamMs == null) server.streamMs = elapsedMs;
          break;
        case 'first-byte':
          if (server.firstByteMs == null) server.firstByteMs = elapsedMs;
          break;
        case 'first-pi-event':
          if (server.firstPiEventMs == null) server.firstPiEventMs = elapsedMs;
          break;
        case 'first-thinking':
          if (server.firstThinkingMs == null) server.firstThinkingMs = elapsedMs;
          break;
        case 'done':
          if (server.doneMs == null) server.doneMs = elapsedMs;
          startupTrace.serverLocked = true;
          break;
        default:
          break;
      }
      renderRuntimeMeta();
    };
    const result = readySession
      ? await streamPiTurn(readySession.id, message, (ev) => {
        if (ev.type === 'debug') {
          recordStartupServerPhase(ev.phase, ev.elapsedMs);
          return;
        }
        markFirstEvent();
        if (ev.type === 'status') {
          status.textContent = summarizeTopStatus(ev.message);
          showActivity('status', compactActivityText(ev.message), ev.message.includes('thinking') ? 'thinking' : 'status');
          showTrace({ key: `status:${ev.message}`, kind: 'status', label: 'status', text: summarizeStatusTraceText(ev.message) });
        } else if (ev.type === 'stdout') {
          streamedAnswer += ev.text;
          setAssistantText(streamedAnswer);
          showActivity('writing', 'writing…', 'writing');
          showTrace({ key: 'stdout', kind: 'result', label: 'answer stream', text: ev.text, append: true });
          status.textContent = 'writing';
        } else if (ev.type === 'stderr') {
          status.textContent = 'sandbox stderr';
          showActivity('stderr', 'stderr', 'error');
          showTrace({ key: 'stderr', kind: 'error', label: 'stderr', text: ev.text, append: true });
        } else if (ev.type === 'raw') {
          status.textContent = 'running';
          showTrace({ key: `raw:${ev.stream}`, kind: ev.stream === 'stderr' ? 'error' : 'status', label: `raw ${ev.stream}`, text: ev.text, append: true });
        } else if (ev.type === 'event') {
          status.textContent = summarizeAgentEventStatus(ev.event);
          showEventActivity(ev.event, showActivity);
          showTrace(traceAgentEvent(ev.event));
        } else if (ev.type === 'pi_event') {
          status.textContent = summarizePiEventStatus(ev.event);
          turnSources = mergeSourceNotes(turnSources, sourcesFromPiEvent(ev.event));
          const activity = describePiActivity(ev.event);
          if (activity) showActivity(activity.key, activity.text, activity.kind);
          const rows = tracePiEvent(ev.event);
          for (const row of rows) showTrace(row);
          if (!rows.length && !shouldHideRawPiEvent(ev.event)) showTrace(traceRawPiEvent(ev.event));
        } else if (ev.type === 'pi_entries') {
          status.textContent = 'saving history';
          showActivity('mirror', `mirrored ${ev.imported} pi entries`, 'result');
          showTrace({ key: 'pi_entries', kind: 'result', label: 'mirrored pi entries', text: `${ev.imported} imported` });
        } else if (ev.type === 'done') {
          setAssistantText(ev.answer);
          if (assistantNode) finalizeAssistantMessage(assistantNode, ev.answer, turnSources);
          clearActivity('status');
          clearActivity('thinking');
          clearActivity('writing');
          showActivity('done', 'done', 'result');
          showTrace({ key: 'done', kind: 'result', label: 'done', text: 'assistant answer complete' });
          history.push({ role: 'assistant', content: ev.answer });
          status.textContent = 'done';
          if (startupTrace) startupTrace.serverLocked = true;
        } else if (ev.type === 'error') {
          status.textContent = ev.message;
          showActivity('error', ev.message.slice(0, 80), 'error');
          showTrace({ key: 'error', kind: 'error', label: 'error', text: ev.message });
          if (startupTrace) startupTrace.serverLocked = true;
        }
      }, { modelId, thinkingLevel, debug: startupDebugEnabled })
      : await chatWithNotesStream(message, history.slice(0, -1), (ev) => {
        if (ev.type === 'status') {
          status.textContent = ev.message;
        } else if (ev.type === 'sources') {
          turnSources = ev.notes;
        } else if (ev.type === 'stdout') {
          streamedAnswer += ev.text;
          setAssistantText(streamedAnswer);
          status.textContent = 'streaming answer';
        } else if (ev.type === 'done') {
          setAssistantText(ev.answer);
          if (assistantNode) finalizeAssistantMessage(assistantNode, ev.answer, turnSources);
          history.push({ role: 'assistant', content: ev.answer });
          status.textContent = 'done';
        } else if (ev.type === 'error') {
          status.textContent = ev.message;
        }
      });
    stopFirstEventTimer();

    if (!readySession && fallbackSession && result?.answer) {
      await saveAgentMessageTurn(fallbackSession.id, 'assistant', result.answer);
    }
    if (!result && !assistantNode) appendMessage('assistant', 'Request failed.');
    inflight = false;
    setChatEnabled(true);
    scheduleAutoStop();
    void refreshSessionList();
  });

  startSessionBtn.addEventListener('click', async () => {
    startSessionBtn.disabled = true;
    const ready = await startAndPrepareSession();
    status.textContent = ready ? 'sandbox ready for pi prompts' : 'sandbox start failed';
    startSessionBtn.disabled = false;
  });

  async function ensureReadySession(title?: string): Promise<AgentSession | null> {
    if (session && isRunnableSession(session)) return session;
    if (session?.status === 'stub') return null;
    if (session?.status === 'starting') return waitForRunnableSession(session.id);
    if (session?.status === 'stopped' || session?.status === 'error') {
      clearStoredSessionId();
      session = null;
    }
    sessionStartPromise ??= startAndPrepareSession(title).finally(() => { sessionStartPromise = null; });
    return sessionStartPromise;
  }

  async function startAndPrepareSession(title = 'links sandbox'): Promise<AgentSession | null> {
    const started = Date.now();
    startupTrace = { started };
    showStartupStatus(started, 'starting sandbox');
    const next = await createAgentSession(compactSessionTitle(title));
    startupTrace.createMs = Date.now() - started;
    if (!next.session) {
      runtimeSummary.textContent = next.detail || next.error || 'sandbox start failed';
      status.textContent = next.providerError || next.error || 'sandbox start failed';
      return null;
    }
    if (next.session.status === 'stub') {
      session = null;
      clearStoredSessionId();
      renderSession();
      runtimeSummary.textContent = next.session.errorMessage || 'sandbox unavailable; using links chat fallback.';
      void refreshSessionList();
      return null;
    }
    session = next.session;
    persistSessionId(next.session.id);
    renderSession();
    showStartupStatus(started, 'waiting for sandbox');
    void refreshSessionList();
    if (!isRunnableSession(next.session) && next.session.status !== 'starting') return null;
    const ready = isRunnableSession(next.session) ? next.session : await waitForRunnableSession(next.session.id, started);
    if (!ready) return null;
    startupTrace.waitMs = Date.now() - started - startupTrace.createMs;
    session = ready;
    renderSession();
    scheduleAutoStop();
    const done = `pi ready ${formatStartupMs(Date.now() - started)}`;
    runtimeSummary.textContent = done;
    status.textContent = done;
    renderRuntimeMeta();
    return ready;
  }

  async function waitForRunnableSession(id: string, started = Date.now()): Promise<AgentSession | null> {
    for (let i = 0; i < AGENT_READY_POLLS; i += 1) {
      showStartupStatus(started, 'waiting for sandbox');
      await sleep(AGENT_READY_POLL_MS);
      const next = await getAgentSession(id);
      if (!next) return null;
      session = next;
      renderSession();
      if (isRunnableSession(next)) return next;
      if (next.status === 'error' || next.status === 'stopped') return null;
    }
    status.textContent = 'sandbox is still starting; try again in a few seconds';
    return null;
  }

  function isRunnableSession(value: AgentSession): boolean {
    return value.status === 'ready';
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function formatStartupMs(ms: number): string {
    const seconds = Math.max(0, ms) / 1000;
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  }

  function showStartupStatus(started: number, label: string) {
    const text = `${label} ${formatStartupMs(Date.now() - started)}`;
    runtimeSummary.textContent = text;
    status.textContent = text;
  }


  openSetupBtn.addEventListener('click', () => {
    if (!setupDialog.open) setupDialog.showModal();
    startCodexDeviceBtn.focus();
  });

  closeSetupBtn.addEventListener('click', () => setupDialog.close());
  setupDialog.addEventListener('close', resetCodexDeviceLogin);

  stopSessionBtn.addEventListener('click', async () => {
    if (!session) return;
    stopSessionBtn.disabled = true;
    const stopped = await stopAgentSession(session.id);
    if (stopped) {
      clearAutoStop();
      session = stopped;
      clearStoredSessionId();
      renderSession();
      void refreshSessionList();
    } else {
      runtimeSummary.textContent = 'failed to stop sandbox';
    }
    stopSessionBtn.disabled = false;
  });

  startCodexDeviceBtn.addEventListener('click', async () => {
    clearCodexDevicePoll();
    codexStatus.textContent = 'starting Codex login…';
    startCodexDeviceBtn.disabled = true;
    const device = await startAgentCodexDeviceAuth();
    if (!device) {
      codexStatus.textContent = 'could not start Codex login';
      startCodexDeviceBtn.disabled = false;
      return;
    }
    codexDevice = device;
    renderCodexDevice(device);
    codexStatus.textContent = 'enter the code at OpenAI; waiting…';
    status.textContent = 'waiting for Codex login…';
    scheduleCodexDevicePoll(device.intervalSeconds * 1000);
  });

  function renderCodexDevice(device: AgentCodexDeviceStart) {
    codexDevicePanel.hidden = false;
    codexUserCode.textContent = device.userCode;
    codexDeviceLink.href = device.verificationUri;
    codexDeviceLink.textContent = device.verificationUri.replace(/^https?:\/\//, '');
  }

  function clearCodexDevicePoll() {
    if (codexDevicePollTimer !== null) window.clearTimeout(codexDevicePollTimer);
    codexDevicePollTimer = null;
  }

  function resetCodexDeviceLogin() {
    const wasPending = !!codexDevice;
    clearCodexDevicePoll();
    codexDevice = null;
    codexDevicePanel.hidden = true;
    startCodexDeviceBtn.disabled = false;
    if (wasPending) codexStatus.textContent = '';
  }

  function scheduleCodexDevicePoll(ms: number) {
    clearCodexDevicePoll();
    codexDevicePollTimer = window.setTimeout(() => { void pollCodexDevice(); }, Math.max(1000, ms));
  }

  async function pollCodexDevice() {
    codexDevicePollTimer = null;
    if (!codexDevice) return;
    const result = await pollAgentCodexDeviceAuth(codexDevice.id);
    if (!result) {
      codexStatus.textContent = 'Codex login check failed; try again';
      startCodexDeviceBtn.disabled = false;
      return;
    }
    if (result.status === 'complete') {
      codexAuth = result.auth;
      codexDevice = null;
      codexDevicePanel.hidden = true;
      startCodexDeviceBtn.disabled = false;
      codexStatus.textContent = 'saved — Codex is ready';
      status.textContent = 'codex login complete';
      renderSession();
      return;
    }
    if (result.status === 'expired' || Date.now() > codexDevice.expiresAt) {
      codexStatus.textContent = 'Codex login expired; start again';
      startCodexDeviceBtn.disabled = false;
      return;
    }
    if (result.status === 'failed') {
      codexStatus.textContent = result.error || 'Codex login failed; try again';
      startCodexDeviceBtn.disabled = false;
      return;
    }
    codexStatus.textContent = 'waiting for OpenAI approval…';
    scheduleCodexDevicePoll((result.intervalSeconds ?? codexDevice.intervalSeconds) * 1000);
  }

  async function refreshCodexAuth() {
    codexAuth = await getAgentCodexAuth();
    renderSession();
  }

  function scheduleAutoStop() {
    clearAutoStop();
    if (!session || session.status === 'stopped') return;
    autoStopTimer = window.setTimeout(() => { void stopIdleSession(); }, AGENT_AUTO_STOP_MS);
  }

  async function stopIdleSession() {
    autoStopTimer = null;
    if (inflight || !session || session.status === 'stopped') {
      scheduleAutoStop();
      return;
    }
    const id = session.id;
    status.textContent = 'stopping idle sandbox…';
    const stopped = await stopAgentSession(id);
    if (stopped && session?.id === id) {
      session = stopped;
      clearStoredSessionId();
      renderSession();
      status.textContent = 'idle sandbox stopped; ask again to start a new one';
      void refreshSessionList();
    }
  }

  function clearAutoStop() {
    if (autoStopTimer !== null) window.clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }

  log.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const source = target.closest<HTMLElement>('[data-source-uuid]');
    if (source?.dataset.sourceUuid) {
      opts.onOpenSource?.(source.dataset.sourceUuid);
      return;
    }
    const ref = target.closest<HTMLElement>('[data-source-ref]');
    if (ref) {
      const msg = ref.closest<HTMLElement>('.agent-msg');
      const idx = ref.dataset.sourceRef;
      const card = msg?.querySelector<HTMLElement>(`[data-source-idx="${idx}"]`);
      const uuid = card?.dataset.sourceUuid;
      if (uuid) opts.onOpenSource?.(uuid);
      const sources = card?.closest<HTMLDetailsElement>('details.agent-msg-sources');
      if (sources) sources.open = true;
      card?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const saveWiki = target.closest<HTMLButtonElement>('[data-save-wiki]');
    if (saveWiki) {
      const msg = saveWiki.closest<HTMLElement>('.agent-msg');
      const text = msg ? answerByMessage.get(msg) : '';
      if (!text) return;
      const title = window.prompt('Wiki page title?', firstLine(text));
      if (!title) return;
      saveWiki.disabled = true;
      saveWiki.textContent = 'saving…';
      const sources = msg ? sourcesByMessage.get(msg) ?? [] : [];
      const page = await saveWikiPage({
        title,
        contentMd: text,
        sourceRefs: sources.map((note) => ({ uuid: note.uuid, updatedAt: note.updatedAt, excerpt: note.text.replace(/\s+/g, ' ').trim().slice(0, 240) })),
      });
      saveWiki.textContent = page ? 'wiki saved' : 'save failed';
      if (!page) saveWiki.disabled = false;
      return;
    }
    const save = target.closest<HTMLButtonElement>('[data-save-message]');
    const msg = save?.closest<HTMLElement>('.agent-msg');
    const text = msg ? answerByMessage.get(msg) : '';
    if (!save || !text) return;
    save.disabled = true;
    save.textContent = 'saving…';
    const note = await saveChatNote(text);
    save.textContent = note ? 'saved' : 'save failed';
    if (note) {
      opts.onNoteSaved?.(note);
      void refreshSuggestedQuestions({ force: true });
    } else save.disabled = false;
  });

  return { el, startFromNote };

  async function startFromNote(note: Pick<Note, 'text' | 'tags'>) {
    if (inflight) {
      status.textContent = 'wait for the current response before starting a new thread';
      return;
    }
    await startNewChat();
    const tags = note.tags.length ? `Tags: ${note.tags.join(', ')}` : '';
    input.value = [
      'Use this link note as the starting point for the chat.',
      tags,
      'Note:',
      note.text.trim(),
      '',
      'My extra context or question:',
    ].filter(Boolean).join('\n');
    window.requestAnimationFrame(() => {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
      scrollChatToEnd();
    });
  }

  function appendMessage(role: 'user' | 'assistant', text: string): HTMLElement {
    emptyState.hidden = true;
    const item = document.createElement('article');
    item.className = `agent-msg agent-msg--${role}`;
    item.innerHTML = `<div class="agent-msg-role">${role}</div><div class="agent-msg-body"></div>`;
    renderMessageText(item, role, text);
    log.appendChild(item);
    scrollChatToEnd();
    return item;
  }

  function renderMessageText(item: HTMLElement, role: 'user' | 'assistant', text: string) {
    const body = item.querySelector<HTMLElement>('.agent-msg-body')!;
    body.classList.toggle('agent-msg-body--markdown', role === 'assistant');
    if (role === 'assistant') body.innerHTML = renderMarkdown(normalizeDisplayedAssistantMessage(text));
    else body.textContent = text;
  }

  function scrollChatToEnd() {
    if (!shouldStickToBottom || scrollToBottomRaf !== null) return;
    scrollToBottomRaf = window.requestAnimationFrame(() => {
      scrollToBottomRaf = null;
      if (!shouldStickToBottom) return;
      composerWrap.scrollIntoView({ block: 'end', inline: 'nearest' });
      shouldStickToBottom = true;
    });
  }

  function isNearPageBottom() {
    const scroller = document.scrollingElement || document.documentElement;
    const viewport = window.innerHeight || document.documentElement.clientHeight || 0;
    const remaining = scroller.scrollHeight - (scroller.scrollTop + viewport);
    return remaining <= 64;
  }

  function finalizeAssistantMessage(item: HTMLElement, answer: string, sources: ChatSourceNote[]) {
    answerByMessage.set(item, answer);
    sourcesByMessage.set(item, sources.slice());
    item.querySelector('.agent-activity')?.remove();
    item.querySelector('.agent-thinking')?.remove();
    const trace = item.querySelector<HTMLDetailsElement>('.agent-trace');
    if (trace) trace.open = false;
    item.querySelector('.agent-msg-sources')?.remove();
    item.querySelector('.agent-msg-actions')?.remove();
    if (sources.length) {
      item.insertAdjacentHTML('beforeend', `<details class="agent-msg-sources" aria-label="source links">
        <summary>links (${sources.length})</summary>
        <div class="agent-msg-source-list">${sources.map((note, i) => `
          <button type="button" class="agent-msg-source-card" style="--note-bg:${escapeHtml(noteBgFor(note.tags))}" data-source-idx="${i}" data-source-uuid="${escapeHtml(note.uuid)}">
            <span class="agent-source-kicker">#${i + 1} · ${escapeHtml(formatNoteDate(note))} · ${escapeHtml(noteSourceHost(note) || note.tags.join(', ') || 'untagged')}</span>
            <span class="agent-source-body">${escapeHtml(noteDisplayTitle(note))}</span>
            <span class="agent-source-body">${escapeHtml(notePreviewText(note, 180))}</span>
          </button>`).join('')}</div>
      </details>`);
    }
    item.insertAdjacentHTML('beforeend', '<div class="agent-msg-actions"><button type="button" class="agent-msg-save" data-save-message>save as note</button><button type="button" class="agent-msg-save" data-save-wiki>save as wiki</button></div>');
    scrollChatToEnd();
  }

  function codexRuntimeRows(): string[] {
    if (!codexAuth) return [row('codex', 'checking…')];
    if (!codexAuth.configured) return [row('codex', 'not configured')];
    const source = codexAuth.source === 'ui' ? 'ui login' : 'worker secret';
    const validity = codexAuth.valid ? '' : ' invalid';
    const expires = codexAuth.expiresAt ? ` · expires ${formatSessionDate(codexAuth.expiresAt)}` : '';
    return [row('codex', `${source}${validity}${expires}`)];
  }

  function startupTraceRows(): string[] {
    if (!startupTrace) return [];
    const rows: string[] = [];
    const clientParts: string[] = [];
    if (startupTrace.createMs != null) clientParts.push(`create ${formatStartupMs(startupTrace.createMs)}`);
    if (startupTrace.waitMs != null) clientParts.push(`wait ${formatStartupMs(startupTrace.waitMs)}`);
    if (startupTrace.bootstrapMs != null) clientParts.push(`bootstrap ${formatStartupMs(startupTrace.bootstrapMs)}`);
    if (startupTrace.firstEventMs != null) clientParts.push(`first event ${formatStartupMs(startupTrace.firstEventMs)}`);
    if (clientParts.length) rows.push(row('startup', clientParts.join(' · ')));
    if (startupDebugEnabled && startupTrace.server) {
      const server = startupTrace.server;
      const serverParts: string[] = [];
      if (server.readyMs != null) serverParts.push(`ready ${formatStartupMs(server.readyMs)}`);
      if (server.turnMs != null) serverParts.push(`turn ${formatStartupMs(server.turnMs)}`);
      if (server.streamMs != null) serverParts.push(`stream ${formatStartupMs(server.streamMs)}`);
      if (server.firstByteMs != null) serverParts.push(`byte ${formatStartupMs(server.firstByteMs)}`);
      if (server.firstPiEventMs != null) serverParts.push(`pi ${formatStartupMs(server.firstPiEventMs)}`);
      if (server.firstThinkingMs != null) serverParts.push(`thinking ${formatStartupMs(server.firstThinkingMs)}`);
      if (server.doneMs != null) serverParts.push(`done ${formatStartupMs(server.doneMs)}`);
      if (serverParts.length) rows.push(row('server', serverParts.join(' · ')));
    }
    return rows;
  }

  function renderStartupDebugToggle() {
    startupDebugBtn.textContent = startupDebugEnabled ? 'startup debug on' : 'startup debug off';
    startupDebugBtn.setAttribute('aria-pressed', startupDebugEnabled ? 'true' : 'false');
  }

  function renderRuntimeMeta() {
    if (!session) {
      runtimeMeta.innerHTML = codexRuntimeRows().join('');
      return;
    }
    const lines = [
      row('status', session.status),
      row('session', session.id),
      row('provider', session.provider),
      row('remote', session.providerSessionId ?? 'pending'),
      row('cwd', session.cwd ?? '—'),
      row('preview', session.previewUrl ?? '—'),
      ...codexRuntimeRows(),
      ...startupTraceRows(),
    ];
    if (session.errorMessage) lines.push(row('note', session.errorMessage));
    runtimeMeta.innerHTML = lines.join('');
  }

  function renderSession() {
    if (!session) {
      runtimeSummary.innerHTML = 'ask a question; <code>Cloudflare Sandbox</code> starts automatically.';
      renderRuntimeMeta();
      startSessionBtn.disabled = false;
      stopSessionBtn.disabled = true;
      deleteChatBtn.disabled = true;
      setChatEnabled(!inflight);
      return;
    }

    renderRuntimeMeta();
    runtimeSummary.textContent = describeSession(session);
    startSessionBtn.disabled = session.status === 'ready' || session.status === 'starting';
    stopSessionBtn.disabled = session.status === 'stopped';
    deleteChatBtn.disabled = false;
    setChatEnabled(!inflight);
  }

  async function refreshSessionList() {
    sessionsRefreshing = true;
    renderSessionList();
    sessions = await listAgentSessions();
    sessionsRefreshing = false;
    renderSessionList();
  }

  function renderSessionList() {
    if (sessionsRefreshing && sessions.length === 0) {
      historyPanel.innerHTML = '<p class="agent-history-empty">loading…</p>';
      return;
    }
    if (sessions.length === 0) {
      historyPanel.innerHTML = '<p class="agent-history-empty">no conversations yet</p>';
      return;
    }
    historyPanel.innerHTML = sessions.map((item) => {
      const active = item.id === session?.id ? ' agent-history-item--active' : '';
      return `<div class="agent-history-item${active}">
        <button type="button" class="agent-history-load" data-load-session="${escapeHtml(item.id)}">
          <span>${escapeHtml(sessionTitle(item))}</span>
          <small>${escapeHtml(formatSessionDate(item.updatedAt))} · ${escapeHtml(item.status)}</small>
        </button>
        <button type="button" class="agent-history-delete" data-delete-session="${escapeHtml(item.id)}" aria-label="delete conversation">delete</button>
      </div>`;
    }).join('');
  }

  async function loadConversation(id: string) {
    if (inflight) return;
    status.textContent = 'loading conversation…';
    const saved = await getAgentHistory(id);
    if (!saved) {
      status.textContent = 'conversation not found';
      await refreshSessionList();
      return;
    }
    if (saved.session.status === 'stub') {
      clearStoredSessionId();
      status.textContent = 'placeholder session skipped';
      await refreshSessionList();
      return;
    }
    session = saved.session;
    persistSessionId(saved.session.id);
    renderTurns(saved.turns);
    renderSession();
    renderSessionList();
    scheduleAutoStop();
    status.textContent = 'conversation loaded';
    await refreshSuggestedQuestions({ force: true });
  }

  async function deleteConversation(id: string) {
    if (inflight) return;
    const removed = await deleteAgentSession(id);
    if (!removed) {
      status.textContent = 'delete failed';
      return;
    }
    if (session?.id === id) {
      clearAutoStop();
      session = null;
      clearStoredSessionId();
      clearConversation();
      renderSession();
    }
    status.textContent = 'conversation deleted';
    await refreshSessionList();
  }

  async function startNewChat() {
    if (inflight) return;
    newChatBtn.disabled = true;
    if (session && session.status !== 'stopped') await stopAgentSession(session.id);
    clearAutoStop();
    session = null;
    clearStoredSessionId();
    clearConversation();
    renderSession();
    await refreshSessionList();
    newChatBtn.disabled = false;
  }

  function renderTurns(turns: AgentTurn[]) {
    clearConversation();
    let lastRendered: ChatMessage | null = null;
    for (const turn of turns) {
      if (turn.kind !== 'message' || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
      const role: ChatMessage['role'] = turn.role;
      const content = displayTurnContent(turn);
      if (lastRendered && lastRendered.role === role && lastRendered.content === content) continue;
      const node = appendMessage(role, content);
      history.push({ role, content });
      lastRendered = { role, content };
      if (role === 'assistant') finalizeAssistantMessage(node, content, []);
    }
    renderSuggestions();
  }

  function clearConversation() {
    history.length = 0;
    suggestedQuestions = [];
    log.querySelectorAll('.agent-msg').forEach((node) => node.remove());
    emptyState.hidden = false;
    renderSuggestions();
  }

  function setChatEnabled(enabled: boolean) {
    input.disabled = !enabled;
    modelSelect.disabled = !enabled;
    effortSelect.disabled = !enabled;
    form.querySelector<HTMLButtonElement>('.agent-send')!.disabled = !enabled;
    renderSuggestions();
  }

  async function refreshSuggestedQuestions(opts: { force?: boolean } = {}) {
    if (history.length > 0) {
      suggestedQuestions = [];
      suggestionsRefreshing = false;
      renderSuggestions();
      return;
    }
    suggestionsRefreshing = true;
    renderSuggestions();
    const nextQuestions = await getSuggestedQuestions({ refresh: opts.force === true });
    suggestedQuestions = history.length === 0 ? nextQuestions : [];
    suggestionsRefreshing = false;
    renderSuggestions();
  }

  function renderSuggestions() {
    const showEmptyState = history.length === 0 && !inflight;
    const showSuggestions = showEmptyState && (suggestionsRefreshing || suggestedQuestions.length > 0);
    emptyState.hidden = !showEmptyState;
    suggestions.hidden = !showSuggestions;
    if (!showSuggestions) {
      suggestions.innerHTML = '';
      return;
    }
    const refreshLabel = suggestionsRefreshing ? 'regenerating suggestions' : 'regenerate suggestions';
    suggestions.innerHTML = [
      ...suggestedQuestions.map((question) => (
        `<button type="button" class="agent-suggestion-chip" data-suggestion="${escapeHtml(question)}">${escapeHtml(question)}</button>`
      )),
      `<button type="button" class="agent-suggestion-chip agent-suggestion-refresh" data-suggestions-refresh aria-label="${refreshLabel}" title="${refreshLabel}" aria-busy="${suggestionsRefreshing}" ${suggestionsRefreshing ? 'disabled' : ''}><span aria-hidden="true">↻</span><span>${suggestionsRefreshing ? 'refreshing' : 'refresh'}</span></button>`,
    ].join('');
  }

  async function restoreSession() {
    const id = loadStoredSessionId();
    if (!id) {
      renderSession();
      return;
    }
    const saved = await getAgentHistory(id);
    if (!saved) {
      clearStoredSessionId();
      renderSession();
      return;
    }
    if (saved.session.status === 'stub') {
      clearStoredSessionId();
      renderSession();
      return;
    }
    session = saved.session;
    renderTurns(saved.turns);
    renderSession();
    scheduleAutoStop();
  }
}

function loadStoredSessionId(): string | null {
  try { return localStorage.getItem(AGENT_SESSION_KEY); } catch { return null; }
}

function displayTurnContent(turn: AgentTurn): string {
  return turn.role === 'user'
    ? normalizeDisplayedUserMessage(turn.content)
    : normalizeDisplayedAssistantMessage(turn.content);
}

function normalizeDisplayedUserMessage(text: string): string {
  const marker = '\nUser request:\n';
  const idx = text.lastIndexOf(marker);
  if (idx < 0) return text;
  const suffix = text.slice(idx + marker.length).trim();
  return suffix || text;
}

function normalizeDisplayedAssistantMessage(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\[tool_?call:[^\]]+\]$/i.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function persistSessionId(id: string) {
  try { localStorage.setItem(AGENT_SESSION_KEY, id); } catch { /* noop */ }
}
function clearStoredSessionId() {
  try { localStorage.removeItem(AGENT_SESSION_KEY); } catch { /* noop */ }
}

function loadStartupDebugEnabled(): boolean {
  try { return localStorage.getItem(AGENT_STARTUP_DEBUG_KEY) === '1'; } catch { return false; }
}

function persistStartupDebugEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.setItem(AGENT_STARTUP_DEBUG_KEY, '1');
    else localStorage.removeItem(AGENT_STARTUP_DEBUG_KEY);
  } catch { /* noop */ }
}

function describeSession(session: AgentSession): string {
  if (session.status === 'stub') return 'local placeholder session active; Cloudflare Sandbox binding is not configured yet.';
  if (session.status === 'starting') return 'sandbox is starting; asks will wait automatically.';
  if (session.status === 'ready') return 'sandbox is ready; auto-stops after 15m idle.';
  if (session.status === 'stopped' && !session.providerSessionId) return 'sandbox unavailable; notes chat history is being saved.';
  if (session.status === 'stopped') return 'sandbox is stopped; ask again to start a new one.';
  return session.errorMessage || 'sandbox reported an error.';
}

function sessionTitle(session: AgentSession): string {
  return session.title?.trim() || `conversation ${session.id}`;
}

function compactSessionTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'links sandbox';
}

function formatSessionDate(ms: number): string {
  try { return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return String(ms); }
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim().slice(0, 80) || 'Agent synthesis';
}

function formatNoteDate(note: ChatSourceNote): string {
  const ms = note.updatedAt || note.createdAt;
  return ms ? fmtDate(ms) : 'undated';
}

function row(label: string, value: string): string {
  return `<div class="agent-runtime-term">${escapeHtml(label)}</div><div class="agent-runtime-value">${escapeHtml(value)}</div>`;
}

function showEventActivity(event: AgentEvent, show: (key: string, text: string, kind: AgentActivityKind) => void): void {
  const name = event.name || event.type;
  if (event.type === 'tool_call') show(`tool:${event.toolCallId || name}`, `using ${name}`, 'tool');
  else if (event.type === 'tool_result') show(`tool:${event.toolCallId || name}`, `${name} done`, 'result');
  else if (event.type === 'error') show('error', name, 'error');
}

function describePiActivity(event: Record<string, unknown>): { key: string; text: string; kind: AgentActivityKind } | null {
  const type = stringValue(event.type);
  const assistantEvent = recordValue(event.assistantMessageEvent);
  const assistantType = stringValue(assistantEvent?.type);
  if (assistantType.includes('thinking')) return { key: 'thinking', text: 'thinking', kind: 'thinking' };
  if (assistantType === 'text_delta') return null;
  const message = recordValue(event.message);
  const role = stringValue(message?.role);
  if (role === 'toolResult') {
    const name = stringValue(message?.toolName) || 'tool';
    return { key: `tool:${stringValue(message?.toolCallId) || name}`, text: noteToolResultActivity(name, message?.content) || `${name} done`, kind: 'result' };
  }
  const toolCall = toolCallBlock(message?.content);
  if (toolCall) return { key: `tool:${toolCall.id || toolCall.name}`, text: noteToolCallActivity(toolCall.name, toolCall.args) || `using ${toolCall.name}`, kind: 'tool' };
  if (type === 'message_start' || type === 'message_update') return { key: 'thinking', text: 'thinking', kind: 'thinking' };
  return null;
}

function toolCallBlock(content: unknown): { name: string; id: string; args: unknown } | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const row = recordValue(block);
    if (row?.type === 'toolCall') return { name: stringValue(row.name) || 'tool', id: stringValue(row.toolCallId), args: row.args || row.input || row.parameters };
  }
  return null;
}

function isNoteTool(name: string): boolean {
  return name === 'grep_notes' || name === 'search_notes' || name === 'search_wiki' || name === 'read_wiki_page';
}

function noteToolCallActivity(name: string, _args: unknown): string {
  if (!isNoteTool(name)) return '';
  return 'searching links';
}

function noteToolResultActivity(name: string, content: unknown): string {
  if (!isNoteTool(name)) return '';
  const count = noteToolResultCount(content);
  return count === null ? `${name} done` : `${name} → ${count} links`;
}

function noteToolPattern(args: unknown): string {
  const row = recordValue(args) || parseJsonObject(stringValue(args));
  return stringValue(row?.pattern) || stringValue(row?.query);
}

function noteToolResultCount(content: unknown): number | null {
  const parsed = parseJsonObject(contentText(content));
  return Array.isArray(parsed?.notes) ? parsed.notes.length : null;
}

function noteToolCallText(name: string, args: unknown): string {
  if (!isNoteTool(name)) return '';
  const row = recordValue(args) || parseJsonObject(stringValue(args));
  const limit = typeof row?.limit === 'number' ? `limit: ${row.limit}` : '';
  const dates = ['createdAfter', 'createdBefore', 'updatedAfter', 'updatedBefore']
    .filter((key) => typeof row?.[key] === 'string')
    .map((key) => `${key}: ${row?.[key]}`)
    .join('\n');
  return ['searching saved links', limit, dates].filter(Boolean).join('\n');
}

function noteToolResultText(name: string, content: unknown): string {
  if (!isNoteTool(name)) return '';
  const parsed = parseJsonObject(contentText(content));
  const notes = Array.isArray(parsed?.notes) ? parsed.notes : [];
  const grep = Array.isArray(parsed?.grep) ? parsed.grep : [];
  const search = recordValue(parsed?.search);
  const scanned = typeof search?.scanned === 'number' ? ` · scanned ${search.scanned}` : '';
  const total = typeof search?.totalMatches === 'number' ? ` · ${search.totalMatches} lines` : '';
  const lines = [`${notes.length} link${notes.length === 1 ? '' : 's'} matched${scanned}${total}`];
  for (const item of grep.slice(0, 8)) {
    const row = recordValue(item);
    const path = stringValue(row?.path) || stringValue(row?.uuid) || 'link';
    const line = typeof row?.line === 'number' ? `:${row.line}` : '';
    const snippet = stringValue(row?.snippet);
    const updated = stringValue(row?.updatedAtIso).slice(0, 10);
    const age = typeof row?.ageDays === 'number' ? `${row.ageDays}d old` : '';
    const freshness = [updated && `updated ${updated}`, age].filter(Boolean).join(', ');
    lines.push(`${path}${line}${freshness ? ` (${freshness})` : ''}${snippet ? ` — ${snippet}` : ''}`);
  }
  return lines.join('\n');
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return recordValue(parsed);
  } catch {
    return null;
  }
}

function quoteTiny(text: string): string {
  if (!text) return '""';
  const compact = text.replace(/\s+/g, ' ').trim();
  return `"${compact.length > 60 ? `${compact.slice(0, 60)}…` : compact}"`;
}

function sourcesFromPiEvent(event: Record<string, unknown>): ChatSourceNote[] {
  const message = recordValue(event.message);
  const text = contentText(message?.content || event);
  if (!text.includes('"notes"')) return [];
  try {
    const parsed = JSON.parse(text) as { notes?: unknown };
    if (!Array.isArray(parsed.notes)) return [];
    return parsed.notes.flatMap((note) => {
      const row = recordValue(note);
      if (!row || typeof row.uuid !== 'string' || typeof row.text !== 'string') return [];
      return [{
        uuid: row.uuid,
        text: row.text,
        tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
        sourceUrl: stringValue(row.sourceUrl) || null,
        sourceTitle: stringValue(row.sourceTitle) || null,
        sourceDescription: stringValue(row.sourceDescription) || null,
        sourceSiteName: stringValue(row.sourceSiteName) || null,
        sourceContentText: stringValue(row.sourceContentText) || null,
      }];
    });
  } catch {
    return [];
  }
}

function mergeSourceNotes(a: ChatSourceNote[], b: ChatSourceNote[]): ChatSourceNote[] {
  if (!b.length) return a;
  const seen = new Set(a.map((note) => note.uuid));
  return [...a, ...b.filter((note) => !seen.has(note.uuid))];
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((block) => {
    if (typeof block === 'string') return block;
    const row = recordValue(block);
    return stringValue(row?.text) || contentText(row?.content);
  }).filter(Boolean).join('\n');
  const row = recordValue(content);
  return row ? stringValue(row.text) || contentText(row.content) : '';
}

function traceAgentEvent(event: AgentEvent): AgentTraceRow {
  const name = event.name || 'event';
  let kind: AgentTraceKind = 'status';
  let label = event.type;
  if (event.type === 'tool_call') {
    kind = 'tool';
    label = `using ${name}`;
  } else if (event.type === 'tool_result') {
    kind = 'result';
    label = `${name} result`;
  } else if (event.type === 'error') {
    kind = 'error';
  } else if (event.name) label = `${event.type}: ${event.name}`;
  return { key: `event:${event.seq}:${event.type}:${event.name || ''}`, kind, label, text: traceText(event.payload) };
}

function tracePiEvent(event: Record<string, unknown>): AgentTraceRow[] {
  const rows: AgentTraceRow[] = [];
  const type = stringValue(event.type) || 'pi_event';
  const assistantEvent = recordValue(event.assistantMessageEvent);
  const assistantType = stringValue(assistantEvent?.type);
  const thinking = thinkingTraceRow(assistantEvent);
  if (thinking) rows.push(thinking);
  const message = recordValue(event.message);
  if (message) rows.push(...traceMessageRows(type, message));
  if (rows.length || assistantType === 'text_delta') return rows;
  if (assistantType && !assistantType.includes('text') && !assistantType.includes('thinking')) {
    rows.push({ key: `pi:${type}:${assistantType}`, kind: 'status', label: assistantType, text: traceText(assistantEvent) });
  }
  return rows;
}

function traceRawPiEvent(event: Record<string, unknown>): AgentTraceRow {
  const type = stringValue(event.type) || 'pi_event';
  return { key: `pi-raw:${type}`, kind: 'status', label: type, text: `${traceText(event)}\n`, append: true };
}

function shouldHideRawPiEvent(event: Record<string, unknown>): boolean {
  const message = recordValue(event.message);
  const role = stringValue(message?.role);
  return role === 'user' || role === 'system';
}

function traceMessageRows(type: string, message: Record<string, unknown>): AgentTraceRow[] {
  const rows: AgentTraceRow[] = [];
  const role = stringValue(message.role);
  if (role === 'user' || role === 'system') return rows;
  if (role === 'toolResult' || role === 'bashExecution') {
    const name = stringValue(message.toolName) || role;
    rows.push({ key: `tool-result:${stringValue(message.toolCallId) || name}`, kind: 'result', label: `${name} result`, text: noteToolResultText(name, message.content) || traceText(message.content || message) });
    return rows;
  }
  const content = message.content;
  if (!Array.isArray(content)) return rows;
  for (const block of content) {
    const row = recordValue(block);
    if (!row) continue;
    if (row.type === 'thinking') {
      const text = stringValue(row.thinking) || stringValue(row.text);
      rows.push({ key: 'thinking', kind: 'thinking', label: 'thinking', text, append: false });
    } else if (row.type === 'toolCall') {
      const name = stringValue(row.name) || 'tool';
      const args = row.args || row.input || row.parameters;
      rows.push({ key: `tool-call:${stringValue(row.toolCallId) || name}`, kind: 'tool', label: noteToolCallActivity(name, args) || `using ${name}`, text: noteToolCallText(name, args) || traceText(args || row) });
    }
  }
  if (!rows.length && type !== 'message_update') rows.push({ key: `pi-message:${type}:${role}`, kind: 'status', label: `${type}: ${role || 'message'}`, text: traceText(message) });
  return rows;
}

function thinkingTraceRow(event: Record<string, unknown> | null): AgentTraceRow | null {
  if (!event) return null;
  const type = stringValue(event.type);
  if (!type.includes('thinking')) return null;
  if (type === 'thinking_delta') {
    return { key: 'thinking', kind: 'thinking', label: 'thinking', text: assistantStreamText(event.delta) || assistantStreamText(event.contentDelta), append: true };
  }
  if (type === 'thinking_start') return { key: 'thinking', kind: 'thinking', label: 'thinking', text: '', append: false };
  return null;
}

function assistantStreamText(value: unknown): string {
  if (typeof value === 'string') return value;
  const row = recordValue(value);
  return stringValue(row?.text) || stringValue(row?.thinking) || stringValue(row?.delta);
}

function traceText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
  // ponytail: trace rows are preview-sized; D1 history keeps raw events if full payload inspection matters.
  return text.length > 1600 ? `${text.slice(0, 1600)}\n…` : text;
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let codeLang = '';
  let codeLines: string[] = [];

  const closeList = () => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    closeList();
    out.push(`<p>${inlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    paragraph = [];
  };
  const flushCode = () => {
    if (!codeLang && !codeLines.length) return;
    out.push(`<pre class="agent-md-code"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    codeLang = '';
    codeLines = [];
  };
  const flushBlocks = () => {
    flushParagraph();
    closeList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || '';
    const fence = line.match(/^```\s*([\w-]+)?\s*$/);
    if (fence) {
      if (codeLang || codeLines.length) flushCode();
      else {
        flushBlocks();
        codeLang = fence[1] || 'text';
      }
      continue;
    }
    if (codeLang) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushBlocks();
      continue;
    }
    const table = parseMarkdownTable(lines, i);
    if (table) {
      flushBlocks();
      out.push(table.html);
      i = table.endIndex;
      continue;
    }
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushBlocks();
      out.push('<hr class="agent-md-rule">');
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushBlocks();
      const level = Math.min((heading[1] || '').length, 6);
      out.push(`<h${level}>${inlineMarkdown(heading[2] || '')}</h${level}>`);
      continue;
    }
    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextList = unordered ? 'ul' : 'ol';
      if (list !== nextList) {
        closeList();
        list = nextList;
        out.push(`<${list}>`);
      }
      out.push(`<li>${inlineMarkdown((unordered?.[1] || ordered?.[1]) || '')}</li>`);
      continue;
    }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushBlocks();
      out.push(`<blockquote>${inlineMarkdown(quote[1] || '')}</blockquote>`);
      continue;
    }
    paragraph.push(line);
  }

  flushCode();
  flushParagraph();
  closeList();
  return out.join('') || '';
}

function parseMarkdownTable(lines: string[], startIndex: number): { html: string; endIndex: number } | null {
  const header = parseMarkdownTableRow(lines[startIndex] || '');
  const dividerCount = parseMarkdownTableDivider(lines[startIndex + 1] || '');
  if (!header || header.length < 2 || dividerCount !== header.length) return null;
  const bodyRows: string[][] = [];
  let endIndex = startIndex + 1;
  for (let i = startIndex + 2; i < lines.length; i += 1) {
    const row = parseMarkdownTableRow(lines[i] || '');
    if (!row || row.length !== header.length) break;
    bodyRows.push(row);
    endIndex = i;
  }
  const thead = `<thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead>`;
  const tbody = bodyRows.length
    ? `<tbody>${bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
    : '';
  return { html: `<div class="agent-md-table-wrap"><table class="agent-md-table">${thead}${tbody}</table></div>`, endIndex };
}

function parseMarkdownTableRow(line: string): string[] | null {
  if (!line.includes('|')) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = normalized.split('|').map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function parseMarkdownTableDivider(line: string): number {
  const cells = parseMarkdownTableRow(line);
  return cells && cells.every((cell) => /^:?-{3,}:?$/.test(cell)) ? cells.length : 0;
}

function inlineMarkdown(text: string): string {
  const stash: string[] = [];
  const hold = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;
  let protectedText = text.replace(/`([^`]+)`/g, (_match, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  protectedText = protectedText.replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_match, label: string, url: string) => {
    const href = safeLink(url);
    return href ? hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`) : label;
  });
  protectedText = protectedText.replace(/\[#(\d+)]/g, (_match, n: string) => {
    const idx = Math.max(0, Number(n) - 1);
    return hold(`<button type="button" class="agent-cite" data-source-ref="${idx}">[#${escapeHtml(n)}]</button>`);
  });
  let html = escapeHtml(protectedText);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  return html.replace(/\u0000(\d+)\u0000/g, (_match, idx: string) => stash[Number(idx)] || '');
}

function safeLink(url: string): string {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? url : '';
  } catch {
    return '';
  }
}

function compactActivityText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

function summarizeTopStatus(text: string): string {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (!lower) return 'running';
  const parsed = parseJsonObject(trimmed);
  if (parsed && (typeof parsed.pattern === 'string' || typeof parsed.query === 'string')) return 'searching notes';
  if (lower.includes('thinking')) return 'thinking';
  if (lower.includes('search_wiki') || lower.includes('read_wiki_page')) return 'reading wiki';
  if (lower.includes('search_notes') || lower.includes('grep_notes') || lower.includes('saved note')) return 'searching notes';
  if (lower.includes('stream')) return 'writing';
  if (lower.includes('sandbox command')) return 'running';
  return compactActivityText(text);
}

function summarizeStatusTraceText(text: string): string {
  return summarizeTopStatus(text) === 'searching notes' ? 'searching notes' : text;
}

function summarizeAgentEventStatus(event: AgentEvent): string {
  if (event.type === 'tool_call') return event.name === 'search_notes' ? 'searching notes' : event.name === 'search_wiki' || event.name === 'read_wiki_page' ? 'reading wiki' : `using ${event.name || 'tool'}`;
  if (event.type === 'tool_result') return event.name === 'search_notes' ? 'notes ready' : event.name === 'search_wiki' || event.name === 'read_wiki_page' ? 'wiki ready' : `${event.name || 'tool'} done`;
  if (event.type === 'error') return 'error';
  return compactActivityText(`${event.type}${event.name ? ` · ${event.name}` : ''}`);
}

function summarizePiEventStatus(event: Record<string, unknown>): string {
  const activity = describePiActivity(event);
  return activity?.text || 'running';
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}
