# Contributing to meshbot

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/slow89/meshbot.git
cd meshbot
pnpm install
pnpm run build
```

## Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b my-feature`)
3. Make your changes
4. Run checks:
   ```bash
   pnpm run lint
   pnpm run typecheck
   pnpm test
   ```
5. Commit your changes
6. Push to your fork and open a Pull Request

## Code Style

- TypeScript strict mode is enforced
- ESLint with `strictTypeChecked` rules — run `pnpm run lint` before committing
- No `any` types — use proper typing or `unknown` with narrowing
- Prefer `??` over `||` for nullish defaults

## Tests

Tests use [Vitest](https://vitest.dev/). Run them with:

```bash
pnpm test              # single run
pnpm run test:watch    # watch mode
```

Integration tests spin up real HTTP servers on random ports — no external dependencies needed.

## Project Structure

```
bin/meshbot.ts         CLI entry point
src/
  mcp/server.ts        MCP server (stdio transport + HTTP listener + tools)
  server/              HTTP server (receives messages from peers)
  client/              HTTP client (sends messages to peers)
  queue/               Message queue with persistence
  config/              Config loading/saving
  security/            HMAC signing, key generation
tests/                 Unit + integration tests
```
