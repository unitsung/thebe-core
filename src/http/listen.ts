import { createServer, type IncomingMessage, type Server } from "node:http";
import type { createThebeHttpHandler } from "./handler.ts";

export type ThebeListenOptions = {
  host?: string;
  port?: number;
};

export async function listenThebeHttp(
  app: ReturnType<typeof createThebeHttpHandler>,
  options: ThebeListenOptions = {},
): Promise<{ server: Server; url: string }> {
  const host = options.host ?? "0.0.0.0";
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
  const urlHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return { server, url: `http://${urlHost}:${bound}` };
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
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
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
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Request(url, {
    method,
    headers,
    body: Buffer.concat(chunks),
  });
}
