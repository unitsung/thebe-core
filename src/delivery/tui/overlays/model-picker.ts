import chalk from "chalk";
import {
  fuzzyFilter,
  Input,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
} from "../rendering/adapter.ts";
import type { ThebeAgent, RuntimeModel } from "../../../agent/index.ts";
import { fitLines, insertOverlay, isConfirmKey, sameProvider, type DismissiblePicker } from "./index.ts";
export { SearchableProviderPicker, attachSearchableProviderPicker } from "./provider-picker.ts";

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

/** Model selector with fuzzy search and provider cycling. */
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

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(options: SearchableModelPickerOptions) {
    this.allModels = [...options.models];
    this.currentModel = options.currentModel;
    this.defaultModel = options.defaultModel ?? "";
    this.pageSize = options.pageSize ?? 8;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.onRequestRender = options.onRequestRender;
    const uniqueProviders = Array.from(new Set(this.allModels.map((model) => model.providerId))).sort();
    this.providers = uniqueProviders.length <= 1
      ? uniqueProviders.length === 1 ? uniqueProviders : ["all"]
      : ["all", ...uniqueProviders];
    if (options.initialProvider) {
      const index = this.providers.findIndex((id) => sameProvider(id, options.initialProvider!));
      if (index >= 0) this.providerIndex = index;
    }
    this.searchInput = new Input({
      prompt: chalk.cyan("Search: "),
      placeholder: "filter models",
      placeholderStyle: (text) => chalk.dim(text),
    });
    if (options.initialQuery) this.searchInput.setValue(options.initialQuery);
    this.recomputeFilteredModels();
  }

  private getActiveProvider(): string { return this.providers[this.providerIndex] ?? "all"; }

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
      if (a.providerId !== b.providerId) return a.providerId.localeCompare(b.providerId);
      return a.modelId.localeCompare(b.modelId);
    });
  }

  private recomputeFilteredModels(resetSelection = false): void {
    const query = this.searchInput.getValue().trim();
    if (!query) {
      const activeProvider = this.getActiveProvider();
      this.filteredModels = this.sortModels(activeProvider === "all"
        ? this.allModels
        : this.allModels.filter((model) => sameProvider(model.providerId, activeProvider)));
    } else if (["reasoning", "thinking"].includes(query.toLowerCase())) {
      this.filteredModels = this.allModels.filter((model) => model.supportsThinking);
    } else {
      this.filteredModels = fuzzyFilter(this.allModels, query, (model) => {
        const key = `${model.providerId}/${model.modelId}`;
        return `${model.modelId} ${model.providerId} ${key} ${model.displayName ?? ""}${key === this.defaultModel ? " default" : ""}`;
      });
    }
    this.selectedIndex = resetSelection
      ? 0
      : Math.max(0, Math.min(this.selectedIndex, this.filteredModels.length - 1));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      if (!this.filteredModels.length) return;
      this.selectedIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : this.filteredModels.length - 1;
      this.onRequestRender?.();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      if (!this.filteredModels.length) return;
      this.selectedIndex = this.selectedIndex < this.filteredModels.length - 1 ? this.selectedIndex + 1 : 0;
      this.onRequestRender?.();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      if (!this.filteredModels.length) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - this.pageSize);
      this.onRequestRender?.();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      if (!this.filteredModels.length) return;
      this.selectedIndex = Math.min(this.filteredModels.length - 1, this.selectedIndex + this.pageSize);
      this.onRequestRender?.();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      const delta = matchesKey(data, "tab") ? 1 : -1;
      this.providerIndex = (this.providerIndex + delta + this.providers.length) % this.providers.length;
      this.recomputeFilteredModels(true);
      this.onRequestRender?.();
      return;
    }
    if (isConfirmKey(data)) {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected) this.onSelectCallback(selected);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.onCancelCallback();
      return;
    }
    const previous = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (previous !== this.searchInput.getValue()) this.recomputeFilteredModels(true);
    this.onRequestRender?.();
  }

  invalidate(): void { this.searchInput.invalidate(); }

  render(width: number): string[] {
    const lines: string[] = [];
    const searchRendered = this.searchInput.render(Math.max(10, width - 4));
    lines.push(`  ${searchRendered[0] ?? ""}`);
    const query = this.searchInput.getValue().trim();
    if (!query && this.providers.length > 1) {
      const active = this.getActiveProvider();
      const tabs = this.providers.map((provider) => provider === active ? chalk.cyan(`[${provider}]`) : chalk.dim(provider)).join(" ");
      lines.push(chalk.dim(`  Provider: ${tabs} (Tab to cycle)`));
    }
    const total = this.filteredModels.length;
    if (!total) {
      lines.push(chalk.yellow("    No matching models"));
    } else {
      const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.pageSize / 2), total - this.pageSize));
      const endIndex = Math.min(startIndex + this.pageSize, total);
      for (let i = startIndex; i < endIndex; i++) {
        const item = this.filteredModels[i]!;
        const key = `${item.providerId}/${item.modelId}`;
        const selected = i === this.selectedIndex;
        const current = key === this.currentModel;
        const isDefault = Boolean(this.defaultModel) && key === this.defaultModel;
        lines.push(`  ${selected ? chalk.cyan("› ") : "  "}${current ? chalk.cyan("✓ ") : "  "}${selected ? chalk.cyan(item.modelId) : item.modelId} ${chalk.dim(`[${item.providerId}]`)}${isDefault ? chalk.dim(" · default") : ""}`);
      }
      if (total > this.pageSize) lines.push(chalk.dim(`    (${this.selectedIndex + 1}/${total})`));
    }
    lines.push(chalk.dim(query ? "  ↑/↓: navigate · Enter: select · Esc: cancel" : "  ↑/↓: navigate · Enter: select · Tab: provider · Esc: cancel"));
    return fitLines(lines, width);
  }
}

export async function attachSearchableModelPicker(
  tui: TUI,
  options: { agent: ThebeAgent; currentModel?: string; initialQuery?: string; providerFilter?: string; focusBack?: unknown },
): Promise<RuntimeModel | null> {
  let providerId = options.providerFilter?.trim();
  if (providerId) {
    const providers = await options.agent.listProviders();
    const match = providers.find((provider) => sameProvider(provider.id, providerId!));
    if (match) providerId = match.id;
  }
  const models = await options.agent.listAvailableModels(providerId ? { providerId } : undefined);
  if (!models.length) return null;
  return new Promise((resolvePromise) => {
    let resolved = false;
    const finish = (result: RuntimeModel | null) => {
      if (resolved) return;
      resolved = true;
      tui.removeChild(picker);
      if (options.focusBack) tui.setFocus(options.focusBack as never);
      tui.requestRender();
      resolvePromise(result);
    };
    const picker = new SearchableModelPicker({
      models,
      currentModel: options.currentModel,
      defaultModel: options.currentModel,
      initialQuery: options.initialQuery,
      initialProvider: providerId,
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
