import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  coreEnv,
  main,
  makeTempDirs,
  parseArgs,
  parseListenLine,
  requestOptions,
} from "./smoke.mjs";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("smoke helpers", () => {
  it("parses the documented flags and defaults", () => {
    const defaults = parseArgs([]);
    expect(defaults).toMatchObject({
      baseUrl: undefined,
      token: undefined,
      port: undefined,
      dist: resolve(coreRoot, "dist"),
      keep: false,
      write: false,
      timeoutMs: 30_000,
    });

    expect(
      parseArgs([
        "--base-url",
        "https://thebe.example.ts.net",
        "--token",
        "secret",
        "--port",
        "8899",
        "--keep",
        "--write",
        "--timeout-ms",
        "5000",
      ]),
    ).toMatchObject({
      baseUrl: "https://thebe.example.ts.net",
      token: "secret",
      port: 8899,
      keep: true,
      write: true,
      timeoutMs: 5000,
    });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("finds the listen URL in serve output", () => {
    expect(
      parseListenLine("THEBE_LISTEN http://127.0.0.1:8799 (0.1.0) bind=127.0.0.1:8799\n"),
    ).toBe("http://127.0.0.1:8799");
    expect(parseListenLine("boot noise only")).toBeUndefined();
  });

  it("keeps the help path side effect free", async () => {
    await expect(main(["--help"])).resolves.toBe(0);
  });

  it("builds an authorized request with a Host override and JSON body", () => {
    const { options, payload, protocol } = requestOptions("http://127.0.0.1:8787", {
      method: "PATCH",
      path: "/v1/settings/agent?x=1",
      token: "secret",
      hostHeader: "rebind.evil.example",
      body: { autoCompact: false },
    });

    expect(protocol).toBe("http:");
    expect(options.method).toBe("PATCH");
    expect(options.host).toBe("127.0.0.1");
    expect(options.port).toBe("8787");
    expect(options.path).toBe("/v1/settings/agent?x=1");
    expect(options.headers["X-Thebe-Token"]).toBe("secret");
    expect(options.headers.Host).toBe("rebind.evil.example");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["Content-Length"]).toBe(Buffer.byteLength(payload));
    expect(JSON.parse(payload)).toEqual({ autoCompact: false });
  });

  it("selects https for a TLS deployment and omits the token when absent", () => {
    const { protocol, transport, options } = requestOptions("https://thebe.example.ts.net", {
      path: "/v1/health",
    });
    expect(protocol).toBe("https:");
    expect(typeof transport.request).toBe("function");
    expect(options.port).toBeUndefined();
    expect(options.headers).toEqual({});
  });

  it("creates the throwaway data directories and cleans them up", () => {
    const dirs = makeTempDirs("thebe-smoke-test-");
    try {
      for (const path of Object.values(dirs)) {
        expect(path).toContain("thebe-smoke-test-");
      }
      expect(dirs.config).toContain("config");
      expect(dirs.store).toContain("store");
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("builds a production environment for the spawned Core", () => {
    const dirs = makeTempDirs("thebe-smoke-test-");
    try {
      const env = coreEnv({ dirs, token: "secret", port: 8899, allowedHosts: "thebe.local" });
      expect(env).toMatchObject({
        NODE_ENV: "production",
        THEBE_HOST: "127.0.0.1",
        THEBE_PORT: "8899",
        THEBE_TOKEN: "secret",
        THEBE_ALLOWED_HOSTS: "thebe.local",
        THEBE_CONFIG_DIR: dirs.config,
        THEBE_AGENT_DIR: dirs.agent,
        THEBE_AGENT_STORE_DIR: dirs.store,
        THEBE_WORKSPACE_DIR: dirs.workspace,
        THEBE_OUTPUT_DIR: dirs.outputs,
        HOME: dirs.home,
      });
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});
