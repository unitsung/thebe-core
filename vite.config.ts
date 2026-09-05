import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    ssr: true,
    target: "node22",
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/index.ts"),
      output: {
        format: "es",
        entryFileNames: "[name].js",
      },
      external: [/^node:/, /^@earendil-works\//],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
