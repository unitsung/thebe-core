import type {
  ContainerDetail,
  ContainerSummary,
  HostStatusSummary,
} from "./types.ts";

export interface ContainerInfoProvider {
  listContainers(): Promise<ContainerSummary[]>;
  inspectContainer(id: string): Promise<ContainerDetail>;
  getContainerLogs(id: string, tail?: number): Promise<string>;
  getStatusSummary(): Promise<HostStatusSummary>;
}
