import { describe, expect, it } from "vitest";
import { inspectDockerCommandSafety } from "./docker-guard.ts";

describe("Docker Security Guard (Container Isolation Protection)", () => {
  it("strictly blocks privileged containers mounting host root", () => {
    const dangerous = [
      "docker run --privileged -v /:/host alpine",
      "podman run --privileged --volume /:/host ubuntu sh",
      "docker run -v /root:/root --privileged debian",
      "docker run --privileged -v /volume1:/volume1 alpine",
    ];

    for (const cmd of dangerous) {
      const res = inspectDockerCommandSafety(cmd);
      expect(res.allowed).toBe(false);
      expect(res.risk).toBe("critical");
      expect(res.requiresHumanConfirmation).toBe(false); // strictly blocked
      expect(res.reason).toContain("Container breakout attempt");
    }
  });

  it("strictly blocks raw host root mount without privileged flag", () => {
    const res = inspectDockerCommandSafety("docker run -v /:/host alpine");
    expect(res.allowed).toBe(false);
    expect(res.risk).toBe("critical");
    expect(res.reason).toContain("Direct host root (/) bind mount");
  });

  it("downgrades privileged mode to human confirmation", () => {
    const res = inspectDockerCommandSafety("docker run --privileged nginx");
    expect(res.allowed).toBe(false);
    expect(res.risk).toBe("dangerous");
    expect(res.requiresHumanConfirmation).toBe(true);
    expect(res.reason).toContain("--privileged grants all Linux kernel capabilities");
  });

  it("downgrades docker.sock mounting inside container to human confirmation", () => {
    const res = inspectDockerCommandSafety("docker run -v /var/run/docker.sock:/var/run/docker.sock traefik");
    expect(res.allowed).toBe(false);
    expect(res.risk).toBe("dangerous");
    expect(res.requiresHumanConfirmation).toBe(true);
    expect(res.reason).toContain("docker.sock");
  });

  it("downgrades volume prune to human confirmation", () => {
    const res = inspectDockerCommandSafety("docker volume prune -f");
    expect(res.allowed).toBe(false);
    expect(res.risk).toBe("dangerous");
    expect(res.requiresHumanConfirmation).toBe(true);
    expect(res.reason).toContain("volume pruning");
  });

  it("allows safe inspection commands", () => {
    const safe = [
      "docker ps",
      "docker inspect web",
      "docker logs --tail 100 app",
      "docker images",
    ];

    for (const cmd of safe) {
      const res = inspectDockerCommandSafety(cmd);
      expect(res.allowed).toBe(true);
      expect(res.risk).toBe("safe");
      expect(res.requiresHumanConfirmation).toBe(false);
    }
  });
});
