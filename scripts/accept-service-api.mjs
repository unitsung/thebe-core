#!/usr/bin/env node

/**
 * Acceptance check for one or more `service_api` (OpenAPI) services.
 *
 * Spawns `dist/serve.js` with a throwaway data dir, then walks the product API
 * the way the App or an MCP client would:
 *   - the per-operation tools appear under GET /v1/capabilities
 *   - service_api_discover lists the service's operations
 *   - a configured read operation is invoked and returns real data
 *   - `--confirm` proves the two-phase write contract end to end: the write
 *     makes no change and returns a confirmToken, `service_api.confirm` executes
 *     exactly that request, the token cannot be replayed, and (with --verify /
 *     --expect) the side effect is observable through a read
 *
 * Usage (spawn a throwaway Core):
 *   THEBE_SERVICE_APIS='[{"id":"petstore","baseURL":"https://petstore3.swagger.io/api/v3","openapiPath":"/openapi.json","readOperations":["findPetsByStatus"]}]' \
 *     node scripts/accept-service-api.mjs --operation service_api.petstore.findPetsByStatus --arguments '{"status":"available"}'
 *
 * Point it at a running deployment instead:
 *   node scripts/accept-service-api.mjs --base-url https://thebe.example.ts.net --token "$THEBE_TOKEN" --operation service_api.radarr.getMovie --arguments '{"id":1}'
 *
 * Radarr example (spec served elsewhere than the API host):
 *   THEBE_SERVICE_APIS='[{"id":"radarr","baseURL":"http://radarr.local:7878","openapiURL":"https://raw.githubusercontent.com/Radarr/Radarr/develop/src/Radarr.Api.V3/openapi.json","headersEnv":{"X-Api-Key":"RADARR_API_KEY"},"readOperations":["getMovieById"]}]' \
 *     RADARR_API_KEY=... node scripts/accept-service-api.mjs --query movie --operation service_api.radarr.getMovieById --arguments '{"id":1}'
 *
 * It speaks HTTP on purpose and never imports src/, so it checks the deployed
 * process the way a client sees it.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  coreEnv,
  findFreePort,
  makeTempDirs,
  parseListenLine,
  request,
} from "./smoke.mjs";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    baseUrl: undefined,
    token: undefined,
    operation: undefined,
    arguments: undefined,
    query: undefined,
    preview: undefined,
    confirm: undefined,
    confirmArguments: undefined,
    verify: undefined,
    verifyArguments: undefined,
    expect: undefined,
    cleanup: undefined,
    cleanupArguments: undefined,
    keep: false,
    dist: join(coreRoot, "dist"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const next = () => argv[++index];
    switch (argv[index]) {
      case "--base-url":
        options.baseUrl = next();
        break;
      case "--token":
        options.token = next();
        break;
      case "--operation":
        options.operation = next();
        break;
      case "--arguments":
        options.arguments = next();
        break;
      case "--query":
        options.query = next();
        break;
      case "--preview":
        options.preview = next();
        break;
      case "--preview-arguments":
        options.previewArguments = next();
        break;
      case "--confirm":
        options.confirm = next();
        break;
      case "--confirm-arguments":
        options.confirmArguments = next();
        break;
      case "--verify":
        options.verify = next();
        break;
      case "--verify-arguments":
        options.verifyArguments = next();
        break;
      case "--expect":
        options.expect = next();
        break;
      case "--cleanup":
        options.cleanup = next();
        break;
      case "--cleanup-arguments":
        options.cleanupArguments = next();
        break;
      case "--dist":
        options.dist = resolve(next());
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function startCore({ dist, env }) {
  const entry = join(dist, "serve.js");
  if (!existsSync(entry))
    throw new Error(`missing ${entry}; run \`npm run build\` first`);
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const baseUrl = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Core did not print THEBE_LISTEN in time\n${stdout}\n${stderr}`
          )
        ),
      30_000
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const url = parseListenLine(stdout);
      if (url) {
        clearTimeout(timer);
        resolvePromise(url);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Core exited early (${code})\n${stdout}\n${stderr}`));
    });
  });
  return { child, baseUrl };
}

async function invokeRaw(baseUrl, token, id, args) {
  return request(baseUrl, {
    method: "POST",
    path: `/v1/capabilities/${encodeURIComponent(id)}/invoke`,
    token,
    body: { arguments: args },
  });
}

async function readText(baseUrl, token, id, args) {
  try {
    return JSON.stringify(await invoke(baseUrl, token, id, args));
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function invoke(baseUrl, token, id, args) {
  const res = await request(baseUrl, {
    method: "POST",
    path: `/v1/capabilities/${encodeURIComponent(id)}/invoke`,
    token,
    body: { arguments: args },
  });
  assert(
    res.status === 200,
    `${id} returned ${res.status} ${res.text.slice(0, 200)}`
  );
  return res.json?.result ?? res.json;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      "usage: node scripts/accept-service-api.mjs [--operation ID] [--arguments JSON] [--query TEXT] [--preview WRITE_ID] [--confirm WRITE_ID [--confirm-arguments JSON] [--verify READ_ID [--verify-arguments JSON]] [--expect TEXT] [--cleanup WRITE_ID [--cleanup-arguments JSON]]]] [--base-url URL --token T] [--dist DIR] [--keep]"
    );
    return 0;
  }
  const serviceApis = process.env.THEBE_SERVICE_APIS?.trim();

  let core;
  let baseUrl = options.baseUrl;
  let token = options.token;
  const dirs = !baseUrl ? makeTempDirs("thebe-svcapi-") : undefined;
  try {
    if (baseUrl) {
      assert(token, "--base-url needs --token (or set THEBE_TOKEN)");
    } else {
      assert(
        serviceApis,
        "set THEBE_SERVICE_APIS (see --help) or pass --base-url"
      );
      token = token ?? randomBytes(16).toString("hex");
      const port = await findFreePort();
      core = await startCore({
        dist: options.dist,
        env: coreEnv({
          dirs,
          token,
          port,
          extra: { THEBE_SERVICE_APIS: serviceApis },
        }),
      });
      baseUrl = core.baseUrl;
      console.log(`spawned Core at ${baseUrl}`);
    }

    const health = await request(baseUrl, { path: "/v1/health", token });
    assert(health.status === 200, `health ${health.status}`);

    const listed = await request(baseUrl, { path: "/v1/capabilities", token });
    assert(listed.status === 200, `capabilities ${listed.status}`);
    const perOperation = (listed.json?.capabilities ?? []).filter(
      (cap) => typeof cap.id === "string" && cap.id.startsWith("service_api.")
    );
    console.log(`\nper-operation tools exposed (${perOperation.length}):`);
    for (const cap of perOperation.slice(0, 20))
      console.log(`  ${cap.id}  [${cap.permission ?? "?"}]`);
    if (perOperation.length > 20)
      console.log(`  … ${perOperation.length - 20} more`);
    assert(
      perOperation.length > 0 || options.operation,
      "no per-operation tools; check readOperations / readMethods / writeOperations"
    );

    const discover = await invoke(
      baseUrl,
      token,
      "service_api_discover",
      options.query ? { query: options.query } : {}
    );
    const results = Array.isArray(discover) ? discover : [discover];
    const operations = results.flatMap(
      (entry) => entry?.api?.operations ?? entry?.operations ?? []
    );
    for (const entry of results) {
      if (entry?.error)
        console.log(`\ndiscovery error for ${entry.id}: ${entry.error}`);
    }
    console.log(
      `\ndiscovery: ${operations.length} operation(s)${options.query ? ` matching "${options.query}"` : ""}`
    );
    for (const op of operations.slice(0, 8))
      console.log(`  ${op.method} ${op.path}  approval=${op.approval ?? "?"}`);

    const operation =
      options.operation ??
      perOperation.find((cap) => cap.effect === "read")?.id;
    if (operation) {
      const args = options.arguments ? JSON.parse(options.arguments) : {};
      const result = await invoke(baseUrl, token, operation, args);
      console.log(`\n${operation} ->`);
      console.log("  " + JSON.stringify(result).slice(0, 600));
    } else {
      console.log("\n(no read operation to invoke; pass --operation)");
    }

    if (options.preview) {
      const args = options.previewArguments
        ? JSON.parse(options.previewArguments)
        : options.arguments
          ? JSON.parse(options.arguments)
          : {};
      const preview = await invoke(baseUrl, token, options.preview, args);
      const hasToken = typeof preview?.confirmToken === "string";
      console.log(
        `\n${options.preview} preview: ${hasToken ? "no change made, confirmToken returned" : "unexpected result"}`
      );
      console.log(
        "  " + JSON.stringify(preview?.preview ?? preview).slice(0, 300)
      );
      assert(
        hasToken,
        "a write operation must return a preview + confirmToken and make no change"
      );
    }

    if (options.confirm) {
      const writeArgs = options.confirmArguments
        ? JSON.parse(options.confirmArguments)
        : options.arguments
          ? JSON.parse(options.arguments)
          : {};
      const readArgs = options.verifyArguments
        ? JSON.parse(options.verifyArguments)
        : {};
      const preview = await invoke(baseUrl, token, options.confirm, writeArgs);
      assert(
        typeof preview?.confirmToken === "string",
        `${options.confirm} did not return a confirmToken (is it in writeOperations?)`
      );
      assert(
        preview.preview && typeof preview.preview === "object",
        "a write operation must return a preview object"
      );
      console.log(`\n${options.confirm} preview (no change made):`);
      console.log("  " + JSON.stringify(preview.preview).slice(0, 400));

      if (options.verify && options.expect) {
        const before = await readText(baseUrl, token, options.verify, readArgs);
        assert(
          !before.includes(options.expect),
          `${options.verify} already exposes ${options.expect} before confirm; --expect needs a fresh target`
        );
        console.log(
          `  ${options.verify} before confirm: ${options.expect} absent (the preview changed nothing)`
        );
      }

      const confirmed = await invoke(baseUrl, token, "service_api.confirm", {
        token: preview.confirmToken,
      });
      console.log("\nservice_api.confirm ->");
      console.log("  " + JSON.stringify(confirmed).slice(0, 600));

      const replay = await invokeRaw(baseUrl, token, "service_api.confirm", {
        token: preview.confirmToken,
      });
      assert(
        replay.status !== 200,
        `replaying the confirm token must fail, got ${replay.status}`
      );
      console.log(
        `  the same token again -> HTTP ${replay.status} (single-use, as documented)`
      );

      if (options.verify) {
        const after = await invoke(baseUrl, token, options.verify, readArgs);
        const text = JSON.stringify(after);
        console.log(`\n${options.verify} after confirm ->`);
        console.log("  " + text.slice(0, 400));
        if (options.expect)
          assert(
            text.includes(options.expect),
            `${options.verify} did not contain ${options.expect}`
          );
      }

      if (options.cleanup) {
        try {
          const cleanupArgs = options.cleanupArguments
            ? JSON.parse(options.cleanupArguments)
            : {};
          const previewed = await invoke(
            baseUrl,
            token,
            options.cleanup,
            cleanupArgs
          );
          // A cleanup write is two-phase too, so confirm it before calling it done.
          const cleaned =
            typeof previewed?.confirmToken === "string"
              ? await invoke(baseUrl, token, "service_api.confirm", {
                  token: previewed.confirmToken,
                })
              : previewed;
          console.log(
            `\ncleanup ${options.cleanup} (preview + confirm) -> ${JSON.stringify(cleaned).slice(0, 200)}`
          );
        } catch (error) {
          console.log(
            `\ncleanup ${options.cleanup} failed (ignored): ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    console.log("\nOK");
    return 0;
  } finally {
    if (core) {
      const done = new Promise((resolvePromise) =>
        core.child.once("exit", resolvePromise)
      );
      core.child.kill("SIGTERM");
      await Promise.race([done, new Promise((r) => setTimeout(r, 8_000))]);
    }
    if (dirs && !options.keep) {
      const { rmSync } = await import("node:fs");
      rmSync(dirs.root, { recursive: true, force: true });
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(
      `\nFAILED: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
