import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: ".",
  build: {
    ssr: true,
    target: "node24",
    sourcemap: false,
    minify: "oxc",
    reportCompressedSize: false,
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        index: resolve(import.meta.dirname, "src/index.ts"),
        serve: resolve(import.meta.dirname, "src/delivery/http/serve.ts"),
        tui: resolve(import.meta.dirname, "src/delivery/tui/main.ts"),
        cli: resolve(import.meta.dirname, "src/delivery/cli/main.ts"),
      },
      preserveEntrySignatures: "allow-extension",
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        codeSplitting: {
          groups: [
            { name: "env", test: /[/\\]src[/\\]app[/\\]config[/\\]env\.ts$/, priority: 40 },
            { name: "http", test: /[/\\]src[/\\]delivery[/\\]http[/\\](?!serve\.ts$)/, priority: 30 },
            {
              name: "arcane",
              test: /[/\\]src[/\\]adapters[/\\]arcane[/\\]/,
              priority: 30,
            },
            { name: "tui-app", test: /[/\\]src[/\\]delivery[/\\]tui[/\\](?!main\.ts$)/, priority: 25 },
            {
              name: "core",
              test: /[/\\]src[/\\](agent|app|adapters)[/\\]/,
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
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    server: {
      deps: {
        external: [/^@earendil-works\/pi-coding-agent/],
      },
    },
  },
});
