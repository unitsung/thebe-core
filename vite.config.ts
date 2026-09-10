import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: ".",
  build: {
    ssr: true,
    target: "node22",
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        index: resolve(import.meta.dirname, "src/index.ts"),
        serve: resolve(import.meta.dirname, "src/http/serve.ts"),
        tui: resolve(import.meta.dirname, "src/tui/main.ts"),
        cli: resolve(import.meta.dirname, "src/cli/main.ts"),
      },
      preserveEntrySignatures: "allow-extension",
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        codeSplitting: {
          groups: [
            { name: "env", test: /[/\\]src[/\\]config[/\\]env\.ts$/, priority: 40 },
            { name: "http", test: /[/\\]src[/\\]http[/\\](?!serve\.ts$)/, priority: 30 },
            {
              name: "arcane",
              test: /[/\\]src[/\\]adapters[/\\]/,
              priority: 30,
            },
            { name: "tui-app", test: /[/\\]src[/\\]tui[/\\](?!main\.ts$)/, priority: 25 },
            {
              name: "core",
              test: /[/\\]src[/\\](agent|product|runtime|tools|policy|providers|stream-guard|audit|auth|config)[/\\]/,
              priority: 20,
            },
          ],
        },
      },
      external: [/^node:/, /^@earendil-works\//],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        external: [/^@earendil-works\/pi-coding-agent/],
      },
    },
  },
});
