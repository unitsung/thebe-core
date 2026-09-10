/**
 * Official Pi UI helpers that Thebe is allowed to reuse.
 *
 * Product and TUI code must import these from here — never from
 * `@earendil-works/pi-coding-agent` directly (see CONTEXT.md isolation).
 *
 * Only symbols on the package public export surface are re-exported.
 */
export {
  BashExecutionComponent,
  copyToClipboard,
  createLocalBashOperations,
  initTheme,
} from "@earendil-works/pi-coding-agent";
