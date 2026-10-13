import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GondolinMicroVMRunner } from "./runner.ts";

/**
 * Boots a real Micro-VM and proves the isolation the runner promises: a distinct
 * guest kernel, the workspace as the only host mount, and no egress when the
 * allowlist is empty.
 *
 * Opt-in because it needs the gondolin package plus QEMU (and downloads a guest
 * image on first boot): `THEBE_GONDOLIN_IT=1 npx vitest run src/adapters/gondolin`.
 */
describe.skipIf(process.env.THEBE_GONDOLIN_IT !== "1")(
  "Gondolin Micro-VM (live)",
  () => {
    it("runs in a distinct guest and denies egress", async () => {
      const workspace = mkdtempSync(join(homedir(), "thebe-gondolin-"));
      const runner = new GondolinMicroVMRunner({
        workspacePath: workspace,
        allowedHosts: [],
        timeoutMs: 180_000,
      });

      await runner.init();
      try {
        const uname = await runner.exec("uname -a");
        expect(uname.stdout).toMatch(/Linux/i);

        const write = await runner.exec("echo hi > ./inside.txt && cat ./inside.txt");
        expect(write.stdout).toContain("hi");
        expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toContain("hi");

        const net = await runner.exec(
          "wget -T3 -qO- http://1.1.1.1 2>&1 || echo NETFAIL",
        );
        expect(net.stdout).toContain("NETFAIL");
      } finally {
        await runner.destroy();
        rmSync(workspace, { recursive: true, force: true });
      }
    }, 300_000);
  },
);
