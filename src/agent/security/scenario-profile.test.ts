import { describe, expect, it } from "vitest";
import {
  getScenarioProfile,
  listScenarioProfiles,
  resolveScenarioSettings,
  scenarioFromEnv,
  SCENARIO_PROFILES,
  type ScenarioName,
} from "./scenario-profile.ts";

describe("scenario profiles", () => {
  it("keeps the four original profiles with their descriptions", () => {
    const names = listScenarioProfiles().map((profile) => profile.name);
    expect(names).toEqual([
      "nas-strict",
      "homelab-host",
      "microvm-sandbox",
      "yolo-guarded",
    ]);
    for (const profile of listScenarioProfiles()) {
      expect(profile.description.length).toBeGreaterThan(20);
    }
  });

  it("keeps NAS storage protection in every profile", () => {
    for (const profile of listScenarioProfiles()) {
      expect(profile.dockerGuard.blockVolumePrune).toBe(true);
      expect(profile.commandGuard.enabled).toBe(true);
    }
  });

  it("defaults to nas-strict and merges nested overrides", () => {
    expect(getScenarioProfile().name).toBe("nas-strict");
    const merged = getScenarioProfile("homelab-host", {
      sandbox: { mode: "bwrap" },
    });
    expect(merged.sandbox.mode).toBe("bwrap");
    // untouched nested fields survive the merge
    expect(merged.sandbox.isolateNetwork).toBe(false);
    expect(merged.workspace.allowGlobalEscapes).toBe(true);
  });
});

describe("resolveScenarioSettings", () => {
  it("returns pre-scenario defaults without THEBE_SCENARIO", () => {
    const settings = resolveScenarioSettings(undefined, {});
    expect(settings.scenario).toBeUndefined();
    expect(settings.commandGuard).toBe(true);
    expect(settings.sandboxMode).toBe("off");
    expect(settings.sandboxNetwork).toBe(true);
    expect(settings.workspaceEscapes).toBe(false);
  });

  it("applies the scenario preset to sandbox, escapes and docker guard", () => {
    const microvm = resolveScenarioSettings("microvm-sandbox", {});
    expect(microvm.sandboxMode).toBe("gondolin");
    expect(microvm.sandboxNetwork).toBe(false);

    const homelab = resolveScenarioSettings("homelab-host", {});
    expect(homelab.workspaceEscapes).toBe(true);
    expect(homelab.dockerGuard.blockPrivileged).toBe(false);
    expect(homelab.dockerGuard.blockVolumePrune).toBe(true);
  });

  it("lets explicit environment variables win over the preset", () => {
    const settings = resolveScenarioSettings("nas-strict", {
      THEBE_SANDBOX: "off",
      THEBE_SANDBOX_NETWORK: "deny",
      THEBE_COMMAND_GUARD: "off",
      THEBE_ALLOW_WORKSPACE_ESCAPES: "true",
    });
    expect(settings.sandboxMode).toBe("off");
    expect(settings.sandboxNetwork).toBe(false);
    expect(settings.commandGuard).toBe(false);
    expect(settings.workspaceEscapes).toBe(true);
  });

  it("ignores unknown scenario names and sandbox modes", () => {
    expect(scenarioFromEnv({ THEBE_SCENARIO: "nope" })).toBeUndefined();
    expect(resolveScenarioSettings(undefined, { THEBE_SANDBOX: "firecracker" }).sandboxMode).toBe(
      "off",
    );
    expect(
      (Object.keys(SCENARIO_PROFILES) as ScenarioName[]).includes("nas-strict"),
    ).toBe(true);
  });
});
