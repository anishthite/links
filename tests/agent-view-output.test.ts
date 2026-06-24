import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => {
  const readySession = {
    id: 's1',
    provider: 'cloudflare-sandbox',
    providerSessionId: 'p1',
    title: 'test',
    status: 'ready',
    ownerEmail: 'local-dev',
    previewUrl: null,
    cwd: '/workspace',
    errorMessage: null,
    piSessionId: null,
    piSessionFile: null,
    piCwd: null,
    piLeafEntryId: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
  return {
  chatWithNotesStream: vi.fn(),
  createAgentSession: vi.fn(async () => ({ session: readySession })),
  deleteAgentSession: vi.fn(),
  getAgentHistory: vi.fn(async () => null),
  getAgentSession: vi.fn(async () => readySession),
  getAgentCodexAuth: vi.fn(async () => ({ configured: false, valid: false, source: 'missing', updatedAt: null, expiresAt: null })),
  bootstrapAgentRuntime: vi.fn(async () => true),
  getSuggestedQuestions: vi.fn(async () => []),
  listAgentSessions: vi.fn(async () => []),
  pollAgentCodexDeviceAuth: vi.fn(),
  startAgentCodexDeviceAuth: vi.fn(),
  stopAgentSession: vi.fn(),
  saveAgentMessageTurn: vi.fn(),
  saveChatNote: vi.fn(),
  saveWikiPage: vi.fn(),
  streamPiTurn: vi.fn(),
  };
});

vi.mock('../src/lib/api', () => api);

describe('agent output view', () => {
  let dom: JSDOM;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  const setPageScroll = (top: number, height = 2000, viewport = 800) => {
    Object.defineProperty(window, 'innerHeight', { value: viewport, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollTop', { value: top, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: height, configurable: true });
  };

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body></body>', { url: 'https://board.test/' });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      localStorage: dom.window.localStorage,
      HTMLElement: dom.window.HTMLElement,
      HTMLDialogElement: dom.window.HTMLDialogElement,
    });
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    setPageScroll(1200);
  });

  afterEach(() => {
    vi.clearAllMocks();
    dom.window.close();
  });

  it('keeps live trace closed and scrolls to the chat bottom', async () => {
    api.streamPiTurn.mockImplementation(async (_id, _message, cb) => {
      cb({ type: 'status', message: 'thinking' });
      cb({ type: 'stdout', text: 'hello' });
      cb({ type: 'done', answer: 'hello' });
      return { answer: 'hello' };
    });

    const { createAgentView } = await import('../src/agent-view');
    const view = createAgentView({ getAllTags: () => [] }).el;
    document.body.appendChild(view);
    const input = view.querySelector<HTMLTextAreaElement>('[data-input]')!;
    input.value = 'hi';
    view.querySelector<HTMLFormElement>('[data-form]')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.streamPiTurn).toHaveBeenCalled());
    const trace = view.querySelector<HTMLDetailsElement>('.agent-trace')!;
    expect(trace.open).toBe(false);
    expect(trace.querySelector('summary')?.textContent || '').toContain('model thinking');
    expect(view.querySelector('.agent-thinking')).toBeNull();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('streams model thinking into the dropdown instead of the answer body', async () => {
    api.streamPiTurn.mockImplementation(async (_id, _message, cb) => {
      cb({
        type: 'pi_event',
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_start' },
        },
      });
      cb({
        type: 'pi_event',
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'compare the two paths\n' },
        },
      });
      cb({ type: 'stdout', text: 'final answer' });
      cb({ type: 'done', answer: 'final answer' });
      return { answer: 'final answer' };
    });

    const { createAgentView } = await import('../src/agent-view');
    const view = createAgentView({ getAllTags: () => [] }).el;
    document.body.appendChild(view);
    const input = view.querySelector<HTMLTextAreaElement>('[data-input]')!;
    input.value = 'hi';
    view.querySelector<HTMLFormElement>('[data-form]')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.streamPiTurn).toHaveBeenCalled());
    const assistant = view.querySelector<HTMLElement>('.agent-msg--assistant')!;
    const body = assistant.querySelector<HTMLElement>('.agent-msg-body')!;
    const trace = assistant.querySelector<HTMLDetailsElement>('.agent-trace')!;
    expect(body.textContent || '').toContain('final answer');
    expect(body.textContent || '').not.toContain('compare the two paths');
    expect(trace.textContent || '').toContain('compare the two paths');
    expect(trace.compareDocumentPosition(body) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('stops auto-sticking to bottom after manual scroll away', async () => {
    api.streamPiTurn.mockImplementation(async (_id, _message, cb) => {
      cb({ type: 'status', message: 'thinking' });
      cb({ type: 'stdout', text: 'hello' });
      cb({ type: 'done', answer: 'hello' });
      return { answer: 'hello' };
    });

    const { createAgentView } = await import('../src/agent-view');
    const view = createAgentView({ getAllTags: () => [] }).el;
    document.body.appendChild(view);
    scrollIntoView.mockClear();
    setPageScroll(100, 2000, 800);
    window.dispatchEvent(new dom.window.Event('scroll'));
    const input = view.querySelector<HTMLTextAreaElement>('[data-input]')!;
    input.value = 'hi';
    view.querySelector<HTMLFormElement>('[data-form]')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.streamPiTurn).toHaveBeenCalled());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('hides visible tool-call placeholders from assistant output', async () => {
    api.streamPiTurn.mockImplementation(async (_id, _message, cb) => {
      cb({ type: 'stdout', text: "Let's think\n[tool_call:grep_notes]\n[toolcall:grepnotes]\nreal answer" });
      cb({ type: 'done', answer: "Let's think\n[tool_call:grep_notes]\n[toolcall:grepnotes]\nreal answer" });
      return { answer: "Let's think\n[tool_call:grep_notes]\n[toolcall:grepnotes]\nreal answer" };
    });

    const { createAgentView } = await import('../src/agent-view');
    const view = createAgentView({ getAllTags: () => [] }).el;
    document.body.appendChild(view);
    const input = view.querySelector<HTMLTextAreaElement>('[data-input]')!;
    input.value = 'hi';
    view.querySelector<HTMLFormElement>('[data-form]')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.streamPiTurn).toHaveBeenCalled());
    const body = view.querySelector<HTMLElement>('.agent-msg--assistant .agent-msg-body')!;
    expect(body.textContent || '').toContain('real answer');
    expect(body.textContent || '').not.toContain('tool_call');
    expect(body.textContent || '').not.toContain('toolcall');
  });

  it('prefills the composer from a note starter and focuses the textarea', async () => {
    const { createAgentView } = await import('../src/agent-view');
    const agent = createAgentView({ getAllTags: () => [] });
    document.body.appendChild(agent.el);

    await agent.startFromNote({ text: 'ship the lazy version first', tags: ['idea', 'ship'] });

    const input = agent.el.querySelector<HTMLTextAreaElement>('[data-input]')!;
    expect(input.value).toContain('Use this link note as the starting point for the chat.');
    expect(input.value).toContain('Tags: idea, ship');
    expect(input.value).toContain('ship the lazy version first');
    expect(document.activeElement).toBe(input);
  });

  it('submits on Enter and keeps Shift+Enter for multiline editing', async () => {
    api.streamPiTurn.mockImplementation(async (_id, _message, cb) => {
      cb({ type: 'done', answer: 'sent' });
      return { answer: 'sent' };
    });

    const { createAgentView } = await import('../src/agent-view');
    const view = createAgentView({ getAllTags: () => [] }).el;
    document.body.appendChild(view);
    const input = view.querySelector<HTMLTextAreaElement>('[data-input]')!;

    input.value = 'draft';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    expect(api.streamPiTurn).not.toHaveBeenCalled();

    input.value = 'send this';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.streamPiTurn).toHaveBeenCalled());
    expect(view.querySelector('.agent-msg--user')?.textContent || '').toContain('send this');
  });

  it('drops the current thread before starting a note-seeded chat', async () => {
    const oldSession = {
      id: 'old-session',
      provider: 'cloudflare-sandbox',
      providerSessionId: 'p-old',
      title: 'old thread',
      status: 'ready',
      ownerEmail: 'local-dev',
      previewUrl: null,
      cwd: '/workspace',
      errorMessage: null,
      piSessionId: null,
      piSessionFile: null,
      piCwd: null,
      piLeafEntryId: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    api.getAgentHistory.mockImplementation(async (id: string) => {
      if (id !== 'old-session') return null;
      return {
        session: oldSession,
        turns: [{
          id: 1,
          sessionId: 'old-session',
          seq: 1,
          role: 'user',
          kind: 'message',
          content: 'old question',
          piEntryId: null,
          piParentEntryId: null,
          piMessageRole: null,
          rawMessage: null,
          createdAt: 1,
        }],
        events: [],
        artifacts: [],
        piEntries: [],
      };
    });
    localStorage.setItem('agentSessionId', 'old-session');

    const { createAgentView } = await import('../src/agent-view');
    const agent = createAgentView({ getAllTags: () => [] });
    document.body.appendChild(agent.el);

    await vi.waitFor(() => expect(agent.el.querySelector('.agent-msg--user')?.textContent || '').toContain('old question'));

    await agent.startFromNote({ text: 'new note', tags: ['idea'] });

    expect(localStorage.getItem('agentSessionId')).toBeNull();
    expect(agent.el.querySelector('.agent-msg')).toBeNull();

    api.createAgentSession.mockClear();
    api.streamPiTurn.mockImplementation(async (_id, _message, cb) => {
      cb({ type: 'done', answer: 'fresh thread' });
      return { answer: 'fresh thread' };
    });
    const input = agent.el.querySelector<HTMLTextAreaElement>('[data-input]')!;
    input.value = 'follow-up';
    agent.el.querySelector<HTMLFormElement>('[data-form]')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.createAgentSession).toHaveBeenCalledOnce());
  });

  it('shows concise startup and note-search status text', async () => {
    api.streamPiTurn.mockImplementation(async (_id, _message, cb, opts) => {
      expect(opts).toMatchObject({ debug: true });
      cb({ type: 'debug', scope: 'startup', phase: 'session-ready', elapsedMs: 9 });
      cb({ type: 'debug', scope: 'startup', phase: 'stream-start', elapsedMs: 20 });
      cb({ type: 'status', message: '{"pattern":"#thought","limit":20,"context":2}' });
      cb({ type: 'debug', scope: 'startup', phase: 'first-byte', elapsedMs: 3210 });
      cb({
        type: 'pi_event',
        event: {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', name: 'search_notes', toolCallId: 'tool-1', args: { pattern: '#thought', limit: 20, context: 2 } }],
          },
        },
      });
      cb({ type: 'debug', scope: 'startup', phase: 'first-pi-event', elapsedMs: 3212 });
      cb({
        type: 'debug', scope: 'startup', phase: 'first-thinking', elapsedMs: 3299,
      });
      cb({
        type: 'pi_event',
        event: {
          type: 'message',
          message: {
            role: 'user',
            content: 'You are running inside a Cloudflare Sandbox container for the Board notes app.\n\nUser request:\nhow do i pick which direction',
          },
        },
      });
      cb({ type: 'done', answer: 'hello' });
      return { answer: 'hello' };
    });

    const { createAgentView } = await import('../src/agent-view');
    const view = createAgentView({ getAllTags: () => [] }).el;
    document.body.appendChild(view);
    const startupDebugBtn = view.querySelector<HTMLButtonElement>('[data-startup-debug]')!;
    startupDebugBtn.click();
    const input = view.querySelector<HTMLTextAreaElement>('[data-input]')!;
    input.value = 'hi';
    view.querySelector<HTMLFormElement>('[data-form]')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.streamPiTurn).toHaveBeenCalled());
    const runtime = view.querySelector<HTMLElement>('[data-runtime-summary]')!;
    const status = view.querySelector<HTMLElement>('[data-status]')!;
    const meta = view.querySelector<HTMLElement>('[data-runtime-meta]')!;
    await vi.waitFor(() => expect(runtime.textContent || '').toMatch(/^pi ready \d+(?:\.\d)?s$/));
    const trace = view.querySelector('.agent-trace')?.textContent || '';
    expect(status.textContent).toBe('done');
    expect(meta.textContent || '').toContain('startup');
    expect(meta.textContent || '').toContain('server');
    expect(meta.textContent || '').toContain('byte');
    expect(meta.textContent || '').toContain('thinking');
    expect(trace).toContain('searching saved links');
    expect(trace).not.toContain('#thought');
    expect(trace).not.toContain('{"pattern":"#thought"');
    expect(trace).not.toContain('Cloudflare Sandbox container');
    expect(trace).not.toContain('User request:');
  });
});
