export type ContainerState =
  | "running"
  | "exited"
  | "paused"
  | "dead"
  | "created"
  | "restarting";

export type ContainerSummary = {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  status: string;
  created: number;
};

export type ContainerDetail = {
  id: string;
  name: string;
  image: string;
  state: string;
  config: {
    env?: string[];
    cmd?: string[];
    labels?: Record<string, string>;
  };
  networkSettings?: {
    ports?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  };
};

export type HostStatusSummary = {
  totalContainers: number;
  runningContainers: number;
  pausedContainers: number;
  exitedContainers: number;
  lastUpdated: number;
};
