import { defineConfig } from "tsdown";

/**
 * Bundles the four Node entry points with Rolldown/Oxc (the same engine that
 * powered the previous Vite build). `dependencies` stay external, so the runtime
 * image resolves them from `node_modules` (the pi runtime is located at runtime
 * by `src/adapters/pi/sdk/load-pi.ts`).
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    serve: "src/delivery/http/serve.ts",
    tui: "src/delivery/tui/main.ts",
    cli: "src/delivery/cli/main.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  // `.js` (the package is `"type": "module"`), not tsdown's node default `.mjs`,
  // so `dist/serve.js` and the `thebe` bin keep their paths.
  fixedExtension: false,
  outputOptions: {
    entryFileNames: "[name].js",
    chunkFileNames: "chunks/[name]-[hash].js",
  },
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: false,
  minify: true,
});
