import { createServer, type IncomingMessage, type Server } from "node:http";
import type { createThebeHttpHandler } from "./handler.ts";

export const MAX_HTTP_BODY_BYTES = 10 * 1024 * 1024;

export type ThebeListenOptions = {
  host?: string;
  port?: number;
};

export async function listenThebeHttp(
  app: ReturnType<typeof createThebeHttpHandler>,
  options: ThebeListenOptions = {},
): Promise<{ server: Server; url: string; bind: string }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const server = createServer((req, res) => {
    void handleNode(app, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const bound =
    address && typeof address === "object" ? address.port : port;
  const wildcard = host === "0.0.0.0" || host === "::";
  const urlHost = wildcard ? "127.0.0.1" : host;
  const bind = `${host}:${bound}`;
  return { server, url: `http://${urlHost}:${bound}`, bind };
}

async function handleNode(
  app: ReturnType<typeof createThebeHttpHandler>,
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  try {
    const request = await toRequest(req);
    const response = await app.handle(request);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    req.on("close", () => {
      void reader.cancel();
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        res.write(value);
      }
    }
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const statusHint =
      error && typeof error === "object" && "status" in error
        ? Number((error as { status: unknown }).status)
        : 500;
    const status =
      Number.isInteger(statusHint) && statusHint >= 400 && statusHint < 600
        ? statusHint
        : 500;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    req.destroy();
  }
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    }
  }
  const abort = new AbortController();
  req.on("close", () => {
    if (!abort.signal.aborted) {
      abort.abort();
    }
  });
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers, signal: abort.signal });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_HTTP_BODY_BYTES) {
      const error = new Error("Payload Too Large") as Error & { status: number };
      error.status = 413;
      throw error;
    }
    chunks.push(buf);
  }
  return new Request(url, {
    method,
    headers,
    body: Buffer.concat(chunks),
    signal: abort.signal,
  });
}
