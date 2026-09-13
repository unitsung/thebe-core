import chalk from "chalk";
import {
  fuzzyFilter,
  Input,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
} from "../rendering/adapter.ts";
import type { ThebeAgent, RuntimeProvider } from "../../../agent/index.ts";
import { fitLines, insertOverlay, isConfirmKey, type DismissiblePicker } from "./index.ts";

export interface SearchableProviderPickerOptions {
  providers: RuntimeProvider[];
  modelCounts: Map<string, number>;
  currentProvider?: string;
  pageSize?: number;
  onSelect: (provider: RuntimeProvider) => void;
  onCancel: () => void;
  onRequestRender?: () => void;
}

/** Provider selector with fuzzy search, connection status, and model counts. */
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

  get focused(): boolean { return this._focused; }
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
      prompt: chalk.cyan("Provider: "),
      placeholder: "filter providers",
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
        const aIsCustom = a.id === "custom";
        const bIsCustom = b.id === "custom";
        if (aIsCustom && !bIsCustom) return -1;
        if (!aIsCustom && bIsCustom) return 1;
        return a.id.localeCompare(b.id);
      });
    } else {
      this.filteredProviders = fuzzyFilter(this.allProviders, query, (p) =>
        `${p.id} ${p.displayName ?? ""} ${p.authStatus ?? ""}`,
      );
    }
    if (resetSelection) this.selectedIndex = 0;
    else this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filteredProviders.length - 1));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      if (!this.filteredProviders.length) return;
      this.selectedIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : this.filteredProviders.length - 1;
      this.onRequestRender?.();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      if (!this.filteredProviders.length) return;
      this.selectedIndex = this.selectedIndex < this.filteredProviders.length - 1 ? this.selectedIndex + 1 : 0;
      this.onRequestRender?.();
      return;
    }
    if (isConfirmKey(data)) {
      const selected = this.filteredProviders[this.selectedIndex];
      if (selected) this.onSelectCallback(selected);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.onCancelCallback();
      return;
    }
    const previous = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (previous !== this.searchInput.getValue()) this.recomputeFilteredProviders(true);
    this.onRequestRender?.();
  }

  invalidate(): void { this.searchInput.invalidate(); }

  render(width: number): string[] {
    const lines: string[] = [];
    const searchRendered = this.searchInput.render(Math.max(10, width - 4));
    lines.push(`  ${searchRendered[0] ?? ""}`);
    const total = this.filteredProviders.length;
    if (!total) {
      lines.push(chalk.yellow("    No matching providers"));
    } else {
      const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.pageSize / 2), total - this.pageSize));
      const endIndex = Math.min(startIndex + this.pageSize, total);
      for (let i = startIndex; i < endIndex; i++) {
        const item = this.filteredProviders[i]!;
        const isSelected = i === this.selectedIndex;
        const isCurrent = item.id === this.currentProvider;
        const isCustom = item.id === "custom";
        const cursor = isSelected ? chalk.cyan("→ ") : "  ";
        const currentMarker = isCurrent ? chalk.cyan("✓ ") : "  ";
        const status = isCustom ? chalk.dim("endpoint")
          : item.authStatus === "connected" ? chalk.green("connected")
            : item.authStatus === "error" ? chalk.red("error") : chalk.dim("missing");
        const nameText = isSelected ? chalk.cyan(item.displayName ?? item.id) : (item.displayName ?? item.id);
        const count = this.modelCounts.get(item.id);
        const countBadge = isCustom ? chalk.cyan("compatible") : count ? chalk.dim(`${count} models`) : "";
        lines.push([`  ${cursor}${currentMarker}${nameText}`, chalk.dim(`[${item.id}]`), countBadge, status].filter(Boolean).join(" "));
      }
      if (total > this.pageSize) lines.push(chalk.dim(`    (${this.selectedIndex + 1}/${total})`));
    }
    lines.push(chalk.dim("  ↑/↓: navigate · Enter: select · Esc: cancel"));
    return fitLines(lines, width);
  }
}

export async function attachSearchableProviderPicker(
  tui: TUI,
  options: { agent: ThebeAgent; currentModel?: string; focusBack?: unknown; includeCustom?: boolean },
): Promise<RuntimeProvider | null> {
  const [providers, models] = await Promise.all([
    options.agent.listProviders(),
    options.agent.listAvailableModels(),
  ]);
  const modelCounts = new Map<string, number>();
  for (const model of models) modelCounts.set(model.providerId, (modelCounts.get(model.providerId) ?? 0) + 1);
  const allProviders = [...providers];
  if (options.includeCustom && !allProviders.some((provider) => provider.id === "custom")) {
    allProviders.unshift({ id: "custom", displayName: "Custom Provider (OpenAI / Anthropic Compatible)", authMethods: ["apiKey"], authStatus: "missing" });
  }
  return new Promise((resolvePromise) => {
    let resolved = false;
    const finish = (result: RuntimeProvider | null) => {
      if (resolved) return;
      resolved = true;
      tui.removeChild(picker);
      if (options.focusBack) tui.setFocus(options.focusBack as never);
      tui.requestRender();
      resolvePromise(result);
    };
    const picker = new SearchableProviderPicker({
      providers: allProviders,
      modelCounts,
      currentProvider: options.currentModel?.split("/")[0],
      onSelect: finish,
      onCancel: () => finish(null),
      onRequestRender: () => tui.requestRender(),
    });
    (picker as unknown as DismissiblePicker).dismiss = () => finish(null);
    insertOverlay(tui, picker, options.focusBack);
    tui.setFocus(picker);
    tui.requestRender();
  });
}
