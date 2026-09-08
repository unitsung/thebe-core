import { describe, expect, it, vi } from "vitest";
import {
  SearchableModelPicker,
  SearchableProviderPicker,
  attachSearchableModelPicker,
  attachSearchableProviderPicker,
} from "./model-picker.ts";
import type { RuntimeModel, RuntimeProvider } from "../runtime/types.ts";
import { TuiMainScreen, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { createFakeRuntime } from "../runtime/fake-runtime.ts";
import { createThebeProduct } from "../product/service.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";

class MemoryTerminal implements Terminal {
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  get columns(): number {
    return 80;
  }
  get rows(): number {
    return 24;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

const mockModels: RuntimeModel[] = [
  {
    providerId: "opencode",
    modelId: "muse-spark-1.3-free",
    displayName: "Muse Spark 1.3 Free",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    supportsThinking: true,
    available: true,
  },
  {
    providerId: "anthropic",
    modelId: "claude-3-5-sonnet",
    displayName: "Claude 3.5 Sonnet",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsThinking: true,
    available: true,
  },
  {
    providerId: "openai",
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsThinking: false,
    available: true,
  },
];

const mockProviders: RuntimeProvider[] = [
  {
    id: "opencode",
    displayName: "OpenCode AI",
    authMethods: ["apiKey"],
    authStatus: "connected",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    authMethods: ["apiKey"],
    authStatus: "connected",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    authMethods: ["apiKey"],
    authStatus: "missing",
  },
];

const stubContainerProvider: ContainerInfoProvider = {
  async listContainers() {
    return [];
  },
  async inspectContainer() {
    throw new Error("unused");
  },
  async getContainerLogs() {
    throw new Error("unused");
  },
  async getStatusSummary() {
    return {
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 0,
    };
  },
};

describe("SearchableModelPicker", () => {
  it("initializes and renders correctly with borders and tags", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new SearchableModelPicker({
      models: mockModels,
      currentModel: "opencode/muse-spark-1.3-free",
      onSelect,
      onCancel,
    });

    const lines = picker.render(80).join("\n");
    expect(lines).toContain("Model Selector");
    expect(lines).toContain("Search:");
    expect(lines).toContain("Provider:");
    expect(lines).toContain("muse-spark-1.3-free");
    expect(lines).toContain("[opencode]");
    expect(lines).toContain("[reasoning]");
    expect(lines).toContain("1.0M ctx");
    expect(lines).toContain("Selected Model Details");
    expect(lines).toContain("Enter");
    expect(lines).toContain("Tab");
  });

  it("filters models in real time as characters are typed", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new SearchableModelPicker({
      models: mockModels,
      onSelect,
      onCancel,
    });

    // Type "spark"
    for (const char of "spark") {
      picker.handleInput(char);
    }

    const lines = picker.render(80).join("\n");
    expect(lines).toContain("muse-spark-1.3-free");
    expect(lines).not.toContain("claude-3-5-sonnet");
    expect(lines).not.toContain("gpt-4o");

    // Press Enter to confirm
    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "muse-spark-1.3-free" }),
    );
  });

  it("cycles provider tabs using Tab and Shift+Tab", () => {
    const picker = new SearchableModelPicker({
      models: mockModels,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    // Initial provider is "all"
    let lines = picker.render(80).join("\n");
    expect(lines).toContain("muse-spark-1.3-free");
    expect(lines).toContain("claude-3-5-sonnet");

    // Press Tab: switch to first provider (anthropic)
    picker.handleInput("\t");
    lines = picker.render(80).join("\n");
    expect(lines).toContain("claude-3-5-sonnet");
    expect(lines).not.toContain("muse-spark-1.3-free");

    // Press Tab again: switch to openai
    picker.handleInput("\t");
    lines = picker.render(80).join("\n");
    expect(lines).toContain("gpt-4o");
    expect(lines).not.toContain("claude-3-5-sonnet");

    // Press Tab again: switch to opencode
    picker.handleInput("\t");
    lines = picker.render(80).join("\n");
    expect(lines).toContain("muse-spark-1.3-free");
    expect(lines).not.toContain("claude-3-5-sonnet");

    // Press Shift+Tab: switch backwards to openai
    picker.handleInput("\x1b[Z");
    lines = picker.render(80).join("\n");
    expect(lines).toContain("gpt-4o");
    expect(lines).not.toContain("muse-spark-1.3-free");
  });

  it("navigates with Up and Down arrows and wraps around", () => {
    const onSelect = vi.fn();
    const picker = new SearchableModelPicker({
      models: mockModels,
      onSelect,
      onCancel: vi.fn(),
    });

    // Initially selectedIndex is 0. Arrow down moves to index 1.
    picker.handleInput("\x1b[B"); // down
    // Arrow down moves to index 2
    picker.handleInput("\x1b[B"); // down
    // Arrow down wraps to 0
    picker.handleInput("\x1b[B"); // down

    // Arrow up wraps to last item (index 2)
    picker.handleInput("\x1b[A"); // up
    picker.handleInput("\r"); // enter

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "openai" in mockModels[2]! ? "gpt-4o" : mockModels[2]!.modelId }),
    );
  });

  it("handles cancellation via Escape key", () => {
    const onCancel = vi.fn();
    const picker = new SearchableModelPicker({
      models: mockModels,
      onSelect: vi.fn(),
      onCancel,
    });

    picker.handleInput("\x1b"); // escape
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("accepts pre-filled initial query and initial provider", () => {
    const picker = new SearchableModelPicker({
      models: mockModels,
      initialQuery: "claude",
      initialProvider: "anthropic",
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = picker.render(80).join("\n");
    expect(lines).toContain("claude-3-5-sonnet");
    expect(lines).not.toContain("muse-spark-1.3-free");
  });
});

describe("SearchableProviderPicker", () => {
  it("renders providers list with status bullets and model counts", () => {
    const modelCounts = new Map([
      ["opencode", 2],
      ["anthropic", 5],
      ["openai", 8],
    ]);
    const picker = new SearchableProviderPicker({
      providers: mockProviders,
      modelCounts,
      currentProvider: "opencode",
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = picker.render(80).join("\n");
    expect(lines).toContain("Provider Selector");
    expect(lines).toContain("OpenCode AI");
    expect(lines).toContain("(2 models)");
    expect(lines).toContain("connected");
    expect(lines).toContain("Anthropic");
    expect(lines).toContain("OpenAI");
    expect(lines).toContain("missing key");
    expect(lines).toContain("Provider Details");
  });

  it("filters providers and selects on enter", () => {
    const onSelect = vi.fn();
    const modelCounts = new Map([["opencode", 2]]);
    const picker = new SearchableProviderPicker({
      providers: mockProviders,
      modelCounts,
      onSelect,
      onCancel: vi.fn(),
    });

    for (const char of "open") {
      picker.handleInput(char);
    }

    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "opencode" }),
    );
  });
});

describe("attachSearchableModelPicker & attachSearchableProviderPicker helpers", () => {
  it("attaches model picker to TUI, handles selection, and unmounts cleanly", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: stubContainerProvider,
    });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());

    const promise = attachSearchableModelPicker(tui, {
      product,
      currentModel: "fake/fake-1",
    });

    // Wait for picker to mount
    await new Promise((r) => setTimeout(r, 20));
    expect(
      tui.children.some((c) => c instanceof SearchableModelPicker),
    ).toBe(true);

    const picker = tui.children.find(
      (c) => c instanceof SearchableModelPicker,
    ) as SearchableModelPicker;
    // Press enter to select current highlighted item
    picker.handleInput("\r");

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result?.providerId).toBeDefined();
    // After resolution, picker is removed from tui children
    expect(
      tui.children.some((c) => c instanceof SearchableModelPicker),
    ).toBe(false);
  });

  it("attaches provider picker to TUI, handles selection, and unmounts cleanly", async () => {
    const fake = createFakeRuntime();
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider: stubContainerProvider,
    });
    const tui: TUI = new TuiMainScreen(new MemoryTerminal());

    const promise = attachSearchableProviderPicker(tui, {
      product,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(
      tui.children.some((c) => c instanceof SearchableProviderPicker),
    ).toBe(true);

    const picker = tui.children.find(
      (c) => c instanceof SearchableProviderPicker,
    ) as SearchableProviderPicker;
    picker.handleInput("\r");

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result?.id).toBe("fake");
    expect(
      tui.children.some((c) => c instanceof SearchableProviderPicker),
    ).toBe(false);
  });
});
