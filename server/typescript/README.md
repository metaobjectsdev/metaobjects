# MetaObjects — TypeScript

TypeScript implementation of the MetaObjects standard.

## Packages

| Package | Purpose |
|---|---|
| `@metaobjectsdev/metadata` | Loader, registry, typed views |
| `@metaobjectsdev/codegen-ts` | Code generation (TS targets) |
| `@metaobjectsdev/codegen-ts-react` | React codegen (form-file generator) |
| `@metaobjectsdev/codegen-ts-tanstack` | TanStack hooks + grid codegen |
| `@metaobjectsdev/runtime-ts` | Server-side runtime (Node, Fastify integration) |
| `@metaobjectsdev/runtime-web` (under `client/web/`) | Browser core: currency, filter-qs, fetcher types |
| `@metaobjectsdev/react` (under `client/web/`) | React runtime: `useEntityForm`, `<CurrencyInput>` |
| `@metaobjectsdev/tanstack` (under `client/web/`) | TanStack runtime: `EntityFetcherProvider`, `<EntityGrid>` |
| `@metaobjectsdev/migrate-ts` | Database migration tooling |
| `@metaobjectsdev/sdk` | Programmatic SDK (memory, paths, workspace) |
| `@metaobjectsdev/cli` | The `meta` CLI binary (`init`, `gen`, `migrate`) |
| `@metaobjectsdev/forge` | AI-collaboration capabilities (agent-docs, future MCP) |

## Getting started

Bun workspace — the workspace root is the **repository root** (run `bun install` there, not here).

```bash
bun install                          # once, at the repo root
bun test                             # the server suite (from this directory)
bun run --filter '*' typecheck       # whole workspace (from the repo root)
```

## CLI

The CLI binary is `meta`:

```bash
meta init           # scaffold a new project
meta gen            # generate code from metadata
meta migrate        # database migrations
```

## Releasing

Publishing these packages to npm: see [docs/RELEASING.md](../../docs/RELEASING.md) — the
RC → smoke-test → promote procedure plus the must-know gotchas (publish with `bun publish`,
`rm bun.lock && bun install` after every version bump, runtime imports must be `dependencies`).

## Project layout in a consumer

```
my-project/
├── metaobjects/             # entity declarations (one file per domain)
│   ├── meta.common.json
│   ├── meta.commerce.json
│   └── ...
├── .metaobjects/            # tool state (gitignored: .gen-state/)
│   ├── config.json
│   └── .gen-state/
└── metaobjects.config.ts    # generator wiring + per-target output
```
