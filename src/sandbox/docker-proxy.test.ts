import { describe, expect, it } from "vitest";
import { validateDockerApiRequest } from "./docker-proxy.ts";

describe("Docker API Security Proxy & Validator", () => {
  it("blocks container creation with Privileged=true", () => {
    const res = validateDockerApiRequest("POST", "/v1.43/containers/create", {
      Image: "alpine",
      HostConfig: { Privileged: true },
    });
    expect(res.allowed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.reason).toContain("Privileged container");
  });

  it("blocks container creation mounting host root /", () => {
    const res = validateDockerApiRequest("POST", "/containers/create", {
      Image: "ubuntu",
      HostConfig: { Binds: ["/:/host:ro"] },
    });
    expect(res.allowed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.reason).toContain("Direct host root");
  });

  it("blocks container creation mounting /var/run/docker.sock", () => {
    const res = validateDockerApiRequest("POST", "/v1.41/containers/create", {
      Image: "docker:dind",
      HostConfig: { Binds: ["/var/run/docker.sock:/var/run/docker.sock"] },
    });
    expect(res.allowed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.reason).toContain("docker.sock");
  });

  it("blocks container creation with SYS_ADMIN or ALL capabilities", () => {
    const res = validateDockerApiRequest("POST", "/containers/create", {
      Image: "alpine",
      HostConfig: { CapAdd: ["SYS_ADMIN"] },
    });
    expect(res.allowed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.reason).toContain("SYS_ADMIN");
  });

  it("blocks volume pruning requests", () => {
    const res = validateDockerApiRequest("POST", "/v1.43/volumes/prune");
    expect(res.allowed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.reason).toContain("Volume pruning is blocked");
  });

  it("allows standard, safe container creation and queries", () => {
    const create = validateDockerApiRequest("POST", "/containers/create", {
      Image: "nginx:alpine",
      HostConfig: {
        Binds: ["/volume1/docker/nginx/nginx.conf:/etc/nginx/nginx.conf:ro"],
      },
    });
    expect(create.allowed).toBe(true);

    const list = validateDockerApiRequest("GET", "/v1.43/containers/json");
    expect(list.allowed).toBe(true);
  });
});
