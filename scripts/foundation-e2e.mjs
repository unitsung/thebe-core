// Real dist Core + Pi runtime against a deterministic compatible model fixture.
// Does not read user credentials or contact external model providers.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { makeTempDirs, findFreePort } from "./smoke.mjs";

const dirs = makeTempDirs("thebe-foundation-");
const records = [];
const checks = [];
const token = "foundation-fixture";
let requestCount = 0;
const modelServer = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "service-discovered" }] }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  body.fixtureUserAgent = req.headers["user-agent"];
  records.push(body);
  const messages = body.messages ?? [];
  const latestUser = messages.findLast(m => m.role === "user");
  const text = typeof latestUser?.content === "string" ? latestUser.content : JSON.stringify(latestUser?.content);
  if (text?.includes("FIXTURE_ERROR")) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "fixture invalid credential", type: "authentication_error" } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${++requestCount}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (text?.includes("FIXTURE_SLOW")) {
    emit({ role: "assistant", content: "开始" });
    const timer = setTimeout(() => { emit({ content: "完成" }, "stop"); res.end("data: [DONE]\n\n"); }, 3000);
    res.on("close", () => clearTimeout(timer));
    return;
  }
  const toolName = text?.includes("FIXTURE_WRITE") ? "write" : text?.includes("FIXTURE_READ") ? "read" : text?.includes("FIXTURE_EVENTS") ? "list_core_events" : undefined;
  const last = messages.at(-1);
  if (toolName && last?.role !== "tool") {
    const args = toolName === "list_core_events" ? { limit: 50 } : toolName === "write"
      ? { path: "foundation-output.txt", content: "approved-once" }
      : { path: "fixture-input.txt" };
    emit({ role: "assistant", tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }] }, "tool_calls");
  } else {
    const answer = text?.includes("FIXTURE_WORKER") ? "WORKER_OK" : toolName ? "TOOL_FINISHED" : "FOUNDATION_OK";
    emit({ role: "assistant", content: answer.slice(0, 5) });
    emit({ content: answer.slice(5) }, "stop");
  }
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
modelServer.listen(0, "127.0.0.1");
await once(modelServer, "listening");
const modelPort = modelServer.address().port;
await writeFile(join(dirs.agent, "models.json"), JSON.stringify({ providers: { opencode: {
  baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", apiKey: "fixture",
  models: ["fixture-model"].map(id => ({ id, contextWindow: 128000, maxTokens: 2048, reasoning: true, thinkingLevelMap: { off: "none" }, input: ["text", "image"] })),
} } }));
await writeFile(join(dirs.workspace, "fixture-input.txt"), "fixture read result");
const port = process.env.FOUNDATION_PORT ? Number(process.env.FOUNDATION_PORT) : await findFreePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  PATH: process.env.PATH, HOME: dirs.home, NODE_ENV: "production",
  THEBE_HOST: "127.0.0.1", THEBE_PORT: String(port), THEBE_TOKEN: token, THEBE_ALLOWED_HOSTS: "127.0.0.1",
  THEBE_CONFIG_DIR: dirs.config, THEBE_AGENT_DIR: dirs.agent, THEBE_AGENT_STORE_DIR: dirs.store,
  THEBE_SESSION_DIR: join(dirs.root, "sessions"), THEBE_WORKSPACE_DIR: dirs.workspace, THEBE_OUTPUT_DIR: dirs.outputs,
};
const core = spawn(process.execPath, ["dist/serve.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
let coreLog = "";
core.stdout.on("data", data => coreLog += data);
core.stderr.on("data", data => coreLog += data);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(condition, name) { checks.push({ name, passed: Boolean(condition) }); console.log(`${condition ? "PASS" : "FAIL"} ${name}`); if (!condition) throw new Error(name); }
async function request(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + path, { method, headers: { "X-Thebe-Token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  return { status: response.status, data };
}
async function waitFor(load, predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await load(); if (predicate(value)) return value; await sleep(50); }
  throw new Error("timed out waiting for state");
}
async function createSession() {
  const r = await request("/v1/session", { title: "Foundation verification", model: { providerId: "opencode", modelId: "fixture-model" }, builtinTools: ["read", "write"] });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  return r.data.thebeSessionId;
}
try {
  await waitFor(async () => { try { return await request("/v1/health"); } catch { return null; } }, r => r?.status === 200);
  const models = await request("/v1/model?provider=opencode");
  check(models.data.models.some(m => m.available === true), "real runtime model availability");
  const providerPath = "/v1/provider/integration-provider/config";
  const provider = { name: "Integration provider", baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", apiKey: "private-fixture-key", models: [{ id: "original" }, { id: "remove-me" }] };
  const configured = await request(providerPath, provider, "PUT");
  check(configured.status === 200 && !JSON.stringify(configured.data).includes("private-fixture-key"), "provider create does not return credentials");
  const persistedAuth = JSON.parse(await readFile(join(dirs.agent, "auth.json"), "utf8"));
  check(persistedAuth["integration-provider"]?.key === "private-fixture-key", "API key stored by SDK for restart");
  const edited = await request(providerPath, { ...provider, apiKey: undefined, models: [{ id: "renamed", contextWindow: 64000 }] }, "PUT");
  const editedModels = await request("/v1/model?provider=integration-provider");
  check(edited.status === 200 && editedModels.data.models.length === 1 && editedModels.data.models[0].modelId === "renamed" && editedModels.data.models[0].available, "provider model edits and removals reach runtime");
  const discoveredModels = await request("/v1/model?provider=integration-provider&refresh=true");
  check(discoveredModels.status === 200 && discoveredModels.data.models.length === 1 && discoveredModels.data.models[0].modelId === "service-discovered", "model picker uses the service list instead of the catalogue");
  const discoveredSession = await request("/v1/session", { model: { providerId: "integration-provider", modelId: "service-discovered" }, builtinTools: [] });
  const discoveredReply = await request(`/v1/session/${discoveredSession.data.thebeSessionId}/prompt`, { text: "FIXTURE_PLAIN" });
  check(discoveredReply.status === 200 && discoveredReply.data.text === "FOUNDATION_OK", "newly discovered model can be selected and called");
  const duplicateModels = await request(providerPath, { ...provider, models: [{ id: "duplicate" }, { id: "duplicate" }] }, "PUT");
  check(duplicateModels.status === 400, "duplicate model IDs rejected without changing config");
  const removed = await request(providerPath, undefined, "DELETE");
  const missing = await request(providerPath);
  check(removed.status === 200 && missing.status === 404, "custom provider deletion is effective");
  const remainingAuth = JSON.parse(await readFile(join(dirs.agent, "auth.json"), "utf8"));
  check(!remainingAuth["integration-provider"], "provider deletion removes stored credentials");
  const settings = (await request("/v1/settings/agent")).data;
  check(settings.permissionMode === "ask" && settings.persistence.enabled, "effective settings and persistence");
  const changed = await request("/v1/settings/agent", { autoSummary: false, autoCompact: false, autoSummaryDelayMs: 60000 }, "PATCH");
  check(changed.data.autoSummary === false && changed.data.autoCompact === false, "mutable settings applied");
  const restart = await request("/v1/settings/agent", { maxSubagentConcurrency: 4 }, "PATCH");
  check(restart.status === 409, "concurrency change requires restart");
  const sid = await createSession();
  for (const level of ["off", "low", "medium", "high"]) {
    const thinking = await request(`/v1/session/${sid}/thinking`, { level });
    check(thinking.status === 200 && thinking.data.thinking.level === level, `Core thinking setting applies ${level}`);
    const start = records.length;
    await request(`/v1/session/${sid}/prompt`, { text: "FIXTURE_PLAIN" });
    const wire = records[start];
    check(wire.reasoning_effort === (level === "off" ? "none" : level), `Pi sends effective thinking ${level} to provider`);
  }
  await request(`/v1/session/${sid}/thinking`, { level: "off" });
  const plain = await request(`/v1/session/${sid}/prompt`, { text: "FIXTURE_PLAIN parent-secret-marker" });
  check(plain.status === 200 && plain.data.text === "FOUNDATION_OK", "real Core and Pi text completion");
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
  const imageStart = records.length;
  const multimodal = await request(`/v1/session/${sid}/prompt`, { text: "FIXTURE_IMAGE", files: [
    { filename: "pixel.png", mediaType: "image/png", data: imageData },
    { filename: "note.txt", mediaType: "text/plain", data: Buffer.from("附件内容：中文🙂").toString("base64") },
  ] });
  if (multimodal.status !== 200) console.error(JSON.stringify(multimodal));
  check(multimodal.status === 200, "multimodal prompt completes through real runtime");
  const imageWire = JSON.stringify(records[imageStart]?.messages);
  check(imageWire.includes(`data:image/png;base64,${imageData}`), "image bytes reach model request unchanged");
  check(imageWire.includes("附件内容：中文🙂"), "text attachment reaches model as decoded Unicode");
  const longId = await createSession();
  for (let turn = 0; turn < 12; turn++) {
    const result = await request(`/v1/session/${longId}/prompt`, { text: `FIXTURE_LONG_${turn} ${"上下文🙂".repeat(600)}` });
    check(result.status === 200, `long conversation turn ${turn + 1} completes`);
  }
  const longWire = records.at(-1).messages;
  check(longWire.filter(m => m.role === "user").length === 12 && JSON.stringify(longWire).includes("FIXTURE_LONG_0"), "long conversation retains early and recent turns");
  check(!records.some(r => r.fixtureUserAgent?.toLowerCase().startsWith("opencode/")), "Core does not impersonate OpenCode user agent");
  const log = await request(`/v1/session/${sid}/log`);
  check(JSON.stringify(log.data).includes("text_delta") && JSON.stringify(log.data).includes("session_end"), "incremental session log and terminal event");
  const read = await request(`/v1/session/${sid}/prompt`, { text: "FIXTURE_READ" });
  check(read.status === 200 && read.data.tools.includes("read"), "real read tool round trip");
  check(records.some(r => r.messages?.some(m => m.role === "tool" && JSON.stringify(m.content).includes("fixture read result"))), "tool output reaches model context");
  const eventsReply = await request(`/v1/session/${sid}/prompt`, { text: "FIXTURE_EVENTS" });
  check(eventsReply.status === 200 && eventsReply.data.tools.includes("list_core_events"), "advertised core event tool is callable by the model");
  check(records.some(r => r.messages?.some(m => m.role === "tool" && JSON.stringify(m.content).includes("text_delta"))), "event tool returns real session events to the model");
  for (const decision of ["deny", "allow"]) {
    const writeId = await createSession();
    const turn = request(`/v1/session/${writeId}/prompt`, { text: "FIXTURE_WRITE" });
    const pending = await waitFor(() => request("/v1/permissions"), r => r.data.permissions?.some(p => p.thebeSessionId === writeId || p.sessionId === writeId));
    const permission = pending.data.permissions.find(p => p.thebeSessionId === writeId || p.sessionId === writeId);
    await request(`/v1/session/${writeId}/permission/${permission.id ?? permission.permissionId}`, { response: decision });
    const result = await turn;
    check(result.status === 200, `write ${decision} resolves waiting model turn`);
    let content; try { content = await readFile(join(dirs.workspace, "foundation-output.txt"), "utf8"); } catch {}
    check(decision === "allow" ? content === "approved-once" : content === undefined, `write ${decision} side effect matches decision`);
  }
  const slowId = await createSession();
  const slow = request(`/v1/session/${slowId}/prompt`, { text: "FIXTURE_SLOW" });
  await sleep(200);
  const busy = await request(`/v1/session/${slowId}/prompt`, { text: "second" });
  check(busy.status === 409, "duplicate prompt rejected while streaming");
  await request(`/v1/session/${slowId}/interrupt`, {});
  await slow;
  const recovery = await request(`/v1/session/${slowId}/prompt`, { text: "FIXTURE_PLAIN" });
  check(recovery.status === 200 && recovery.data.text === "FOUNDATION_OK", "interrupt and next-turn recovery");
  const errorId = await createSession();
  const error = await request(`/v1/session/${errorId}/prompt`, { text: "FIXTURE_ERROR" });
  check(error.status === 500, "provider failure remains a failure");
  const retried = await request(`/v1/session/${errorId}/prompt`, { text: "FIXTURE_PLAIN" });
  check(retried.status === 200 && retried.data.text === "FOUNDATION_OK", "provider failure does not lock session");
  const profiles = await request("/v1/subagents/profiles");
  check(profiles.data.profiles.some(p => p.name === "diagnostics"), "subagent profile discovery");
  const workerStartIndex = records.length;
  const spawned = await request("/v1/subagents", { parentSessionId: sid, profileName: "diagnostics", task: "FIXTURE_WORKER" });
  const worker = await waitFor(() => request(`/v1/subagents/${spawned.data.runId}`), r => ["completed", "failed", "cancelled"].includes(r.data.status));
  if (worker.data.status !== "completed") console.error(JSON.stringify(worker.data));
  check(worker.data.status === "completed", "real isolated subagent completes");
  check(records[workerStartIndex]?.model === "fixture-model", "subagent uses selected parent model when profile has no override");
  check(!records.slice(workerStartIndex).some(r => r.tools?.some(t => ["list_core_events", "diagnose_from_events"].includes(t.function?.name))), "subagent has no control-plane event tools");
  check(!JSON.stringify(records.slice(workerStartIndex)).includes("parent-secret-marker"), "subagent receives no parent transcript");
  const slowWorker = await request("/v1/subagents", { parentSessionId: sid, profileName: "diagnostics", task: "FIXTURE_SLOW" });
  await sleep(150);
  const cancelledWorker = await request(`/v1/subagents/${slowWorker.data.runId}/cancel`, {});
  check(cancelledWorker.data.status === "cancelled", "subagent cancellation settles terminal state");
  const restored = await request("/v1/settings/agent", { autoSummary: settings.autoSummary, autoCompact: settings.autoCompact, autoSummaryDelayMs: settings.autoSummaryDelayMs }, "PATCH");
  check(restored.data.autoSummary === settings.autoSummary, "test settings restored");
  console.log(`READY ${base} DATA ${dirs.root}`);
} catch (error) {
  console.error(String(error));
  console.error(coreLog.slice(-2000));
  process.exitCode = 1;
} finally {
  if (process.env.FOUNDATION_REPORT) await writeFile(process.env.FOUNDATION_REPORT, JSON.stringify({ checks, fixture: true, dataDir: dirs.root }, null, 2));
  if (!process.argv.includes("--serve") || process.exitCode) {
    core.kill("SIGTERM");
    modelServer.close();
    await once(core, "exit");
  }
}
