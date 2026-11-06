import type {
  ContainerDetail,
  ContainerInfoProvider,
  ContainerSummary,
  HostStatusSummary,
} from "../capabilities/containers.ts";
import { redactEnv, redactLogs } from "../security/redaction.ts";

export function createToolLayer(provider: ContainerInfoProvider) {
  return {
    async invoke(
      name: string,
      args: { id?: string; tail?: number } = {}
    ): Promise<
      ContainerSummary[] | ContainerDetail | HostStatusSummary | string
    > {
      if (name === "container_list") {
        return provider.listContainers();
      }
      if (name === "container_inspect") {
        const detail = await provider.inspectContainer(args.id ?? "");
        return {
          ...detail,
          config: {
            ...detail.config,
            env: detail.config.env ? redactEnv(detail.config.env) : undefined,
          },
        };
      }
      if (name === "container_logs") {
        const raw = await provider.getContainerLogs(args.id ?? "", args.tail);
        return redactLogs(raw, args.tail);
      }
      if (name === "container_status_summary") {
        return provider.getStatusSummary();
      }
      throw new Error(`unknown tool: ${name}`);
    },
  };
}
