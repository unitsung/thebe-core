import { expect, it, vi } from "vitest";
import { createWebSearchTools } from "./web-search-tools.ts";
import { createPolicyEngine } from "../security/policy/policy-engine.ts";

it("checks the live search switch on every call without sending disabled queries", async () => {
  const search = vi.fn().mockResolvedValue({ results: [{ url: "https://example.org" }] });
  let enabled = false;
  const policy = createPolicyEngine({ now: () => new Date(), allowedToolNames: ["web_search"] });
  const tool = createWebSearchTools({ search }, policy, "test", async () => enabled)[0]!;
  await expect(tool.execute("1", { query: "private question" })).rejects.toThrow("disabled");
  expect(search).not.toHaveBeenCalled();
  enabled = true;
  await expect(tool.execute("2", { query: " topic " })).resolves.toMatchObject({ content: [{ type: "text" }] });
  expect(search).toHaveBeenCalledWith("topic");
  enabled = false;
  await expect(tool.execute("3", { query: "topic" })).rejects.toThrow("disabled");
  expect(search).toHaveBeenCalledTimes(1);
});

it("rejects malformed queries and enforces tool policy", async () => {
  const search = vi.fn();
  const tool = createWebSearchTools({ search }, createPolicyEngine({ now: () => new Date(), allowedToolNames: ["web_search"] }), "test", async () => true)[0]!;
  await expect(tool.execute("1", {})).rejects.toThrow("query");
  await expect(tool.execute("2", { query: "x".repeat(501) })).rejects.toThrow("query");
  const denied = createWebSearchTools({ search }, createPolicyEngine({ now: () => new Date(), allowedToolNames: [] }), "test", async () => true)[0]!;
  await expect(denied.execute("3", { query: "topic" })).rejects.toThrow();
  expect(search).not.toHaveBeenCalled();
});
