import type { ChannelAdapter } from "../../agent/channels/types.ts";
import type {
  ChannelRef,
  Source,
  SourceAdmission,
  Trigger,
} from "../../agent/sources/types.ts";
import { key } from "../../agent/tickets/ids.ts";

export const GITHUB_SOURCE_ID = "github";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const MAX_SEEN_EVENTS = 300;
const MAX_BODY_CHARS = 4_000;
const REQUEST_TIMEOUT_MS = 20_000;

export const GITHUB_ASSESSED_KINDS = [
  "github.issue.opened",
  "github.issue.closed",
  "github.issue.reopened",
  "github.issue.comment",
  "github.pull_request.opened",
  "github.pull_request.closed",
  "github.pull_request.reopened",
  "github.pull_request.review",
  "github.pull_request.review_comment",
] as const;

type FetchLike = typeof fetch;

type GithubActor = {
  login: string;
  type: string;
};

type GithubEvent = {
  id: string;
  type: string;
  actor: GithubActor;
  repo: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

type RepoCursor = {
  etag?: string;
  seen: string[];
  /** The first successful read only records a baseline, like the built-in Sources. */
  initialized: boolean;
};

type Cursor = {
  n: number;
  repos: Record<string, RepoCursor>;
};

export type GithubSourceOptions = {
  /** `owner/name` repositories to poll. */
  repositories: readonly string[];
  token?: string;
  /** The account whose `@mention` is an explicit request for Thebe. */
  agentLogin?: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Pages of 100 events to read per repository per poll. */
  maxPages?: number;
  /** Treat issue/PR comments that do not mention the agent as events for Eval. Off by default. */
  admitUnaddressedComments?: boolean;
  /** Treat newly opened issues and pull requests as inferred work for Eval. On by default. */
  admitOpened?: boolean;
};

/**
 * Polls the repositories' GitHub event feeds. One event is one immutable Trigger, named by the
 * repository's own event id so a restart cannot store it twice.
 *
 * Admission is deterministic and belongs to this Source: bot events are ignored; a comment that
 * mentions the configured agent account is an explicit human request; a newly opened issue or pull
 * request is inferred work for Eval. A comment with no mention does not reach a model.
 */
export function createGithubSource(options: GithubSourceOptions): Source {
  const repositories = normalizeRepositories(options.repositories);
  if (repositories.length === 0) {
    throw new Error("GitHub Source needs at least one repository");
  }
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const apiBaseUrl = trimSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const maxPages = Math.max(1, Math.min(5, options.maxPages ?? 2));

  return {
    id: GITHUB_SOURCE_ID,
    scope: `GitHub events (${repositories.join(", ")})`,
    assessedKinds: GITHUB_ASSESSED_KINDS,
    admit: (trigger) => admissionFor(trigger),
    async read(rawCursor, signal) {
      const previous = parseCursor(rawCursor);
      const next: Cursor = {
        n: previous?.n ?? 0,
        repos: { ...previous?.repos },
      };
      const triggers: Trigger[] = [];

      for (const repo of repositories) {
        const saved = previous?.repos[repo] ?? {
          seen: [],
          initialized: false,
        };
        const result = await readEvents({
          fetcher,
          apiBaseUrl,
          repository: repo,
          token: options.token,
          etag: saved.etag,
          maxPages,
          signal,
        });
        if (result.notModified) continue;

        const seen = new Set(saved.seen);
        const fresh = result.events.filter((event) => !seen.has(event.id));
        next.repos[repo] = {
          ...(result.etag ? { etag: result.etag } : {}),
          initialized: true,
          seen: [
            ...result.events.map((event) => event.id),
            ...saved.seen.filter(
              (id) => !result.events.some((e) => e.id === id)
            ),
          ].slice(0, MAX_SEEN_EVENTS),
        };
        // The first read is a baseline: it must not announce the repository's history.
        if (!saved.initialized) continue;

        for (const event of fresh.sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt)
        )) {
          const trigger = toTrigger(event, {
            now,
            agentLogin: options.agentLogin,
            admitOpened: options.admitOpened !== false,
            admitUnaddressedComments: options.admitUnaddressedComments === true,
          });
          if (trigger) triggers.push(trigger);
        }
        next.n += 1;
      }

      return { triggers, cursor: JSON.stringify(next) };
    },
  };
}

export type GithubChannelOptions = {
  token?: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
  /** When set, the adapter refuses addresses outside these repositories. */
  repositories?: readonly string[];
};

/** Writes a Ticket notice back as an issue or pull-request comment. */
export function createGithubChannelAdapter(
  options: GithubChannelOptions = {}
): ChannelAdapter {
  const fetcher = options.fetch ?? fetch;
  const apiBaseUrl = trimSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const allowed = options.repositories
    ? new Set(normalizeRepositories(options.repositories))
    : undefined;

  return {
    id: GITHUB_SOURCE_ID,
    accepts(channel) {
      const parsed = parseIssueChannel(channel);
      if (!parsed) return false;
      return !allowed || allowed.has(parsed.repository);
    },
    async send(input) {
      const parsed = parseIssueChannel(input.channel);
      if (!parsed) throw new Error("invalid GitHub issue channel");
      const marker = noticeMarker(input.idempotencyKey);
      if (
        await hasComment({
          fetcher,
          apiBaseUrl,
          token: options.token,
          repository: parsed.repository,
          issue: parsed.issue,
          marker,
        })
      ) {
        return;
      }
      await githubRequest({
        fetcher,
        apiBaseUrl,
        token: options.token,
        path: `/repos/${repoPath(parsed.repository)}/issues/${parsed.issue}/comments`,
        method: "POST",
        body: {
          body: `${truncate(input.notice.message, 60_000)}\n\n${marker}`,
        },
      });
    },
  };
}

/** Builds the production Source and Channel adapter from environment variables, or nothing. */
export function createGithubFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { source: Source; channel: ChannelAdapter } | undefined {
  const repositories = (env.THEBE_GITHUB_REPOS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (repositories.length === 0) return undefined;
  const common = {
    repositories,
    ...(env.THEBE_GITHUB_TOKEN?.trim()
      ? { token: env.THEBE_GITHUB_TOKEN.trim() }
      : {}),
    ...(env.THEBE_GITHUB_API_URL?.trim()
      ? { apiBaseUrl: env.THEBE_GITHUB_API_URL.trim() }
      : {}),
  };
  return {
    source: createGithubSource({
      ...common,
      ...(env.THEBE_GITHUB_AGENT_LOGIN?.trim()
        ? { agentLogin: env.THEBE_GITHUB_AGENT_LOGIN.trim() }
        : {}),
      ...(env.THEBE_GITHUB_ADMIT_UNMENTIONED === "1"
        ? { admitUnaddressedComments: true }
        : {}),
      ...(env.THEBE_GITHUB_ADMIT_OPENED === "0" ? { admitOpened: false } : {}),
    }),
    channel: createGithubChannelAdapter(common),
  };
}

/**
 * The runner calls this after `read`; the Trigger already carries the same classification, so this
 * keeps the source-level contract without re-reading the event's payload.
 */
function admissionFor(trigger: Trigger): SourceAdmission {
  return trigger.admission ?? (trigger.human ? "inferred" : "ignore");
}

function toTrigger(
  event: GithubEvent,
  policy: {
    now: () => Date;
    agentLogin?: string;
    admitOpened: boolean;
    admitUnaddressedComments: boolean;
  }
): Trigger | undefined {
  const mapped = classify(event);
  if (!mapped) return undefined;
  const human = isHuman(event.actor);
  const thread = mapped.issue
    ? `resource:github:${event.repo}:${mapped.issueKind}:${mapped.issue}`
    : `resource:github:${event.repo}`;
  const channel: ChannelRef | undefined =
    mapped.issue !== undefined
      ? {
          source: GITHUB_SOURCE_ID,
          thread,
          address: {
            repo: event.repo,
            issue: String(mapped.issue),
            kind: mapped.issueKind,
          },
        }
      : undefined;
  const mention = policy.agentLogin
    ? mentions(event, policy.agentLogin)
    : false;
  const admission = admit({
    human,
    mention,
    kind: mapped.kind,
    admitOpened: policy.admitOpened,
    admitUnaddressedComments: policy.admitUnaddressedComments,
  });

  return {
    id: key("trigger", GITHUB_SOURCE_ID, event.repo, event.id),
    source: GITHUB_SOURCE_ID,
    kind: mapped.kind,
    at: validDate(event.createdAt) ?? policy.now().toISOString(),
    threads: [thread],
    resource: {
      kind: GITHUB_SOURCE_ID,
      id: mapped.issue
        ? `${event.repo}#${mapped.issueKind}/${mapped.issue}`
        : event.repo,
    },
    payload: {
      event: event.type,
      action: mapped.action,
      repository: event.repo,
      ...(mapped.issue !== undefined
        ? {
            issue: mapped.issue,
            issueKind: mapped.issueKind,
            title: mapped.title,
            url: mapped.url,
            ...(mapped.body ? { body: mapped.body } : {}),
          }
        : {}),
      actor: event.actor.login,
      actorType: event.actor.type,
    },
    ...(human || event.actor.login
      ? { actor: { source: GITHUB_SOURCE_ID, id: event.actor.login } }
      : {}),
    human,
    admission,
    ...(mention ? { addressed: "mention" as const } : {}),
    ...(channel ? { channel } : {}),
  };
}

function admit(input: {
  human: boolean;
  mention: boolean;
  kind: string;
  admitOpened: boolean;
  admitUnaddressedComments: boolean;
}): SourceAdmission {
  if (!input.human) return "ignore";
  if (input.mention) return "explicit";
  if (input.kind.endsWith(".opened") && input.admitOpened) return "inferred";
  if (
    (input.kind === "github.issue.comment" ||
      input.kind === "github.pull_request.review_comment") &&
    input.admitUnaddressedComments
  ) {
    return "inferred";
  }
  return "ignore";
}

function classify(event: GithubEvent):
  | {
      kind: string;
      action: string;
      issue?: number;
      issueKind: "issue" | "pull";
      title?: string;
      url?: string;
      body?: string;
    }
  | undefined {
  const payload = event.payload;
  const action = stringValue(payload.action);
  switch (event.type) {
    case "IssuesEvent": {
      const issue = recordValue(payload.issue);
      const number = numberValue(issue?.number);
      if (!number || !action) return undefined;
      return {
        kind: `github.issue.${action}`,
        action,
        issue: number,
        issueKind: "issue",
        ...summaryOf(issue, payload),
      };
    }
    case "IssueCommentEvent": {
      const issue = recordValue(payload.issue);
      const comment = recordValue(payload.comment);
      const number = numberValue(issue?.number);
      if (!number || action !== "created") return undefined;
      // GitHub reports a pull request's conversation comments as IssueCommentEvent; the embedded
      // pull_request is what keeps them on the same thread as the PR's own events.
      const issueKind = recordValue(issue?.pull_request) ? "pull" : "issue";
      return {
        kind: "github.issue.comment",
        action,
        issue: number,
        issueKind,
        ...summaryOf(issue, payload),
        ...(stringValue(comment?.body)
          ? { body: truncate(stringValue(comment?.body)!, MAX_BODY_CHARS) }
          : {}),
      };
    }
    case "PullRequestEvent": {
      const pull = recordValue(payload.pull_request);
      const number = numberValue(pull?.number);
      if (!number || !action) return undefined;
      return {
        kind: `github.pull_request.${action}`,
        action,
        issue: number,
        issueKind: "pull",
        ...summaryOf(pull, payload),
      };
    }
    case "PullRequestReviewEvent": {
      const pull = recordValue(payload.pull_request);
      const review = recordValue(payload.review);
      const number = numberValue(pull?.number);
      if (!number || action !== "submitted") return undefined;
      return {
        kind: "github.pull_request.review",
        action,
        issue: number,
        issueKind: "pull",
        ...summaryOf(pull, payload),
        ...(stringValue(review?.body)
          ? { body: truncate(stringValue(review?.body)!, MAX_BODY_CHARS) }
          : {}),
      };
    }
    case "PullRequestReviewCommentEvent": {
      const pull = recordValue(payload.pull_request);
      const comment = recordValue(payload.comment);
      const number = numberValue(pull?.number);
      if (!number || action !== "created") return undefined;
      return {
        kind: "github.pull_request.review_comment",
        action,
        issue: number,
        issueKind: "pull",
        ...summaryOf(pull, payload),
        ...(stringValue(comment?.body)
          ? { body: truncate(stringValue(comment?.body)!, MAX_BODY_CHARS) }
          : {}),
      };
    }
    default:
      return undefined;
  }
}

function summaryOf(
  subject: Record<string, unknown> | undefined,
  payload: Record<string, unknown>
): { title?: string; url?: string; body?: string } {
  const title = stringValue(subject?.title);
  const url =
    stringValue(subject?.html_url) ??
    stringValue(payload.comment && recordValue(payload.comment)?.html_url);
  const body = stringValue(subject?.body);
  return {
    ...(title ? { title: truncate(title, 500) } : {}),
    ...(url ? { url } : {}),
    ...(body ? { body: truncate(body, MAX_BODY_CHARS) } : {}),
  };
}

function mentions(event: GithubEvent, login: string): boolean {
  const payload = event.payload;
  const action = stringValue(payload.action);
  // A body is new text only when the event opens or edits it. A push, close, reopen, or label
  // carries the same old body, and an old mention must not turn it into a fresh request.
  const newBody = (subject: unknown): string | undefined =>
    action === "opened" || action === "edited"
      ? stringValue(recordValue(subject)?.body)
      : undefined;
  // Only the event's own new text can address the bot.
  const text =
    event.type === "IssueCommentEvent" ||
    event.type === "PullRequestReviewCommentEvent"
      ? stringValue(recordValue(payload.comment)?.body)
      : event.type === "PullRequestReviewEvent"
        ? stringValue(recordValue(payload.review)?.body)
        : event.type === "IssuesEvent"
          ? newBody(payload.issue)
          : event.type === "PullRequestEvent"
            ? newBody(payload.pull_request)
            : undefined;
  if (!text) return false;
  // Match a whole login: `@thebe-agent-extra` and `me@thebe-agent` are not mentions.
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^A-Za-z0-9_@-])@${escaped}(?![A-Za-z0-9_-])`,
    "i"
  ).test(text);
}

function isHuman(actor: GithubActor): boolean {
  return (
    actor.type === "User" &&
    !actor.login.endsWith("[bot]") &&
    actor.login !== "github-actions"
  );
}

async function readEvents(input: {
  fetcher: FetchLike;
  apiBaseUrl: string;
  repository: string;
  token?: string;
  etag?: string;
  maxPages: number;
  signal?: AbortSignal;
}): Promise<
  | { notModified: true }
  | { notModified: false; events: GithubEvent[]; etag?: string }
> {
  const events: GithubEvent[] = [];
  let etag: string | undefined;
  for (let page = 1; page <= input.maxPages; page += 1) {
    const response = await githubResponse({
      fetcher: input.fetcher,
      apiBaseUrl: input.apiBaseUrl,
      token: input.token,
      path: `/repos/${repoPath(input.repository)}/events?per_page=100&page=${page}`,
      signal: input.signal,
      ...(page === 1 && input.etag ? { etag: input.etag } : {}),
    });
    if (response.status === 304) {
      if (page === 1) return { notModified: true };
      break;
    }
    if (!response.ok) {
      throw new Error(
        `GitHub events for ${input.repository} failed: ${response.status}`
      );
    }
    if (page === 1) {
      etag = response.headers.get("etag") ?? undefined;
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error(
        `GitHub events for ${input.repository} returned an invalid body`
      );
    }
    const parsed = payload
      .map((entry) => parseEvent(entry, input.repository))
      .filter((event): event is GithubEvent => event !== undefined);
    events.push(...parsed);
    if (payload.length < 100) break;
  }
  return {
    notModified: false,
    events,
    ...(etag ? { etag } : {}),
  };
}

function parseEvent(
  value: unknown,
  repository: string
): GithubEvent | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const id = stringValue(record.id);
  const type = stringValue(record.type);
  const createdAt = validDate(stringValue(record.created_at));
  const actor = recordValue(record.actor);
  const login = stringValue(actor?.login);
  const actorType = stringValue(actor?.type);
  const payload = recordValue(record.payload);
  if (!id || !type || !createdAt || !login || !actorType || !payload) {
    return undefined;
  }
  return {
    id,
    type,
    actor: { login, type: actorType },
    repo: stringValue(recordValue(record.repo)?.name) ?? repository,
    createdAt,
    payload,
  };
}

async function githubResponse(input: {
  fetcher: FetchLike;
  apiBaseUrl: string;
  token?: string;
  path: string;
  method?: string;
  body?: unknown;
  etag?: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "thebe-core",
    "x-github-api-version": "2022-11-28",
  };
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  if (input.etag) headers["if-none-match"] = input.etag;
  if (input.body !== undefined) headers["content-type"] = "application/json";
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return input.fetcher(`${input.apiBaseUrl}${input.path}`, {
    method: input.method ?? "GET",
    headers,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  });
}

async function githubRequest(input: {
  fetcher: FetchLike;
  apiBaseUrl: string;
  token?: string;
  path: string;
  method: string;
  body: unknown;
}): Promise<unknown> {
  const response = await githubResponse(input);
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status}`);
  }
  return response.json();
}

async function hasComment(input: {
  fetcher: FetchLike;
  apiBaseUrl: string;
  token?: string;
  repository: string;
  issue: number;
  marker: string;
}): Promise<boolean> {
  try {
    // GitHub returns issue comments oldest first. A long thread's marker is on
    // a later page, so the retry check must page through instead of looking
    // only at the first 100 comments. The cap bounds a pathological thread.
    const pageSize = 100;
    const maxPages = 20;
    for (let page = 1; page <= maxPages; page += 1) {
      const value = await githubRequest({
        fetcher: input.fetcher,
        apiBaseUrl: input.apiBaseUrl,
        token: input.token,
        path: `/repos/${repoPath(input.repository)}/issues/${input.issue}/comments?per_page=${pageSize}&page=${page}`,
        method: "GET",
        body: undefined,
      });
      if (!Array.isArray(value)) return false;
      const found = value.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).body === "string" &&
          ((entry as Record<string, unknown>).body as string).includes(
            input.marker
          )
      );
      if (found) return true;
      if (value.length < pageSize) return false;
    }
    return false;
  } catch {
    // A failed duplicate check must not stop the notice: at-least-once is better than silent loss.
    return false;
  }
}

function parseIssueChannel(
  channel: ChannelRef
): { repository: string; issue: number } | undefined {
  if (channel.source !== GITHUB_SOURCE_ID) return undefined;
  const repository = channel.address?.repo;
  const issue = Number(channel.address?.issue);
  if (!repository || !Number.isInteger(issue) || issue <= 0) return undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return undefined;
  return { repository, issue };
}

function noticeMarker(idempotencyKey: string): string {
  return `<!-- thebe-notice:${idempotencyKey} -->`;
}

function normalizeRepositories(repositories: readonly string[]): string[] {
  return [
    ...new Set(
      repositories
        .map((repository) => repository.trim())
        .filter((repository) =>
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
        )
    ),
  ];
}

function repoPath(repository: string): string {
  return repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function validDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      n?: unknown;
      repos?: unknown;
    };
    if (
      typeof parsed.n === "number" &&
      parsed.repos &&
      typeof parsed.repos === "object" &&
      !Array.isArray(parsed.repos)
    ) {
      const repos: Record<string, RepoCursor> = {};
      for (const [repository, value] of Object.entries(
        parsed.repos as Record<string, unknown>
      )) {
        const record = recordValue(value);
        if (!record) continue;
        repos[repository] = {
          ...(typeof record.etag === "string" ? { etag: record.etag } : {}),
          initialized: record.initialized !== false,
          seen: Array.isArray(record.seen)
            ? record.seen.filter(
                (entry): entry is string => typeof entry === "string"
              )
            : [],
        };
      }
      return { n: parsed.n, repos };
    }
  } catch {
    // An unreadable cursor takes a fresh baseline instead of replaying the feed.
  }
  return undefined;
}
