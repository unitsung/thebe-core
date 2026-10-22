import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createContainerTools } from "../tools/container-tools.ts";
import { createPipelineTools } from "../tools/pipeline-tools.ts";
import { createPolicyEngine } from "../security/policy/policy-engine.ts";
import type { ContainerInfoProvider } from "./containers.ts";
import {
  buildListingContract,
  CONTAINER_LIST_EXAMPLE,
  DOWNLOAD_LIST_EXAMPLE,
  FILES_LIST_EXAMPLE,
  LISTING_CONTRACT_PATH,
} from "./listing-contract.ts";

const contractFile = new URL(
  `../../../${LISTING_CONTRACT_PATH}`,
  import.meta.url
);
const render = () => `${JSON.stringify(buildListingContract(), null, 2)}\n`;

describe("Listing result contract", () => {
  it("matches the checked-in contract file (THEBE_UPDATE_CONTRACT=1 rewrites it)", async () => {
    if (process.env.THEBE_UPDATE_CONTRACT === "1")
      await writeFile(contractFile, render());
    expect(await readFile(contractFile, "utf8")).toBe(render());
  });

  it("keeps the examples identical to what the tools emit", async () => {
    const policy = createPolicyEngine({
      now: () => new Date(),
      allowedToolNames: ["container.list", "download.list", "files.list"],
    });
    const containers = createContainerTools(
      {
        listContainers: async () => CONTAINER_LIST_EXAMPLE,
      } as unknown as ContainerInfoProvider,
      { policy, callerId: "contract" }
    );
    const pipeline = createPipelineTools(
      {
        downloads: {
          service: "qbittorrent",
          list: async () => DOWNLOAD_LIST_EXAMPLE.downloads,
        },
        files: { service: "openlist", list: async () => FILES_LIST_EXAMPLE },
      } as never,
      { policy, callerId: "contract" }
    );
    const call = async (
      tools: Array<{ name: string; execute: Function }>,
      name: string,
      args: unknown
    ) =>
      JSON.parse(
        (await tools.find((tool) => tool.name === name)!.execute("c", args))
          .content[0].text
      );

    expect(await call(containers, "container.list", {})).toEqual(
      CONTAINER_LIST_EXAMPLE
    );
    expect(await call(pipeline, "download.list", {})).toEqual(
      DOWNLOAD_LIST_EXAMPLE
    );
    expect(await call(pipeline, "files.list", { path: "/media" })).toEqual(
      FILES_LIST_EXAMPLE
    );
  });
});
