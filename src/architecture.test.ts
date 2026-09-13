import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = join(srcRoot, "agent", "runtime");
const adaptersRoot = join(srcRoot, "adapters");
const piAdapterRoot = join(adaptersRoot, "pi");
const interfacePath = join(agentRuntimeRoot, "interface.ts");
const deliveryRoot = join(srcRoot, "delivery");
const tuiRoot = join(deliveryRoot, "tui");
const tuiRenderingAdapter = join(tuiRoot, "rendering", "adapter.ts");
const deliveryRoots = ["cli", "http", "tui"].map((name) =>
  join(deliveryRoot, name),
);

const PI_CODING_AGENT = "@earendil-works/pi-coding-agent";
const PI_TUI = "@earendil-works/pi-tui";

describe("source architecture", () => {
  it("keeps retired security and provider paths absent", async () => {
    for (const path of [
      join(srcRoot, "providers"),
      join(srcRoot, "audit"),
      join(srcRoot, "policy", "policy-engine.ts"),
      join(srcRoot, "stream-guard"),
      join(srcRoot, "product", "wrap-tools.ts"),
      join(srcRoot, "agent", "wrap-tools.ts"),
      join(srcRoot, "tools", "redaction.ts"),
      join(srcRoot, "integrations"),
      join(srcRoot, "composition"),
      join(srcRoot, "config"),
      join(srcRoot, "security"),
      join(srcRoot, "tools"),
    ]) {
      await expectPathToBeAbsent(path);
    }

    const staleImports: string[] = [];
    for (const file of await collectAllTs(srcRoot)) {
      const text = await readFile(file, "utf8");
      for (const specifier of staticImportSpecifiers(text)) {
        if (
          specifier.endsWith("/providers/index.ts") ||
          (specifier.endsWith("/audit/audit-log.ts") &&
            !specifier.includes("/security/")) ||
          (specifier.endsWith("/policy/policy-engine.ts") &&
            !specifier.includes("/security/")) ||
          specifier.endsWith("/stream-guard/index.ts") ||
          specifier.endsWith("/tools/redaction.ts") ||
          specifier.endsWith("/agent/wrap-tools.ts")
        ) {
          staleImports.push(`${relative(srcRoot, file)} -> ${specifier}`);
        }
      }
    }

    expect(staleImports).toEqual([]);
  });

  it("removes obsolete compatibility paths and imports", async () => {
    await expectPathToBeAbsent(join(srcRoot, "agent", "service.ts"));
    await expectPathToBeAbsent(join(srcRoot, "runtime"));

    const files = await collectAllTs(srcRoot);
    const staleImports: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const specifier of staticImportSpecifiers(text)) {
        if (
          specifier.endsWith("/agent/service.ts") ||
          specifier.endsWith("/runtime/types.ts")
        ) {
          staleImports.push(`${relative(srcRoot, file)} -> ${specifier}`);
        }
      }
    }

    expect(staleImports).toEqual([]);
  });

  it("keeps the Agent-owned runtime interface independent of delivery and adapters", async () => {
    const text = await readFile(interfacePath, "utf8");
    const imports = staticImportSpecifiers(text);

    expect(imports).toEqual([]);
    expect(text).not.toContain("src/agent");
    expect(text).not.toContain("src/delivery");
    expect(text).not.toContain(PI_CODING_AGENT);
    expect(text).not.toContain(PI_TUI);
  });

  it("keeps the Pi adapter independent of TUI implementation", async () => {
    const files = await collectProductionTs(piAdapterRoot);
    const knownFiles = new Set(await collectProductionTs(srcRoot));
    const leaks: string[] = [];

    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const specifier of staticImportSpecifiers(text)) {
        const target = resolveLocalImport(file, specifier, knownFiles);
        if (target && target.startsWith(tuiRoot + "/")) {
          leaks.push(`${relative(srcRoot, file)} -> ${relative(srcRoot, target)}`);
        }
      }
    }

    expect(leaks).toEqual([]);
  });

  it("keeps TUI imports out of the Pi adapter", async () => {
    const files = await collectProductionTs(tuiRoot);
    const knownFiles = new Set(await collectProductionTs(srcRoot));
    const leaks: string[] = [];

    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const specifier of staticImportSpecifiers(text)) {
        const target = resolveLocalImport(file, specifier, knownFiles);
        if (target && target.startsWith(piAdapterRoot + "/")) {
          leaks.push(`${relative(srcRoot, file)} -> ${relative(srcRoot, target)}`);
        }
      }
    }

    expect(leaks).toEqual([]);
  });

  it("keeps the coding-agent package out of delivery code while allowing pi-tui", async () => {
    const files = (
      await Promise.all(
        deliveryRoots.map((root) => collectAllTs(root)),
      )
    ).flat();
    const leaks: string[] = [];

    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (text.includes(PI_CODING_AGENT)) {
        leaks.push(relative(srcRoot, file));
      }
    }

    expect(leaks).toEqual([]);
    // pi-tui is the dedicated TUI rendering dependency; it is intentionally
    // distinct from the Pi coding-agent package wrapped by adapters/pi.
    expect(await readFile(tuiRenderingAdapter, "utf8")).toContain(PI_TUI);
  });

  it("keeps delivery code independent of concrete adapters", async () => {
    const files = (
      await Promise.all(deliveryRoots.map((root) => collectAllTs(root)))
    ).flat();
    const knownFiles = new Set(await collectAllTs(srcRoot));
    const leaks: string[] = [];

    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const specifier of staticImportSpecifiers(text)) {
        const target = resolveLocalImport(file, specifier, knownFiles);
        if (
          (target && target.startsWith(piAdapterRoot + "/")) ||
          (target && target.startsWith(adaptersRoot + "/"))
        ) {
          leaks.push(`${relative(srcRoot, file)} -> ${relative(srcRoot, target)}`);
        }
      }
    }

    expect(leaks).toEqual([]);
  });

  it("keeps concrete adapters out of the Agent core", async () => {
    const files = await collectProductionTs(join(srcRoot, "agent"));
    const knownFiles = new Set(await collectProductionTs(srcRoot));
    const leaks: string[] = [];

    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const specifier of staticImportSpecifiers(text)) {
        const target = resolveLocalImport(file, specifier, knownFiles);
        if (
          (target && target.startsWith(piAdapterRoot + "/")) ||
          (target && target.startsWith(adaptersRoot + "/"))
        ) {
          leaks.push(`${relative(srcRoot, file)} -> ${relative(srcRoot, target)}`);
        }
      }
    }

    expect(leaks).toEqual([]);
  });
});

function staticImportSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const pattern = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier) {
      specs.push(specifier);
    }
  }
  return specs;
}

function resolveLocalImport(
  source: string,
  specifier: string,
  knownFiles: Set<string>,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = resolve(dirname(source), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate));
}

async function collectProductionTs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      files.push(...(await collectProductionTs(path)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

async function collectAllTs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      files.push(...(await collectAllTs(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

async function expectPathToBeAbsent(path: string): Promise<void> {
  await expect(access(path).then(() => true, () => false)).resolves.toBe(false);
}
