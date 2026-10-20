import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  buildDownloadStatesContract,
  DOWNLOAD_STATE_CASES,
  DOWNLOAD_STATES_CONTRACT_PATH,
} from "../../agent/capabilities/download-states-contract.ts";
import { Aria2DownloadProvider } from "./aria2-downloads.ts";
import { QBittorrentDownloadProvider } from "./qbittorrent-downloads.ts";

const contractFile = new URL(
  `../../../${DOWNLOAD_STATES_CONTRACT_PATH}`,
  import.meta.url
);
const render = () =>
  `${JSON.stringify(buildDownloadStatesContract(), null, 2)}\n`;

const hash = "c".repeat(40);

function qbittorrentReading(state: string, progress: number) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("auth/login"))
      return new Response("Ok.", {
        headers: { "set-cookie": "SID=s; Path=/" },
      });
    return Response.json([{ hash, name: "Show", state, progress }]);
  });
  return new QBittorrentDownloadProvider({
    baseUrl: "https://q.example",
    username: "u",
    password: "p",
    fetch: fetchImpl,
  });
}

function aria2Reading(status: string, progress: number) {
  const totalLength = "1000";
  const row = {
    gid: "0123456789abcdef",
    status,
    totalLength,
    completedLength: String(Math.round(progress * 1000)),
    downloadSpeed: "0",
    files: [{ path: "/dl/Show.mkv" }],
  };
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    const result =
      method === "aria2.tellActive" && status === "active"
        ? [row]
        : method === "aria2.tellWaiting" &&
            (status === "waiting" || status === "paused")
          ? [row]
          : method === "aria2.tellStopped" &&
              ["complete", "error", "removed"].includes(status)
            ? [row]
            : [];
    return Response.json({ jsonrpc: "2.0", id: "1", result });
  });
  return new Aria2DownloadProvider({
    baseUrl: "https://a.example",
    secret: "s",
    fetch: fetchImpl,
  });
}

describe("Download states contract", () => {
  it("matches the checked-in file the App syncs (THEBE_UPDATE_CONTRACT=1 rewrites it)", async () => {
    if (process.env.THEBE_UPDATE_CONTRACT === "1")
      await writeFile(contractFile, render());
    expect(await readFile(contractFile, "utf8")).toBe(render());
  });

  it.each(DOWNLOAD_STATE_CASES.qbittorrent)(
    "qBittorrent $state at $progress is $phase",
    async ({ state, progress, phase, badges, capabilities }) => {
      const [item] = await qbittorrentReading(state, progress).list({});
      expect(item).toMatchObject({
        engine: "qbittorrent",
        id: hash,
        phase,
        badges,
        capabilities,
      });
    }
  );

  it.each(DOWNLOAD_STATE_CASES.aria2)(
    "aria2 $state is $phase",
    async ({ state, progress, phase, badges, capabilities }) => {
      const [item] = await aria2Reading(state, progress).list({});
      expect(item).toMatchObject({
        engine: "aria2",
        id: "0123456789abcdef",
        phase,
        badges,
        capabilities,
      });
    }
  );
});
