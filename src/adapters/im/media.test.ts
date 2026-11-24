import { describe, expect, it } from "vitest";
import {
  MediaDownloadLimitError,
  mediaTypeFromResponse,
  readBoundedResponseBody,
} from "./media.ts";

describe("IM media download bounds", () => {
  it("stops reading when a stream crosses the byte limit", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2, 3]));
          controller.enqueue(Uint8Array.from([4, 5, 6]));
          controller.close();
        },
      })
    );

    await expect(readBoundedResponseBody(response, 5)).rejects.toBeInstanceOf(
      MediaDownloadLimitError
    );
  });

  it("returns the exact bytes when they stay within the bound", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2]));
          controller.enqueue(Uint8Array.from([3]));
          controller.close();
        },
      })
    );

    await expect(readBoundedResponseBody(response, 3)).resolves.toEqual(
      Uint8Array.from([1, 2, 3])
    );
  });

  it("keeps a specific source MIME over a generic download response", () => {
    const response = new Response(null, {
      headers: { "content-type": "application/octet-stream" },
    });
    expect(mediaTypeFromResponse(response, "text/plain")).toBe("text/plain");
    expect(mediaTypeFromResponse(response, "application/json")).toBe(
      "application/json"
    );
  });
});
