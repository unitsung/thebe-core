import type { Server } from "node:http";

/**
 * Quiesce then wait for `server.close` so in-flight HTTP requests can
 * finish. Callers own process.exit / force timers.
 */
export async function drainThebeHttpServer(
  server: Pick<Server, "close">,
  quiesce: () => Promise<void>,
): Promise<void> {
  await quiesce().catch(() => {});
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
