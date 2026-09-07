import { describe, expect, it } from "vitest";
import { createThebeHttpHandler } from "./handler.ts";
import { listenThebeHttp } from "./listen.ts";

describe("listenThebeHttp", () => {
  it("serves /v1/health on a bound port", async () => {
    const app = createThebeHttpHandler({
      version: "0.1.0",
    });
    const { server, url } = await listenThebeHttp(app, {
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const res = await fetch(`${url}/v1/health`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        ok: true,
        version: "0.1.0",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
