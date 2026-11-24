export class MediaDownloadLimitError extends Error {
  constructor() {
    super("media response exceeds its byte limit");
    this.name = "MediaDownloadLimitError";
  }
}

/** Reads a remote media response without trusting Content-Length or buffering past the bound. */
export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new MediaDownloadLimitError();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new MediaDownloadLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
