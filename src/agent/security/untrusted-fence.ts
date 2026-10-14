/**
 * The fence that marks tool output as untrusted data for the model.
 *
 * Data inside must not be able to close the fence early, or what follows would read as
 * instructions. Any `<tool_output` or `</tool_output` in the data gets a zero-width space after the
 * tag name, so it no longer matches the closing tag the parsers look for but still reads the same.
 * The tool name comes from external MCP servers too, so it is reduced to a safe alphabet.
 */
const FENCE_TAG = /<(\/?\s*)tool_output/gi;
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9_.:/@-]/g;

export function neutralizeFenceTags(text: string): string {
  return text.replace(FENCE_TAG, "<$1tool_output​");
}

export function fenceToolOutput(toolName: string, text: string): string {
  const name = toolName.replace(UNSAFE_NAME_CHARS, "_");
  return `<tool_output tool="${name}">\n${neutralizeFenceTags(text)}\n</tool_output>`;
}
