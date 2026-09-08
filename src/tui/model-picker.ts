import chalk from "chalk";
import {
  fuzzyFilter,
  Input,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ThebeProduct } from "../product/service.ts";
import type { RuntimeModel, RuntimeProvider } from "../runtime/types.ts";
import { formatTokens } from "./app.ts";

export interface SearchableModelPickerOptions {
  models: RuntimeModel[];
  currentModel?: string;
  defaultModel?: string;
  initialQuery?: string;
  initialProvider?: string;
  pageSize?: number;
  onSelect: (model: RuntimeModel) => void;
  onCancel: () => void;
  onRequestRender?: () => void;
}

/**
 * Clean, lightweight searchable model selector with real-time fuzzy typing,
 * provider cycling tabs via Tab key, and clear specifications.
 */
export class SearchableModelPicker implements Component, Focusable {
  private allModels: RuntimeModel[];
  private currentModel?: string;
  private defaultModel: string;
  private pageSize: number;
  private onSelectCallback: (model: RuntimeModel) => void;
  private onCancelCallback: () => void;
  private onRequestRender?: () => void;

  private searchInput: Input;
  private providers: string[] = ["all"];
  private providerIndex = 0;
  private filteredModels: RuntimeModel[] = [];
  private selectedIndex = 0;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(options: SearchableModelPickerOptions) {
    this.allModels = [...options.models];
    this.currentModel = options.currentModel;
    this.defaultModel = options.defaultModel ?? "opencode/muse-spark-1.3-free";
    this.pageSize = options.pageSize ?? 8;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.onRequestRender = options.onRequestRender;

    // Collect unique providers
    const uniqueProviders = Array.from(
      new Set(this.allModels.map((m) => m.providerId)),
    ).sort();
    this.providers = ["all", ...uniqueProviders];

    if (options.initialProvider) {
      const idx = this.providers.indexOf(options.initialProvider.toLowerCase());
      if (idx >= 0) {
        this.providerIndex = idx;
      }
    }

    this.searchInput = new Input({
      prompt: chalk.cyan("Search: "),
      placeholder: "Type to filter (e.g. spark, claude, gpt)...",
      placeholderStyle: (t) => chalk.dim(t),
    });

    if (options.initialQuery) {
      this.searchInput.setValue(options.initialQuery);
    }

    this.recomputeFilteredModels();
  }

  private getActiveProvider(): string {
    return this.providers[this.providerIndex] ?? "all";
  }

  private sortModels(models: RuntimeModel[]): RuntimeModel[] {
    return [...models].sort((a, b) => {
      const aKey = `${a.providerId}/${a.modelId}`;
      const bKey = `${b.providerId}/${b.modelId}`;
      const aIsCurrent = aKey === this.currentModel;
      const bIsCurrent = bKey === this.currentModel;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;

      const aIsDefault = aKey === this.defaultModel;
      const bIsDefault = bKey === this.defaultModel;
      if (aIsDefault && !bIsDefault) return -1;
      if (!aIsDefault && bIsDefault) return 1;

      if (a.providerId !== b.providerId) {
        return a.providerId.localeCompare(b.providerId);
      }
      return a.modelId.localeCompare(b.modelId);
    });
  }

  private recomputeFilteredModels(resetSelection = false): void {
    const activeProvider = this.getActiveProvider();
    const providerScoped =
      activeProvider === "all"
        ? this.allModels
        : this.allModels.filter((m) => m.providerId === activeProvider);

    const query = this.searchInput.getValue().trim();
    if (!query) {
      this.filteredModels = this.sortModels(providerScoped);
    } else {
      const lower = query.toLowerCase();
      if (lower === "reasoning" || lower === "thinking") {
        this.filteredModels = providerScoped.filter((m) => m.supportsThinking);
      } else {
        this.filteredModels = fuzzyFilter(providerScoped, query, (m) => {
          const isDefault = `${m.providerId}/${m.modelId}` === this.defaultModel ? " default" : "";
          const name = m.displayName ? ` ${m.displayName}` : "";
          return `${m.modelId} ${m.providerId} ${m.providerId}/${m.modelId}${name}${isDefault}`;
        });
      }
    }

    if (resetSelection) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = Math.max(
        0,
        Math.min(this.selectedIndex, this.filteredModels.length - 1),
      );
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex > 0
          ? this.selectedIndex - 1
          : this.filteredModels.length - 1;
      this.onRequestRender?.();
      return;
    }

    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex < this.filteredModels.length - 1
          ? this.selectedIndex + 1
          : 0;
      this.onRequestRender?.();
      return;
    }

    if (matchesKey(data, "pageUp")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - this.pageSize);
      this.onRequestRender?.();
      return;
    }

    if (matchesKey(data, "pageDown")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex = Math.min(
        this.filteredModels.length - 1,
        this.selectedIndex + this.pageSize,
      );
      this.onRequestRender?.();
      return;
    }

    if (matchesKey(data, "tab")) {
      this.providerIndex = (this.providerIndex + 1) % this.providers.length;
      this.recomputeFilteredModels(true);
      this.onRequestRender?.();
      return;
    }

    if (matchesKey(data, "shift+tab")) {
      this.providerIndex =
        (this.providerIndex - 1 + this.providers.length) % this.providers.length;
      this.recomputeFilteredModels(true);
      this.onRequestRender?.();
      return;
    }

    if (matchesKey(data, "return")) {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected) {
        this.onSelectCallback(selected);
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      this.onCancelCallback();
      return;
    }

    // Forward character typing / editing to searchInput
    const prevQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    const nextQuery = this.searchInput.getValue();
    if (prevQuery !== nextQuery) {
      this.recomputeFilteredModels(true);
    }
    this.onRequestRender?.();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const maxLen = Math.min(Math.max(width, 40), 76);
    const divider = chalk.dim("  " + "─".repeat(maxLen - 2));

    // 1. Header: title & provider filter
    const activeProvider = this.getActiveProvider();
    const filterText =
      activeProvider === "all"
        ? chalk.dim("all providers")
        : chalk.cyan(`[${activeProvider}]`);
    lines.push(
      `  ${chalk.bold("Model Selector")}  ${chalk.dim("Provider:")} ${filterText}  ${chalk.dim("(Tab to cycle)")}`,
    );

    // 2. Search input
    const searchRendered = this.searchInput.render(Math.max(10, width - 4));
    lines.push(`  ${searchRendered[0] ?? ""}`);
    lines.push(divider);

    // 3. Item list
    const total = this.filteredModels.length;
    if (total === 0) {
      lines.push(
        chalk.yellow("    No matching models found. Press Tab to cycle provider."),
      );
    } else {
      const startIndex = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(this.pageSize / 2),
          total - this.pageSize,
        ),
      );
      const endIndex = Math.min(startIndex + this.pageSize, total);

      for (let i = startIndex; i < endIndex; i++) {
        const item = this.filteredModels[i]!;
        const isSelected = i === this.selectedIndex;
        const key = `${item.providerId}/${item.modelId}`;
        const isCurrent = key === this.currentModel;
        const isDefault = key === this.defaultModel;

        const cursor = isSelected ? chalk.bold.cyan("→ ") : "  ";
        const currentMarker = isCurrent ? chalk.bold.green("✓ ") : "  ";
        const modelIdText = isSelected
          ? chalk.bold.cyan(item.modelId)
          : chalk.white(item.modelId);
        const providerBadge = chalk.dim(`[${item.providerId}]`);
        const defaultBadge = isDefault ? chalk.yellow(" · default") : "";
        const ctxBadge = item.contextWindow
          ? chalk.dim(` ${formatTokens(item.contextWindow)} ctx`)
          : "";
        const reasoningBadge = item.supportsThinking
          ? chalk.magenta(" [reasoning]")
          : "";

        lines.push(
          `  ${cursor}${currentMarker}${modelIdText} ${providerBadge}${ctxBadge}${defaultBadge}${reasoningBadge}`,
        );
      }

      if (total > this.pageSize) {
        lines.push(
          chalk.dim(`    (${this.selectedIndex + 1}/${total} models)`),
        );
      }
    }

    // 4. Selected details summary
    lines.push(divider);
    const currentSelected = this.filteredModels[this.selectedIndex];
    if (currentSelected) {
      const isCur = `${currentSelected.providerId}/${currentSelected.modelId}` === this.currentModel;
      const isDef = `${currentSelected.providerId}/${currentSelected.modelId}` === this.defaultModel;
      const statusBadge = isCur
        ? chalk.green(" (Currently Active ✓)")
        : isDef
          ? chalk.yellow(" (System Default)")
          : "";
      const ctxStr = currentSelected.contextWindow
        ? ` · ${formatTokens(currentSelected.contextWindow)} ctx`
        : "";
      const thinkStr = currentSelected.supportsThinking
        ? " · reasoning"
        : "";

      lines.push(
        `  ${chalk.dim("Selected Model Details:")} ${chalk.cyan(`${currentSelected.providerId}/${currentSelected.modelId}`)}${ctxStr}${thinkStr}${statusBadge}`,
      );
    }

    // 5. Hotkey legend
    lines.push(
      chalk.dim("  Enter select  •  Tab cycle provider  •  ↑↓ navigate  •  Esc cancel"),
    );
    lines.push(divider);

    return lines;
  }
}

export interface SearchableProviderPickerOptions {
  providers: RuntimeProvider[];
  modelCounts: Map<string, number>;
  currentProvider?: string;
  pageSize?: number;
  onSelect: (provider: RuntimeProvider) => void;
  onCancel: () => void;
  onRequestRender?: () => void;
}

/**
 * Clean, lightweight searchable provider selector showing connection statuses,
 * available models count, and authentication methods.
 */
export class SearchableProviderPicker implements Component, Focusable {
  private allProviders: RuntimeProvider[];
  private modelCounts: Map<string, number>;
  private currentProvider?: string;
  private pageSize: number;
  private onSelectCallback: (provider: RuntimeProvider) => void;
  private onCancelCallback: () => void;
  private onRequestRender?: () => void;

  private searchInput: Input;
  private filteredProviders: RuntimeProvider[] = [];
  private selectedIndex = 0;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(options: SearchableProviderPickerOptions) {
    this.allProviders = [...options.providers];
    this.modelCounts = options.modelCounts;
    this.currentProvider = options.currentProvider;
    this.pageSize = options.pageSize ?? 8;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.onRequestRender = options.onRequestRender;

    this.searchInput = new Input({
      prompt: chalk.cyan("Search: "),
      placeholder: "Filter providers (e.g. opencode, anthropic)...",
      placeholderStyle: (t) => chalk.dim(t),
    });

    this.recomputeFilteredProviders();
  }

  private recomputeFilteredProviders(resetSelection = false): void {
    const query = this.searchInput.getValue().trim();
    if (!query) {
      this.filteredProviders = [...this.allProviders].sort((a, b) => {
        const aIsCur = a.id === this.currentProvider;
        const bIsCur = b.id === this.currentProvider;
        if (aIsCur && !bIsCur) return -1;
        if (!aIsCur && bIsCur) return 1;
        return a.id.localeCompare(b.id);
      });
    } else {
      this.filteredProviders = fuzzyFilter(this.allProviders, query, (p) => {
        return `${p.id} ${p.displayName ?? ""} ${p.authStatus ?? ""}`;
      });
    }

    if (resetSelection) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = Math.max(
        0,
        Math.min(this.selectedIndex, this.filteredProviders.length - 1),
      );
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      if (this.filteredProviders.length === 0) return;
      this.selectedIndex =
        this.selectedIndex > 0
          ? this.selectedIndex - 1
          : this.filteredProviders.length - 1;
      this.onRequestRender?.();
      return;
    }

    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      if (this.filteredProviders.length === 0) return;
      this.selectedIndex =
        this.selectedIndex < this.filteredProviders.length - 1
          ? this.selectedIndex + 1
          : 0;
      this.onRequestRender?.();
      return;
    }

    if (matchesKey(data, "return")) {
      const selected = this.filteredProviders[this.selectedIndex];
      if (selected) {
        this.onSelectCallback(selected);
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      this.onCancelCallback();
      return;
    }

    const prevQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    const nextQuery = this.searchInput.getValue();
    if (prevQuery !== nextQuery) {
      this.recomputeFilteredProviders(true);
    }
    this.onRequestRender?.();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const maxLen = Math.min(Math.max(width, 40), 76);
    const divider = chalk.dim("  " + "─".repeat(maxLen - 2));

    // 1. Header
    lines.push(
      `  ${chalk.bold("Provider Selector")}  ${chalk.dim("• Select a provider to browse models")}`,
    );

    // 2. Search input
    const searchRendered = this.searchInput.render(Math.max(10, width - 4));
    lines.push(`  ${searchRendered[0] ?? ""}`);
    lines.push(divider);

    // 3. Provider list
    const total = this.filteredProviders.length;
    if (total === 0) {
      lines.push(chalk.yellow("    No matching providers found."));
    } else {
      const startIndex = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(this.pageSize / 2),
          total - this.pageSize,
        ),
      );
      const endIndex = Math.min(startIndex + this.pageSize, total);

      for (let i = startIndex; i < endIndex; i++) {
        const item = this.filteredProviders[i]!;
        const isSelected = i === this.selectedIndex;
        const isCurrent = item.id === this.currentProvider;
        const count = this.modelCounts.get(item.id) ?? 0;

        const cursor = isSelected ? chalk.bold.cyan("→ ") : "  ";
        let statusBullet = chalk.yellow("○ ");
        let statusText = chalk.yellow("missing key");
        if (item.authStatus === "connected") {
          statusBullet = chalk.green("● ");
          statusText = chalk.green("connected");
        } else if (item.authStatus === "error") {
          statusBullet = chalk.red("× ");
          statusText = chalk.red("error");
        }

        const nameText = isSelected
          ? chalk.bold.cyan(item.displayName ?? item.id)
          : chalk.white(item.displayName ?? item.id);
        const idBadge = chalk.dim(`[${item.id}]`);
        const modelBadge = chalk.dim(`(${count} models)`);
        const activeBadge = isCurrent ? chalk.cyan(" · active") : "";

        lines.push(
          `  ${cursor}${statusBullet}${nameText} ${idBadge} · ${statusText} ${modelBadge}${activeBadge}`,
        );
      }
    }

    // 4. Details
    lines.push(divider);
    const current = this.filteredProviders[this.selectedIndex];
    if (current) {
      const count = this.modelCounts.get(current.id) ?? 0;
      const statusDesc =
        current.authStatus === "connected"
          ? chalk.green("connected ●")
          : current.authStatus === "error"
            ? chalk.red("error ×")
            : chalk.yellow("missing key ○");

      lines.push(
        `  ${chalk.dim("Provider Details:")} ${chalk.bold(current.displayName ?? current.id)} [${current.id}] · ${statusDesc} · (${count} models)`,
      );
    }

    // 5. Hotkey legend
    lines.push(
      chalk.dim("  Enter select & browse models  •  ↑↓ navigate  •  Esc cancel"),
    );
    lines.push(divider);

    return lines;
  }
}

/**
 * Attach and display the interactive searchable model picker.
 * Resolves with the selected RuntimeModel, or null if cancelled.
 */
export async function attachSearchableModelPicker(
  tui: TUI,
  options: {
    product: ThebeProduct;
    currentModel?: string;
    initialQuery?: string;
    providerFilter?: string;
    focusBack?: unknown;
  },
): Promise<RuntimeModel | null> {
  const models = await options.product.listAvailableModels();
  if (models.length === 0) {
    return null;
  }

  return new Promise((resolvePromise) => {
    let resolved = false;
    const finish = (result: RuntimeModel | null) => {
      if (resolved) return;
      resolved = true;
      tui.removeChild(picker);
      if (options.focusBack) {
        tui.setFocus(options.focusBack as never);
      }
      tui.requestRender();
      resolvePromise(result);
    };

    const picker = new SearchableModelPicker({
      models,
      currentModel: options.currentModel,
      defaultModel: "opencode/muse-spark-1.3-free",
      initialQuery: options.initialQuery,
      initialProvider: options.providerFilter,
      onSelect: (model) => finish(model),
      onCancel: () => finish(null),
      onRequestRender: () => tui.requestRender(),
    });

    tui.addChild(picker);
    tui.setFocus(picker);
    tui.requestRender();
  });
}

/**
 * Attach and display the interactive searchable provider picker.
 * Resolves with the selected RuntimeProvider, or null if cancelled.
 */
export async function attachSearchableProviderPicker(
  tui: TUI,
  options: {
    product: ThebeProduct;
    currentModel?: string;
    focusBack?: unknown;
  },
): Promise<RuntimeProvider | null> {
  const [providers, models] = await Promise.all([
    options.product.listProviders(),
    options.product.listAvailableModels(),
  ]);

  const modelCounts = new Map<string, number>();
  for (const m of models) {
    modelCounts.set(m.providerId, (modelCounts.get(m.providerId) ?? 0) + 1);
  }

  return new Promise((resolvePromise) => {
    let resolved = false;
    const finish = (result: RuntimeProvider | null) => {
      if (resolved) return;
      resolved = true;
      tui.removeChild(picker);
      if (options.focusBack) {
        tui.setFocus(options.focusBack as never);
      }
      tui.requestRender();
      resolvePromise(result);
    };

    const picker = new SearchableProviderPicker({
      providers,
      modelCounts,
      currentProvider: options.currentModel?.split("/")[0],
      onSelect: (provider) => finish(provider),
      onCancel: () => finish(null),
      onRequestRender: () => tui.requestRender(),
    });

    tui.addChild(picker);
    tui.setFocus(picker);
    tui.requestRender();
  });
}
