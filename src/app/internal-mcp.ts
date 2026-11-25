import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const MAX_BRIDGE_BODY_BYTES = 10 * 1024 * 1024;

export type InternalMcpBridge = {
  url: string;
  close(): Promise<void>;
};

type RequestHandler = {
  handle(request: Request): Promise<Response>;
};

/**
 * A loopback-only HTTP face over the same Core request handler. DSH's MCP
 * client can therefore call the current Core process even when the entry point
 * is the TUI, one-shot CLI, or `thebe-mcp` instead of `dist/serve.js`.
 */
export async function startInternalMcpBridge(options: {
  handler: RequestHandler;
}): Promise<InternalMcpBridge> {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BRIDGE_BODY_BYTES) {
          outgoing.writeHead(413, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ error: "request_too_large" }));
          return;
        }
        chunks.push(buffer);
      }
      const address = server.address() as AddressInfo;
      const request = new Request(
        `http://127.0.0.1:${address.port}${incoming.url ?? "/"}`,
        {
          method: incoming.method,
          headers: Object.entries(incoming.headers).flatMap(([key, value]) =>
            value === undefined
              ? []
              : Array.isArray(value)
                ? value.map((item) => [key, item] as [string, string])
                : [[key, value] as [string, string]]
          ),
          ...(["GET", "HEAD"].includes(incoming.method ?? "GET")
            ? {}
            : { body: Buffer.concat(chunks) }),
        }
      );
      const response = await options.handler.handle(request);
      const headers = Object.fromEntries(
        [...response.headers].filter(
          ([key]) =>
            !["connection", "content-length", "transfer-encoding"].includes(
              key.toLowerCase()
            )
        )
      );
      outgoing.writeHead(response.status, headers);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
