import { defineConfig } from "vitest/config";

export default defineConfig({
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
