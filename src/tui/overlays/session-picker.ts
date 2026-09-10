import chalk from "chalk";
import {
  fuzzyFilter,
  Input,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ThebeProduct } from "../../product/service.ts";

export type ProductSessionRow = {
  thebeSessionId: string;
  runtimeSessionId: string;
  parentThebeSessionId?: string;
  title?: string;
  status: "active" | "idle" | "done";
  createdAt?: string;
  updatedAt?: string;
  lastActiveAt?: string;
};

export interface SearchableSessionPickerOptions {
  sessions: ProductSessionRow[];
  currentSessionId?: string;
  initialQuery?: string;
  pageSize?: number;
  onSelect: (session: ProductSessionRow) => void;
  onCancel: () => void;
  onRequestRender?: () => void;
}

export class SearchableSessionPicker implements Component, Focusable {
  private allSessions: ProductSessionRow[];
  private currentSessionId?: string;
  private pageSize: number;
  private onSelectCallback: (session: ProductSessionRow) => void;
  private onCancelCallback: () => void;
  private onRequestRender?: () => void;

  private searchInput: Input;
  private filteredSessions: ProductSessionRow[] = [];
  private selectedIndex = 0;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(options: SearchableSessionPickerOptions) {
    this.allSessions = [...options.sessions];
    this.currentSessionId = options.currentSessionId;
    this.pageSize = options.pageSize ?? 8;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.onRequestRender = options.onRequestRender;

    this.searchInput = new Input({
      prompt: chalk.cyan("Session: "),
      placeholder: "filter sessions",
      placeholderStyle: (t) => chalk.dim(t),
    });

    if (options.initialQuery) {
      this.searchInput.setValue(options.initialQuery);
    }

    this.recomputeFilteredSessions();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  private sortSessions(rows: ProductSessionRow[]): ProductSessionRow[] {
    return [...rows].sort((a, b) => {
      if (a.thebeSessionId === this.currentSessionId) return -1;
      if (b.thebeSessionId === this.currentSessionId) return 1;
      const aTime = a.lastActiveAt ?? a.updatedAt ?? a.createdAt ?? "";
      const bTime = b.lastActiveAt ?? b.updatedAt ?? b.createdAt ?? "";
      return bTime.localeCompare(aTime);
    });
  }

  private recomputeFilteredSessions(): void {
    const query = this.searchInput.getValue().trim();
    if (!query) {
      this.filteredSessions = this.sortSessions(this.allSessions);
    } else {
      const matches = fuzzyFilter(
        this.allSessions,
        query,
        (s) =>
          `${s.title ?? ""} ${s.thebeSessionId} ${s.status} ${s.lastActiveAt ?? s.createdAt ?? ""}`,
      );
      this.filteredSessions = matches;
    }

    if (this.selectedIndex >= this.filteredSessions.length) {
      this.selectedIndex = Math.max(0, this.filteredSessions.length - 1);
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.onCancelCallback();
      return;
    }

    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\r" || data === "\n") {
      const selected = this.filteredSessions[this.selectedIndex];
      if (selected) {
        this.onSelectCallback(selected);
      } else {
        this.onCancelCallback();
      }
      return;
    }

    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      if (this.filteredSessions.length > 0) {
        this.selectedIndex =
          (this.selectedIndex - 1 + this.filteredSessions.length) %
          this.filteredSessions.length;
        this.onRequestRender?.();
      }
      return;
    }

    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      if (this.filteredSessions.length > 0) {
        this.selectedIndex =
          (this.selectedIndex + 1) % this.filteredSessions.length;
        this.onRequestRender?.();
      }
      return;
    }

    if (matchesKey(data, "pageUp")) {
      if (this.filteredSessions.length > 0) {
        this.selectedIndex = Math.max(0, this.selectedIndex - this.pageSize);
        this.onRequestRender?.();
      }
      return;
    }

    if (matchesKey(data, "pageDown")) {
      if (this.filteredSessions.length > 0) {
        this.selectedIndex = Math.min(
          this.filteredSessions.length - 1,
          this.selectedIndex + this.pageSize,
        );
        this.onRequestRender?.();
      }
      return;
    }

    // Forward text typing to search input
    this.searchInput.handleInput(data);
    this.recomputeFilteredSessions();
    this.onRequestRender?.();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const searchRendered = this.searchInput.render(Math.max(10, width - 4));
    lines.push(`  ${searchRendered[0] ?? ""}`);

    const total = this.filteredSessions.length;
    if (total === 0) {
      lines.push(chalk.yellow("    No matching sessions"));
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
        const item = this.filteredSessions[i]!;
        const isSelected = i === this.selectedIndex;
        const isCurrent = item.thebeSessionId === this.currentSessionId;
        const cursor = isSelected ? chalk.cyan("→ ") : "  ";
        const currentMarker = isCurrent ? chalk.cyan("✓ ") : "  ";
        const title = item.title ? item.title : "(untitled)";
        const titleText = isSelected ? chalk.cyan(title) : title;
        const idBadge = chalk.dim(`[${item.thebeSessionId.slice(0, 8)}]`);
        const statusBadge =
          item.status === "active"
            ? chalk.green(`[${item.status}]`)
            : chalk.dim(`[${item.status}]`);
        const branchBadge = item.parentThebeSessionId
          ? chalk.magenta("↳ branch")
          : "";

        const parts = [
          `  ${cursor}${currentMarker}${titleText}`,
          idBadge,
          statusBadge,
          branchBadge,
        ].filter(Boolean);

        lines.push(parts.join(" "));
      }

      if (total > this.pageSize) {
        lines.push(chalk.dim(`    (${this.selectedIndex + 1}/${total})`));
      }
    }

    lines.push(chalk.dim("  ↑/↓: navigate · Enter: switch · Esc: cancel"));

    return lines.map((line) => truncateToWidth(line, width, ""));
  }
}

export interface AttachSessionPickerOptions {
  product: ThebeProduct;
  currentSessionId?: string;
  initialQuery?: string;
  focusBack?: unknown;
}

export async function attachSearchableSessionPicker(
  tui: TUI,
  options: AttachSessionPickerOptions,
): Promise<ProductSessionRow | null> {
  const sessions = (await options.product.listSessions()) as ProductSessionRow[];
  if (sessions.length === 0) {
    return null;
  }

  return new Promise<ProductSessionRow | null>((resolvePromise) => {
    let settled = false;
    let picker: SearchableSessionPicker;

    const cleanup = (result: ProductSessionRow | null) => {
      if (settled) return;
      settled = true;
      tui.removeChild(picker);
      if (options.focusBack) {
        tui.setFocus(options.focusBack as never);
      }
      tui.requestRender();
      resolvePromise(result);
    };

    picker = new SearchableSessionPicker({
      sessions,
      currentSessionId: options.currentSessionId,
      initialQuery: options.initialQuery,
      onSelect: (session) => cleanup(session),
      onCancel: () => cleanup(null),
      onRequestRender: () => tui.requestRender(),
    });

    tui.addChild(picker);
    tui.setFocus(picker);
    tui.requestRender();
  });
}
