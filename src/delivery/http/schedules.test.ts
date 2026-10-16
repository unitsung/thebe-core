import { describe, expect, it } from "vitest";
import { createThebeAgent } from "../../agent/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createThebeHttpRouter } from "./router.ts";
import { createOpenApiDocument } from "./openapi.ts";

describe("schedule product HTTP", () => {
  it("supports the complete management lifecycle and starts a linked durable Goal", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: "Completed" },
      {
        kind: "text",
        text: "VERDICT: pass\nEVIDENCE: Checked\nREMAINING: none",
      },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: {
        listContainers: async () => [],
        inspectContainer: async () => {
          throw new Error("unused");
        },
        getContainerLogs: async () => {
          throw new Error("unused");
        },
        getStatusSummary: async () => {
          throw new Error("unused");
        },
      },
    });
    const router = createThebeHttpRouter({ agent, version: "test" });
    const request = (path: string, method = "GET", body?: unknown) =>
      router.handle(
        new Request(`http://127.0.0.1:8787/v1/schedules${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      );
    const input = {
      title: "Check",
      goal: "Check health",
      startAt: "2099-01-01T00:00:00Z",
      intervalMinutes: 60,
    };
    const response = await request("", "POST", input);
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    expect((await request(`/${created.id}`)).status).toBe(200);
    expect(
      (await request(`/${created.id}`, "PATCH", { enabled: "yes" })).status
    ).toBe(400);
    expect(
      (await request("", "POST", { ...input, intervalMinutes: -1 })).status
    ).toBe(400);
    // A cron schedule starts at its first match at or after startAt, read in its own zone.
    const { intervalMinutes: _unused, ...base } = input;
    const cronRow = await request("", "POST", {
      ...base,
      cron: "0 9 * * *",
      timeZone: "Asia/Shanghai",
    });
    expect(cronRow.status).toBe(201);
    const cronCreated = (await cronRow.json()) as {
      id: string;
      cron: string;
      timeZone: string;
      nextRunAt: string;
    };
    expect(cronCreated.cron).toBe("0 9 * * *");
    expect(cronCreated.nextRunAt).toBe("2099-01-01T01:00:00.000Z");
    expect((await request(`/${cronCreated.id}`, "DELETE")).status).toBeLessThan(
      300
    );
    for (const bad of [
      { ...base, cron: "0 9 * *" },
      { ...base, cron: "0 9 * * *", intervalMinutes: 60 },
      { ...base, cron: "0 9 * * *", timeZone: "Mars/Base" },
    ]) {
      expect((await request("", "POST", bad)).status).toBe(400);
    }
    const updated = (await (
      await request(`/${created.id}`, "PUT", { ...input, title: "Updated" })
    ).json()) as { title: string };
    expect(updated.title).toBe("Updated");
    expect(
      (await request(`/${created.id}`, "PATCH", { enabled: false })).status
    ).toBe(200);
    const run = (await (
      await request(`/${created.id}/run`, "POST")
    ).json()) as {
      lastSessionId: string;
      enabled: boolean;
      nextRunAt?: string;
    };
    expect(run.lastSessionId).toEqual(expect.any(String));
    expect(run.enabled).toBe(false);
    await agent.waitGoal(run.lastSessionId);
    expect(
      (await agent.listGoals()).some(
        (goal) => goal.thebeSessionId === run.lastSessionId
      )
    ).toBe(true);
    await agent.quiesce();
    expect(
      (await request(`/${created.id}`, "PATCH", { enabled: true })).status
    ).toBe(503);
    await agent.unquiesce();
    expect((await request(`/${created.id}`, "DELETE")).status).toBe(200);
    expect((await request(`/${created.id}`)).status).toBe(404);
    expect(await (await request("")).json()).toEqual({ schedules: [] });
    await agent.quiesce();
    const document = createOpenApiDocument("test");
    expect(document.paths["/v1/schedules"]?.post).toBeDefined();
    expect(document.components.schemas.GoalSchedule).toBeDefined();
  });
});
