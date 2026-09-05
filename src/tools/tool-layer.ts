import type {
  ContainerDetail,
  ContainerInfoProvider,
  ContainerSummary,
  HostStatusSummary,
} from "../providers/index.ts";
import { redactEnv, redactLogs } from "./redaction.ts";

export function createToolLayer(provider: ContainerInfoProvider) {
  return {
    async invoke(
      name: string,
      args: { id?: string; tail?: number } = {},
    ): Promise<
      ContainerSummary[] | ContainerDetail | HostStatusSummary | string
    > {
      if (name === "container.list") {
        return provider.listContainers();
      }
      if (name === "container.inspect") {
        const detail = await provider.inspectContainer(args.id ?? "");
        return {
          ...detail,
          config: {
            ...detail.config,
            env: detail.config.env ? redactEnv(detail.config.env) : undefined,
          },
        };
      }
      if (name === "container.logs") {
        const raw = await provider.getContainerLogs(args.id ?? "", args.tail);
        return redactLogs(raw, args.tail);
      }
      if (name === "container.status_summary") {
        return provider.getStatusSummary();
      }
      throw new Error(`unknown tool: ${name}`);
    },
  };
}
