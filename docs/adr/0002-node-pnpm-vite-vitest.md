# Node 22+, pnpm, Vite, and Vitest

Runtime is Node `>=22.19`, matching `pi-agent-core`. Bun is not the runtime: Pi's SQLite session backend imports `node:sqlite`, which Bun 1.3.14 does not provide.

Package manager is pnpm. Build is Vite targeting Node. Tests are Vitest in the Node environment. Typecheck stays with `tsc --noEmit`.
