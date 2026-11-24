/**
 * A two-way chat transport, separate from the write-only `ChannelAdapter` used for Ticket notices.
 * The inbound message is person input: it still goes through the agent's approvals, policy and audit.
 * Reply anchors (`replyTo`, `contextToken`) belong to the current turn only; they are never persisted
 * as a durable destination. A durable destination is `accountId` plus `chat` (and optional thread).
 */
export const KNOWN_IM_PLATFORMS = [
  "telegram",
  "qq",
  "wechat",
  "imessage",
] as const;

export type KnownImPlatform = (typeof KNOWN_IM_PLATFORMS)[number];

/**
 * A platform id registered by a factory. The built-ins are listed in `KNOWN_IM_PLATFORMS`, but a
 * host may register another platform without changing the gateway or validation.
 */
export type ImPlatform = string;

export type ImChatKind = "direct" | "group";

export type ImChat = {
  kind: ImChatKind;
  /** Platform chat id, not a Core id. */
  id: string;
  /** Forum topic or thread id, when the platform addresses one. */
  threadId?: string;
  /** Display-only title from the platform; never an authorization input. */
  title?: string;
};

export type ImSender = {
  /** Platform sender id, used for owner pinning and conversation history. */
  id: string;
  name?: string;
};

export type ImMediaRef = {
  kind: "image" | "audio" | "video" | "file";
  /** Platform media id or URL. Only a media-capable adapter may fetch it, and Core never executes it. */
  id: string;
  mimeType?: string;
  size?: number;
  filename?: string;
};

export type ImMediaFetchInput = {
  accountId: string;
  chat: ImChat;
  messageId: string;
  media: ImMediaRef;
};

export type ImMediaFetchResult = {
  data: Uint8Array;
  mediaType: string;
  filename?: string;
};

/** Outbound bytes are base64 on the API seam; adapters never receive a caller-supplied local path. */
export type ImOutboundMedia = {
  kind: ImMediaRef["kind"];
  mediaType: string;
  /** Standard base64, bounded by the IM input validator. */
  data: string;
  filename?: string;
};

/**
 * What an adapter can honestly do. The notification router only selects a proactive channel; a
 * reply-only channel is usable while its window is open and drops outside it.
 */
export type ImCapabilities = {
  /** Can send without a preceding inbound message. */
  proactive: boolean;
  /** Can only send as a reply to a recent inbound message. */
  replyOnly: boolean;
  /** How long a reply stays possible after the inbound message; omitted when unbounded. */
  replyWindowMs?: number;
  /** Maximum messages in one reply window; omitted when unbounded. */
  maxMessagesPerWindow?: number;
  /** Supports an interactive recall/reminder. */
  recall: boolean;
  /** Fetches inbound media and sends bounded images or files in both message directions. */
  media: boolean;
  /** Characters accepted in one platform message; adapters still chunk defensively. */
  maxTextLength: number;
  /** Understands the Markdown Core sends; when false Core must send plain text. */
  markdown?: boolean;
  /** Supports a durable thread/topic address. */
  threads?: boolean;
  /** Supports a typing indicator. */
  typing?: boolean;
};

export type ImInbound = {
  platform: ImPlatform;
  accountId: string;
  chat: ImChat;
  sender: ImSender;
  /** Stable message id from the platform, used for deduplication. */
  messageId: string;
  /** Telegram's update id, when it is separate from the message id. */
  updateId?: string;
  /** Text only in Phase 1. Media is recorded but not downloaded or executed. */
  text: string;
  /** Platform reply anchor for this turn only. */
  replyTo?: string;
  /** WeChat iLink's short-lived reply token. Never persisted as a durable destination. */
  contextToken?: string;
  /** Platform ids mentioned in the message, when the platform exposes them. */
  mentions?: string[];
  /** Media descriptors; Core never downloads or executes them without an explicit policy. */
  media?: ImMediaRef[];
  /** Display-only author of the quoted message. */
  replyAuthor?: string;
  receivedAt: string;
};

export type ImSendMode = "reply" | "proactive";

export type ImSendInput = {
  platform: ImPlatform;
  accountId: string;
  chat: Pick<ImChat, "kind" | "id" | "threadId">;
  text: string;
  media?: readonly ImOutboundMedia[];
  mode: ImSendMode;
  /** Only for `reply`; stripped before a proactive send. */
  replyTo?: string;
  /** Only for `reply`; stripped before a proactive send. */
  contextToken?: string;
  /** Stable for a logical send; the gateway uses it to suppress a duplicate retry. */
  idempotencyKey: string;
};

/** `unknown` means the request may have reached the platform and must not be replayed blindly. */
export type ImSendResult =
  | { status: "sent"; platformMessageId?: string }
  | { status: "retry"; reason: string; retryAfterMs?: number }
  | { status: "discard"; reason: string }
  | { status: "unknown"; reason: string };

export type ImRecallInput = {
  platform: ImPlatform;
  accountId: string;
  chat: Pick<ImChat, "kind" | "id" | "threadId">;
  /** The platform id of a message Core sent or observed. */
  messageId: string;
};

/** Recall is idempotent from Core's perspective, but the platform decides whether the target is still eligible. */
export type ImRecallResult =
  | { status: "recalled" }
  | { status: "retry"; reason: string; retryAfterMs?: number }
  | { status: "discard"; reason: string }
  | { status: "unknown"; reason: string };

export type ImHealthState =
  | "stopped"
  | "starting"
  | "connected"
  | "needs_login"
  | "error";

export type ImHealth = {
  state: ImHealthState;
  /** Safe, token-free detail for the status page. */
  detail?: string;
  /** Stable machine-readable reason, when the adapter has one. */
  code?: string;
  /** When the current state began. */
  since?: string;
  /** When a rate-limit or retry pause ends. */
  retryAt?: string;
};

export interface ImAdapter {
  readonly platform: ImPlatform;
  readonly capabilities: ImCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ImHealth>;
  send(input: ImSendInput): Promise<ImSendResult>;
  /** Download one inbound attachment for the Main Session. Core still enforces MIME and size. */
  fetchMedia?(input: ImMediaFetchInput): Promise<ImMediaFetchResult>;
  /** Withdraw an eligible platform message. Absent unless the platform truly supports recall. */
  recall?(input: ImRecallInput): Promise<ImRecallResult>;
  onInbound(handler: (message: ImInbound) => Promise<void>): void;
  /** Per-chat proactive permission; a reply-only adapter can close a window for one chat. */
  canSendProactively?(chat: ImChat): boolean | Promise<boolean>;
  /** Exact reply window when it differs between direct and group chats. */
  replyWindowMsFor?(chat: ImChat): number | undefined;
}

export type ImAccount = {
  /** Core-owned id; never the platform's bot/user id. */
  id: string;
  platform: ImPlatform;
  label: string;
  enabled: boolean;
  createdAt: string;
};

/** Where an account came from. Environment accounts are not written to `im.json`. */
export type ImAccountSource = "settings" | "environment";

export type ImBinding = {
  id: string;
  accountId: string;
  chat: ImChat;
  /** Only `thebe-main` in Phase 1; the main Session is the one durable owner voice. */
  sessionId: string;
  /** Owner chats may prompt the agent; guest chats are recorded but never run the agent. */
  role: "owner" | "guest";
  /** The platform sender id pinned when an owner binding was created. */
  senderId?: string;
  createdAt: string;
};

export type ImConversation = {
  accountId: string;
  platform: ImPlatform;
  chat: ImChat;
  sender: ImSender;
  lastMessageId: string;
  lastSeenAt: string;
};

/** The most recent inbound anchor a reply-only channel can use for one more reply. */
export type ImReplyAnchor = {
  /** Platform message id for a passive reply. */
  replyTo?: string;
  /** Short-lived reply token; never persisted or returned by an HTTP route. */
  contextToken?: string;
  receivedAt: string;
};

export type ImChannelView = ImAccount & {
  source: ImAccountSource;
  health: ImHealth;
  capabilities?: ImCapabilities;
  bindings: number;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastError?: string;
};

export type ImStatus = {
  channels: ImChannelView[];
  /** Durable inbound messages not handled yet. */
  pending: number;
};

export type ImConversationView = ImConversation & {
  binding?: Pick<ImBinding, "id" | "role" | "sessionId" | "senderId">;
};

/** Credentials are opaque to the gateway; a factory declares and validates its own fields. */
export type ImAdapterCredentials = Record<string, string>;

export type ImCredentialField = {
  key: string;
  label?: string;
  /** Defaults to true. */
  required?: boolean;
  /** Secret fields are never returned by a status response. */
  secret?: boolean;
};

/** What a client needs to configure one registered platform, without any credential value. */
export type ImPlatformInfo = {
  platform: ImPlatform;
  credentials: readonly ImCredentialField[];
  /** Whether the platform offers a QR, link or code login instead of static credentials. */
  login: boolean;
};

export type ImLoginKind = "qr" | "link" | "code";

export type ImLoginChallenge = {
  /** Opaque, in-memory login id; never a platform credential. */
  id: string;
  platform: ImPlatform;
  kind: ImLoginKind;
  /** QR payload or login URL. Returned once and never persisted or logged. */
  content: string;
  expiresAt: string;
};

export type ImLoginState =
  | "pending"
  | "scanned"
  | "need_verifycode"
  | "confirmed"
  | "expired"
  | "failed"
  | "cancelled";

export type ImLoginPoll = {
  state: ImLoginState;
  detail?: string;
  retryAfterMs?: number;
  /** Only on confirmation; the gateway stores this and never returns it over HTTP. */
  credentials?: ImAdapterCredentials;
};

export type ImLoginView = {
  id: string;
  platform: ImPlatform;
  kind: ImLoginKind;
  /** Only in the response that begins the login. */
  content?: string;
  expiresAt: string;
  state: ImLoginState;
  detail?: string;
  retryAfterMs?: number;
  accountId?: string;
};

/** A platform-owned login flow; QR payloads and credentials stay inside the adapter. */
export type ImLoginAdapter = {
  begin(input: { label: string }): Promise<ImLoginChallenge>;
  poll(challengeId: string): Promise<ImLoginPoll>;
  cancel(challengeId: string): Promise<void>;
  /** Submit a phone PIN when `poll` reports `need_verifycode`; the next poll continues the flow. */
  submitCode?(challengeId: string, code: string): Promise<void>;
};

/**
 * Builds one adapter per configured account. Credentials and platform SDKs stay on the adapter side;
 * the gateway only stores the account, its cursor and its bindings.
 */
export type ImAdapterFactory = {
  platform: ImPlatform;
  /** Required/optional credential keys for this platform. */
  credentials?: readonly ImCredentialField[];
  /** Return a safe error message when a credential value is malformed. */
  validateCredentials?(credentials: ImAdapterCredentials): string | undefined;
  /** A token/bot identity; a changed value invalidates a persisted cursor. */
  cursorIdentity?(credentials: ImAdapterCredentials): string | undefined;
  create(input: {
    account: ImAccount;
    credentials: ImAdapterCredentials;
    /** Persisted platform cursor, if this adapter has one. */
    cursor?: string;
    /** Called after an inbound update is accepted, so a restart resumes in the right place. */
    onCursor(cursor: string): void;
    /** A safe, token-free diagnostic. */
    onError?(message: string): void;
    fetch?: typeof fetch;
    now?: () => Date;
  }): ImAdapter;
  /** A QR/link/code flow for platforms that cannot be configured with a static token. */
  createLogin?(input: {
    fetch?: typeof fetch;
    now?: () => Date;
  }): ImLoginAdapter;
};

export function isKnownImPlatform(value: unknown): value is KnownImPlatform {
  return (
    typeof value === "string" &&
    (KNOWN_IM_PLATFORMS as readonly string[]).includes(value)
  );
}
