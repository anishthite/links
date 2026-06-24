// Note as exchanged across the API boundary.
// Server stores `tags` as a JSON string in SQLite; the API serializes/deserializes.
// PreparedText is the @chenglou/pretext handle, attached client-side after fetch.

import type { PreparedText } from '@chenglou/pretext';

/** Pending classifier suggestion attached to a note.
 *  New link auto-tags write directly to `notes.tags`; this remains for legacy
 *  or manually loaded review rows. When all suggested tags are accepted or
 *  rejected, the server clears the suggestion row (sets `applied_at`) and
 *  subsequent GETs omit this field. */
export type PendingSuggestion = {
  tags: string[];                       // tags still pending user decision (≥1 by invariant)
  primary: string;                      // primary ∈ tags (drives accent / ordering hint)
  confidence: 'medium' | 'low';
  rationale: string;                    // short human-readable why; may be empty
};

export type Note = {
  uuid: string;
  text: string;
  tags: string[];
  color: string | null;
  createdAt: number;     // epoch ms
  updatedAt: number;     // epoch ms
  /** Optional original source URL when this note represents a saved link. */
  sourceUrl?: string | null;
  sourceUrlNormalized?: string | null;
  sourceTitle?: string | null;
  sourceDescription?: string | null;
  sourceSiteName?: string | null;
  sourceAuthor?: string | null;
  sourcePublishedAt?: number | null;
  sourceFetchedAt?: number | null;
  sourceContentText?: string | null;
  sourceContentMarkdown?: string | null;
  sourceStatus?: 'ready' | 'failed' | null;
  sourceLastError?: string | null;
  /** Optional: only present when an unaccepted med/low suggestion exists. */
  pendingSuggestion?: PendingSuggestion;
  /** Board-space coordinates (top-left of the note) for the whiteboard view.
   *  `null` means "never been placed" — the whiteboard seed-layout owns those.
   *  Stored as columns `position_x`, `position_y`, `z_index` server-side. */
  positionX?: number | null;
  positionY?: number | null;
  zIndex?: number;
};

// What the API actually returns over the wire — tags is a JSON string.
// pendingSuggestion is already a structured object (not JSON-stringified) since
// the server synthesizes it from a JOIN, so it passes through unchanged.
export type NoteWire = Omit<Note, 'tags'> & { tags: string };

// Internal augmented note. We attach the pretext handles once, reuse on every layout pass.
// `prepared` is one handle per rendered card-title line (split on `\n`); a `null` entry means a blank line.
// We do this because pretext treats text as a single flowing paragraph and ignores user-introduced
// newlines, while CSS `.note .text { white-space: pre-wrap }` renders them as real line breaks.
// Without per-line preparation, multi-line card titles are under-measured and overlap their neighbours
// in the masonry (D-027).
export type PreparedNote = Note & {
  prepared: (PreparedText | null)[];
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ChatSourceNote = Pick<Note, 'uuid' | 'text' | 'tags' | 'createdAt' | 'updatedAt' | 'sourceUrl' | 'sourceTitle' | 'sourceDescription' | 'sourceSiteName' | 'sourceContentText'>;
export type SimilarNote = ChatSourceNote & { reason: string };

export type ChatStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'sources'; notes: ChatSourceNote[] }
  | { type: 'stdout'; text: string }
  | { type: 'done'; answer: string }
  | { type: 'error'; message: string };

export type SuggestedQuestionsResponse = { questions: string[] };

export type AgentCodexAuthStatus = {
  configured: boolean;
  source: 'ui' | 'worker-secret' | 'missing';
  valid: boolean;
  updatedAt: number | null;
  expiresAt: number | null;
};

export type AgentCodexDeviceStart = {
  id: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: number;
};

export type AgentCodexDevicePoll =
  | { status: 'pending'; intervalSeconds?: number }
  | { status: 'complete'; auth: AgentCodexAuthStatus }
  | { status: 'expired' }
  | { status: 'failed'; error?: string };

export type AgentProvider = 'cloudflare-sandbox';
export type AgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type AgentSessionStatus = 'starting' | 'ready' | 'stopped' | 'error' | 'stub';

export type AgentSession = {
  id: string;
  provider: AgentProvider;
  providerSessionId: string | null;
  title: string | null;
  status: AgentSessionStatus;
  ownerEmail: string;
  previewUrl: string | null;
  cwd: string | null;
  errorMessage: string | null;
  piSessionId: string | null;
  piSessionFile: string | null;
  piCwd: string | null;
  piLeafEntryId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type AgentTurnRole = 'user' | 'assistant' | 'system';
export type AgentTurnKind = 'message' | 'status' | 'error' | 'summary';

export type AgentTurn = {
  id: number;
  sessionId: string;
  seq: number;
  role: AgentTurnRole;
  kind: AgentTurnKind;
  content: string;
  piEntryId: string | null;
  piParentEntryId: string | null;
  piMessageRole: string | null;
  rawMessage: Record<string, unknown> | null;
  createdAt: number;
};

export type AgentEvent = {
  id: number;
  sessionId: string;
  turnId: number | null;
  seq: number;
  type: string;
  name: string | null;
  payload: Record<string, unknown>;
  piEntryId: string | null;
  piParentEntryId: string | null;
  toolCallId: string | null;
  rawEntry: Record<string, unknown> | null;
  createdAt: number;
};

export type AgentArtifact = {
  id: number;
  sessionId: string;
  turnId: number | null;
  kind: string;
  pathOrKey: string | null;
  title: string | null;
  contentText: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type AgentPiEntry = {
  id: number;
  sessionId: string;
  piEntryId: string;
  piParentId: string | null;
  piType: string;
  piTimestamp: string;
  role: string | null;
  toolCallId: string | null;
  raw: Record<string, unknown>;
  createdAt: number;
};

export type AgentHistory = {
  session: AgentSession;
  turns: AgentTurn[];
  events: AgentEvent[];
  artifacts: AgentArtifact[];
  piEntries: AgentPiEntry[];
};

export type AgentExecResult = {
  command: string;
  stdout: string;
  parsed: unknown;
  debug?: unknown;
};

export type AgentTurnStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'turn'; turn: AgentTurn }
  | { type: 'event'; event: AgentEvent }
  | { type: 'debug'; scope: 'startup'; phase: string; elapsedMs: number; [key: string]: unknown }
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'raw'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'pi_event'; event: Record<string, unknown> }
  | { type: 'pi_entries'; imported: number; projected?: { turns: number; events: number } }
  | { type: 'done'; turn: AgentTurn; answer: string }
  | { type: 'error'; message: string; debug?: unknown };
