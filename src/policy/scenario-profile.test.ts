import { describe, expect, it } from "vitest";
import { getScenarioProfile, listScenarioProfiles, SCENARIO_PROFILES } from "./scenario-profile.ts";

describe("Scenario Profiles (Context-Aware Multi-Scenario Security)", () => {
  it("lists all scenario profiles", () => {
    const list = listScenarioProfiles();
    expect(list.length).toBe(4);
    expect(list.map((s) => s.name)).toEqual([
      "nas-strict",
      "homelab-host",
      "microvm-sandbox",
      "yolo-guarded",
    ]);
  });
  it("provides nas-strict profile with highest data protection", () => {
    const p = getScenarioProfile("nas-strict");
    expect(p.name).toBe("nas-strict");
    expect(p.evaluator.strictZfsRaidProtection).toBe(true);
    expect(p.evaluator.requireForYolo).toBe(true);
    expect(p.workspace.enforceConfinement).toBe(true);
    expect(p.workspace.allowGlobalEscapes).toBe(false);
    expect(p.sandbox.mode).toBe("bwrap");
    expect(p.sandbox.dropCapabilities).toBe(true);
    expect(p.dockerGuard.blockPrivilegedContainers).toBe(true);
    expect(p.dockerGuard.blockHostRootMounts).toBe(true);
    expect(p.dockerGuard.blockVolumePrune).toBe(true);
  });

  it("provides homelab-host profile for server maintenance", () => {
    const p = getScenarioProfile("homelab-host");
    expect(p.name).toBe("homelab-host");
    expect(p.workspace.allowGlobalEscapes).toBe(true); // allowed with human approval
    expect(p.sandbox.mode).toBe("workspace-jail");
    expect(p.dockerGuard.blockHostRootMounts).toBe(true);
  });

  it("provides microvm-sandbox profile with full hardware isolation", () => {
    const p = getScenarioProfile("microvm-sandbox");
    expect(p.name).toBe("microvm-sandbox");
    expect(p.sandbox.mode).toBe("gondolin");
    expect(p.sandbox.isolateNetwork).toBe(true);
    expect(p.workspace.allowHostInspectionReads).toBe(false);
  });

  it("supports customizing and overriding profile options", () => {
    const custom = getScenarioProfile("nas-strict", {
      sandbox: {
        mode: "gondolin",
        dropCapabilities: true,
        readOnlyHost: true,
        isolateNetwork: true,
      },
    });

    expect(custom.sandbox.mode).toBe("gondolin");
    expect(custom.evaluator.strictZfsRaidProtection).toBe(true); // inherited
  });
});
