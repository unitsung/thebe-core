#!/usr/bin/env node

/**
 * Release smoke test for a Core deployment.
 *
 * Default mode spawns `dist/serve.js` with a throwaway data directory and checks:
 *   - `GET /v1/health` answers ok with the token
 *   - a protected route without the token is 401
 *   - a protected route with the token is 200
 *   - a mutating request with a foreign `Host` header is 403
 *   - `PATCH /v1/settings/agent` is accepted
 *   - SIGTERM drains and exits 0
 *   - the written setting survives a Core restart (durable config store)
 *
 * Point it at an existing deployment instead of spawning:
 *   node scripts/smoke.mjs --base-url https://thebe.example.ts.net --token "$THEBE_TOKEN"
 *
 * In that mode the settings write is skipped unless `--write` is passed, because
 * a smoke test should not mutate a running deployment by default. Checking a
 * client against the deployment is manual: point it at the same URL and confirm it connects.
 *
 * The checks speak HTTP on purpose: they never import `src/`, so they verify the
 * deployed process the way a client sees it.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_SMOKE_PORT = 8799;

export function parseArgs(argv) {
  const options = {
    baseUrl: undefined,
    token: undefined,
    port: undefined,
    dist: join(coreRoot, "dist"),
    keep: false,
    write: false,
    help: false,
    timeoutMs: 30_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      return argv[index];
    };
    switch (arg) {
      case "--base-url":
        options.baseUrl = next();
        break;
      case "--token":
        options.token = next();
        break;
      case "--port":
        options.port = Number(next());
        break;
      case "--dist":
        options.dist = resolve(next());
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next());
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--write":
        options.write = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** `dist/serve.js` prints `THEBE_LISTEN <url> (version) bind=host:port`. */
export function parseListenLine(text) {
  const match = /THEBE_LISTEN\s+(http\S+)/.exec(text);
  return match ? match[1] : undefined;
}

export function requestOptions(
  baseUrl,
  { method = "GET", path = "/", token, hostHeader, body } = {}
) {
  const url = new URL(path, baseUrl);
  const protocol = url.protocol === "https:" ? "https:" : "http:";
  const headers = {};
  if (token) {
    headers["X-Thebe-Token"] = token;
  }
  if (hostHeader) {
    headers.Host = hostHeader;
  }
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  return {
    protocol,
    transport: protocol === "https:" ? https : http,
    options: {
      host: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
    },
    payload,
  };
}

export function request(baseUrl, options = {}) {
  const {
    transport,
    options: requestInit,
    payload,
  } = requestOptions(baseUrl, options);
  return new Promise((resolvePromise, reject) => {
    const req = transport.request(requestInit, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolvePromise({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text,
          json,
        });
      });
    });
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

export function coreEnv({
  dirs,
  token,
  port,
  allowedHosts = "127.0.0.1",
  extra = {},
}) {
  return {
    ...process.env,
    NODE_ENV: "production",
    THEBE_HOST: "127.0.0.1",
    THEBE_PORT: String(port),
    THEBE_TOKEN: token,
    THEBE_ALLOWED_HOSTS: allowedHosts,
    THEBE_CONFIG_DIR: dirs.config,
    THEBE_AGENT_DIR: dirs.agent,
    THEBE_AGENT_STORE_DIR: dirs.store,
    THEBE_WORKSPACE_DIR: dirs.workspace,
    THEBE_OUTPUT_DIR: dirs.outputs,
    HOME: dirs.home,
    ...extra,
  };
}

export function makeTempDirs(prefix = "thebe-smoke-") {
  const root = join(tmpdir(), `${prefix}${randomBytes(4).toString("hex")}`);
  const dirs = {
    root,
    config: join(root, "config"),
    agent: join(root, "agent"),
    store: join(root, "store"),
    workspace: join(root, "workspace"),
    outputs: join(root, "outputs"),
    home: join(root, "home"),
  };
  for (const path of Object.values(dirs)) {
    mkdirSync(path, { recursive: true });
  }
  return dirs;
}

export function findFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : undefined;
      server.close(() => {
        if (port) {
          resolvePromise(port);
        } else {
          reject(new Error("could not allocate a free port"));
        }
      });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function startCore({ dist, env, timeoutMs }) {
  const entry = join(dist, "serve.js");
  if (!existsSync(entry)) {
    throw new Error(
      `missing ${entry}; run the release check first (bash scripts/release-check.sh)`
    );
  }
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  const baseUrl = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Core did not print THEBE_LISTEN within ${timeoutMs}ms\n${output.stdout}\n${output.stderr}`
        )
      );
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output.stdout += chunk;
      const url = parseListenLine(output.stdout);
      if (url) {
        clearTimeout(timer);
        resolvePromise(url);
      }
    });
    child.stderr.on("data", (chunk) => {
      output.stderr += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Core exited early (code ${code})\n${output.stdout}\n${output.stderr}`
        )
      );
    });
  });
  return { child, baseUrl, output };
}

async function stopCore(core, { timeoutMs = 10_000 } = {}) {
  const exit = new Promise((resolvePromise) => {
    core.child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  core.child.kill("SIGTERM");
  const result = await Promise.race([
    exit,
    new Promise((resolvePromise) =>
      setTimeout(() => resolvePromise({ timeout: true }), timeoutMs)
    ),
  ]);
  if (result.timeout) {
    core.child.kill("SIGKILL");
    throw new Error(`Core did not exit within ${timeoutMs}ms after SIGTERM`);
  }
  assert(
    result.code === 0,
    `Core exited with code ${result.code} after SIGTERM`
  );
  return result;
}

async function readChecks(run, { baseUrl, token }) {
  await run("GET /v1/health with token", async () => {
    const res = await request(baseUrl, { path: "/v1/health", token });
    assert(res.status === 200, `status ${res.status}`);
    assert(res.json?.ok === true, `body ${res.text.slice(0, 120)}`);
    return `version=${res.json?.version ?? "unknown"}`;
  });
  await run("protected route rejects a missing token", async () => {
    const res = await request(baseUrl, { path: "/v1/activity" });
    assert(res.status === 401, `status ${res.status}`);
    return "401";
  });
  await run("protected route accepts the token", async () => {
    const res = await request(baseUrl, { path: "/v1/activity", token });
    assert(res.status === 200, `status ${res.status}`);
    return "200";
  });
  await run("foreign Host header is rejected on writes", async () => {
    const res = await request(baseUrl, {
      method: "PATCH",
      path: "/v1/settings/agent",
      token,
      hostHeader: "rebind.evil.example",
      body: { autoCompact: true },
    });
    assert(
      res.status === 403,
      `status ${res.status} ${res.text.slice(0, 120)}`
    );
    return "403";
  });
}

async function writeChecks(run, { baseUrl, token }) {
  await run("settings write is accepted", async () => {
    const res = await request(baseUrl, {
      method: "PATCH",
      path: "/v1/settings/agent",
      token,
      body: { autoCompact: false },
    });
    assert(
      res.status === 200,
      `status ${res.status} ${res.text.slice(0, 160)}`
    );
    assert(
      res.json?.autoCompact === false,
      `autoCompact=${res.json?.autoCompact}`
    );
    return "autoCompact=false";
  });
}

function printHelp() {
  console.log(`usage: node scripts/smoke.mjs [--base-url URL] [--token TOKEN] [--write] [--keep]
       [--port N] [--dist DIR] [--timeout-ms N]

Spawns Core from dist/ against a throwaway data dir and verifies health, token
auth, the Host allowlist, a settings write, graceful SIGTERM, and that the
setting survives a restart. With --base-url it checks an already running
deployment instead (settings write only with --write).`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const token =
    options.token || `thebe-smoke-${randomBytes(6).toString("hex")}`;
  const results = [];
  const run = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ ok: true, name });
      console.log(`ok   ${name}${detail ? ` — ${detail}` : ""}`);
    } catch (error) {
      results.push({ ok: false, name });
      console.log(
        `FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  if (options.baseUrl) {
    console.log(`smoke: existing deployment ${options.baseUrl}`);
    await readChecks(run, { baseUrl: options.baseUrl, token });
    if (options.write) {
      await writeChecks(run, { baseUrl: options.baseUrl, token });
    } else {
      console.log(
        "skip settings write check (pass --write to allow one mutating request)"
      );
    }
  } else {
    const dirs = makeTempDirs();
    const port = options.port ?? (await findFreePort());
    const env = coreEnv({ dirs, token, port });
    try {
      const first = await startCore({
        dist: options.dist,
        env,
        timeoutMs: options.timeoutMs,
      });
      console.log(
        `smoke: spawned Core at ${first.baseUrl} (data ${dirs.root})`
      );
      await readChecks(run, { baseUrl: first.baseUrl, token });
      await writeChecks(run, { baseUrl: first.baseUrl, token });
      await run("SIGTERM drains and exits 0", async () => {
        const { code } = await stopCore(first);
        return `exit=${code}`;
      });

      const second = await startCore({
        dist: options.dist,
        env,
        timeoutMs: options.timeoutMs,
      });
      await run("durable setting survives Core recreation", async () => {
        const res = await request(second.baseUrl, {
          path: "/v1/settings/agent",
          token,
        });
        assert(res.status === 200, `status ${res.status}`);
        assert(
          res.json?.autoCompact === false,
          `autoCompact=${res.json?.autoCompact}`
        );
        assert(
          res.json?.sources?.autoCompact === "configured",
          `source=${res.json?.sources?.autoCompact}`
        );
        return "autoCompact=false, source=configured";
      });
      await run("durable config file exists on disk", async () => {
        const configFile = join(dirs.config, "config.json");
        assert(existsSync(configFile), `missing ${configFile}`);
        return configFile;
      });
      await stopCore(second);
    } finally {
      if (options.keep) {
        console.log(`kept smoke data at ${dirs.root}`);
      } else {
        rmSync(dirs.root, { recursive: true, force: true });
      }
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    failed.length === 0
      ? `\nSMOKE OK (${results.length} checks)`
      : `\nSMOKE FAILED (${failed.length}/${results.length} checks)`
  );
  if (!options.baseUrl) {
    console.log(
      "Manual check: point a client at the same deployment URL with THEBE_TOKEN; open /docs to confirm the API surface."
    );
  }
  return failed.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        `smoke: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 2;
    });
}
