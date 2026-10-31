import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJsonAgentSettingsStore } from "./store.ts";

function configPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "thebe-settings-store-"));
  return join(dir, "config.json");
}

describe("Agent settings store", () => {
  it("keeps keys it does not own when saving a setting", () => {
    const path = configPath();
    writeFileSync(
      path,
      JSON.stringify({
        providers: { openai: { baseUrl: "https://example.test/v1" } },
        theme: "dark",
        autoCompact: true,
      })
    );

    createJsonAgentSettingsStore(path).save({ autoCompact: false });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      providers: { openai: { baseUrl: "https://example.test/v1" } },
      theme: "dark",
      autoCompact: false,
    });
  });

  it("refuses to overwrite a config file it cannot parse", () => {
    const path = configPath();
    writeFileSync(path, '{"providers":');

    expect(() =>
      createJsonAgentSettingsStore(path).save({ autoCompact: false })
    ).toThrow(/Refusing to overwrite/);
    expect(readFileSync(path, "utf8")).toBe('{"providers":');
  });

  it("refuses to overwrite a config file it cannot read as a JSON object", () => {
    const path = configPath();
    writeFileSync(path, "[]");

    expect(() =>
      createJsonAgentSettingsStore(path).save({ autoCompact: false })
    ).toThrow(/Refusing to overwrite/);
    expect(readFileSync(path, "utf8")).toBe("[]");
  });

  it("still reads defaults from a damaged file without failing startup", () => {
    const path = configPath();
    writeFileSync(path, '{"providers":');

    expect(createJsonAgentSettingsStore(path).load()).toEqual({});
  });
});
