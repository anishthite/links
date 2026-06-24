import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../src/lib/types';

describe('note editor chat starter', () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body><button id="prev">prev</button><div id="root"></div></body>', { url: 'https://board.test/' });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
      KeyboardEvent: dom.window.KeyboardEvent,
      CustomEvent: dom.window.CustomEvent,
      Node: dom.window.Node,
    });
    const raf = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.requestAnimationFrame = raf;
    globalThis.requestAnimationFrame = raf;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
  });

  it('emits the current note draft when chat starter is clicked', async () => {
    const onStartChat = vi.fn();
    const onSave = vi.fn(async (_uuid: string, patch: { text?: string; tags?: string[] }) => ({ ...note, text: patch.text ?? note.text, tags: patch.tags ?? note.tags }));
    const { createNoteEditor } = await import('../src/note-editor');
    const editor = createNoteEditor({
      getAllTags: () => [],
      onSave,
      onDelete: vi.fn(async () => true),
      onStartChat,
    });
    const root = document.getElementById('root') as HTMLElement;
    editor.mount(root);

    const note: Note = {
      uuid: 'n1',
      text: 'original note',
      tags: ['idea'],
      color: null,
      createdAt: 1,
      updatedAt: 1,
    };

    editor.open(note);
    const textarea = document.querySelector<HTMLTextAreaElement>('.note-editor-text')!;
    textarea.value = 'edited note draft';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-chat]')!.click();

    expect(onStartChat).toHaveBeenCalledWith(expect.objectContaining({
      uuid: 'n1',
      text: 'edited note draft',
      tags: ['idea'],
    }));
    expect(document.querySelector<HTMLElement>('.note-editor-backdrop')?.hidden).toBe(true);
  });
});
