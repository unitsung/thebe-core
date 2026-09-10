import type { TuiMode } from "@earendil-works/pi-tui";
import type { ThebeProduct } from "../product/service.ts";
import type { ThemeName } from "./theme.ts";

export type ThebeTuiSend = (text: string) => Promise<string>;

export type ThebeTuiOptions = {
  product?: ThebeProduct;
  sessionId?: string;
  title?: string;
  model?: string;
  version?: string;
  /** Simple reply adapter used by unit tests / demos. */
  send?: ThebeTuiSend;
  tuiMode?: TuiMode;
  theme?: ThemeName;
  /** Invoked after `/tui` persists a mode so the host can swap the live screen. */
  onTuiModeChange?: (mode: TuiMode) => void | Promise<void>;
};
