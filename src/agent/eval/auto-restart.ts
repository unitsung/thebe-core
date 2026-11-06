import type { ActionApi } from "../action/service.ts";
import { POLICY_APPROVAL } from "../action/types.ts";
import {
  CONTAINER_RESTART_ACTION_ID,
  type ContainerInfoProvider,
  type ContainerSummary,
} from "../capabilities/containers.ts";
import type { ActivityStore } from "../activity/store.ts";
import type { DiagnosisApi } from "../diagnosis/service.ts";
import type { ResourceRef } from "../diagnosis/types.ts";
import type { Trigger } from "../sources/types.ts";
import type { DecisionAction, Policy } from "./types.ts";

/** An event older than this is not acted on: the moment has passed, and a restart on stale news is a guess. */
export const AUTO_MAX_EVENT_AGE_MS = 5 * 60 * 1000;
/** Restarts Core may start on one container in an hour; the next one is left to the person. */
export const AUTO_RESTARTS_PER_HOUR = 3;

const THREAD_PREFIX = "resource:container:";

export type AutoRestart = (input: {
  decisionId: string;
  thread: string;
  triggers: readonly Trigger[];
  policy: Policy;
}) => Promise<DecisionAction>;

/**
 * What `auto` does with a Decision that was worth taking on. Everything here is deterministic and runs
 * after the model has only said accept or ignore: the model never names a target. The target is the
 * container on the thread's own name; it must be on the person's list, it must still be down when we look,
 * and a container that keeps going down is left to the person after a few tries.
 *
 * It restarts through the same `executeApprovedAction` a person's approval reaches, so the receipt, the
 * verification and the audit entry are the ones a person's restart gets. The only difference is the
 * approval's source, which says `policy`. A container that is not on the list is only diagnosed, which
 * puts a restart to the person as a pending approval.
 */
export function createAutoRestart(options: {
  provider: Pick<ContainerInfoProvider, "listContainers">;
  actions: Pick<ActionApi, "executeApprovedAction">;
  activity: Pick<ActivityStore, "list">;
  diagnose: DiagnosisApi["diagnose"];
  now: () => Date;
  maxEventAgeMs?: number;
  restartsPerHour?: number;
}): AutoRestart {
  const maxAge = options.maxEventAgeMs ?? AUTO_MAX_EVENT_AGE_MS;
  const perHour = options.restartsPerHour ?? AUTO_RESTARTS_PER_HOUR;

  const none = (
    status: string,
    note: string,
    container?: string
  ): DecisionAction => ({
    kind: "none",
    status,
    note,
    ...(container ? { container } : {}),
  });

  async function find(
    name: string
  ): Promise<ContainerSummary | DecisionAction> {
    const rows = (await options.provider.listContainers()).filter(
      (row) => row.name === name
    );
    if (rows.length === 0) {
      return none("container_not_found", "no container has that name", name);
    }
    if (rows.length > 1) {
      return none(
        "container_ambiguous",
        "more than one container has that name",
        name
      );
    }
    return rows[0]!;
  }

  function resourceOf(container: ContainerSummary): ResourceRef {
    return {
      kind: "container",
      id: container.id,
      name: container.name,
      provider: "unknown",
      image: container.image,
    };
  }

  /** Not on the list, or tripped the breaker: no direct restart, so the person is asked instead. */
  async function askThePerson(
    container: ContainerSummary,
    why: DecisionAction
  ): Promise<DecisionAction> {
    try {
      const result = await options.diagnose({
        resource: resourceOf(container),
      });
      const advised = (result.recommendations ?? []).some(
        (item) =>
          item.actionId === CONTAINER_RESTART_ACTION_ID && item.requiresApproval
      );
      return {
        kind: "diagnose",
        status: advised ? "awaiting_approval" : "no_restart_advised",
        note: `${why.note}; ${result.diagnosis.title}`,
        container: container.name,
      };
    } catch (error) {
      return none(
        "diagnose_failed",
        `${why.note}; the diagnosis failed: ${
          error instanceof Error ? error.message.slice(0, 200) : "unknown error"
        }`,
        container.name
      );
    }
  }

  return async ({ decisionId, thread, triggers, policy }) => {
    if (!thread.startsWith(THREAD_PREFIX)) {
      return none("not_a_container", "the thread is not a container");
    }
    const name = thread.slice(THREAD_PREFIX.length);
    const mine = triggers
      .filter((row) => row.threads.includes(thread))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const latest = mine[mine.length - 1];
    if (!latest) return none("no_event", "no event on the thread", name);
    // Fresh news only. A backlog replayed after a restart can be hours old.
    if (options.now().getTime() - Date.parse(latest.at) > maxAge) {
      return none("stale", "the event is too old to act on", name);
    }
    // The last thing that happened must be the container going down: it may have come back since.
    if (latest.kind !== "container.went_down") {
      return none("not_down_event", "the latest event is not a stop", name);
    }

    const found = await find(name);
    if (!("id" in found)) return found;
    // Look again now: it may have been brought back while the assessment ran. A container Docker is
    // already restarting by itself is not restarted again.
    if (found.state !== "exited" && found.state !== "dead") {
      return none("already_up", `it is ${found.state} now`, name);
    }

    if (!(policy.autoContainers ?? []).includes(name)) {
      return askThePerson(
        found,
        none("not_listed", "it is not on the auto list", name)
      );
    }

    // The breaker counts restarts Core started itself, failed ones too, from the persisted activity, so a
    // restart of Core does not reset it.
    const since = options.now().getTime() - 60 * 60 * 1000;
    const started = (await options.activity.list()).filter(
      (row) =>
        row.actionId === CONTAINER_RESTART_ACTION_ID &&
        row.approval?.source === POLICY_APPROVAL &&
        (row.resource.id === found.id || row.resource.name === name) &&
        Date.parse(row.createdAt) >= since
    ).length;
    if (started >= perHour) {
      return askThePerson(
        found,
        none(
          "breaker_open",
          `already restarted ${started} times in the last hour`,
          name
        )
      );
    }

    const receipt = await options.actions.executeApprovedAction({
      actionId: CONTAINER_RESTART_ACTION_ID,
      resource: resourceOf(found),
      // One restart per Decision, even if the Decision is made again after a crash.
      idempotencyKey: `auto:${decisionId}`,
      approval: {
        approved: true,
        approvedAt: options.now().toISOString(),
        client: POLICY_APPROVAL,
      },
    });
    return {
      kind: "restart",
      status: receipt.action.status,
      note: receipt.action.summary,
      container: name,
      receiptId: receipt.receiptId,
    };
  };
}
