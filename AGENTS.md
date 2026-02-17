# Repository Guidelines

`meshbot` is a lightweight Claude wrapper (with planned Codex support) for agent-to-agent communication via MCP + per-agent HTTP servers.

## Project Structure & Module Organization
Core code lives in `src/`:
- `src/mcp/` MCP server wiring
- `src/server/` HTTP server and routes
- `src/client/` outbound peer communication
- `src/queue/` in-memory queue and ask/response tracking
- `src/config/` mesh config loading/types
- `src/security/` key generation and request signing

CLI entrypoint code is in `bin/meshbot.ts`. Tests live in `tests/` as `*.test.ts` files. Build output is generated into `dist/`.

## Build, Test, and Development Commands
Use `pnpm` only (lockfile and CI are pnpm-based).

- `pnpm install` installs dependencies
- `pnpm run dev` runs the CLI via `tsx`
- `pnpm run build` compiles TypeScript and prepares executable hooks in `dist/`
- `pnpm run lint` runs ESLint on `src/`, `bin/`, and `tests/`
- `pnpm run typecheck` runs strict TypeScript checks
- `pnpm test` runs Vitest once
- `pnpm run test:watch` runs tests in watch mode

## Coding Style & Naming Conventions
TypeScript is strict (`tsconfig.json`) and ESM (`module: NodeNext`).

- Use 2-space indentation and semicolons
- Prefer explicit types; `any` is disallowed by lint rules
- Use `??` for nullish defaults instead of `||`
- Use `type` imports where possible (`consistent-type-imports`)
- Keep filenames lowercase kebab-case (for example, `message-queue.ts`)

Run `pnpm run lint` before opening a PR. Use `pnpm run lint:fix` for safe autofixes.

## Testing Guidelines
Testing uses Vitest. Place tests in `tests/` with `*.test.ts` naming.

- Prefer focused unit tests by module (`tests/security.test.ts`, etc.)
- Use integration tests for real HTTP flows (`tests/integration.test.ts`)
- Keep tests deterministic (random ports are fine; no external services required)

Before submitting, run: `pnpm run lint && pnpm run typecheck && pnpm test`.

## Commit & Pull Request Guidelines
Current history uses short, imperative commit subjects (example: `meshbot init`). Keep commits focused and readable.

PRs should include:
- A clear description of behavior changes
- Linked issue(s) when applicable
- Updated tests/docs for user-visible changes
- CLI output examples when changing commands

CI on GitHub Actions must pass (`lint`, `typecheck`, `test`, and `build` across supported Node versions).

## Architecture Notes
`meshbot start --as <agent>` launches an agent process that:
- starts MCP tooling for Claude/Codex integration
- runs an HTTP endpoint for peer messaging
- signs/verifies messages with shared mesh keys

Keep changes small across `src/mcp/`, `src/server/`, and `src/client/` so messaging behavior stays consistent.
