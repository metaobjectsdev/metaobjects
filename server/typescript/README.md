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

```bash
pnpm install
pnpm build
pnpm test
```

## CLI

The CLI binary is `meta`:

```bash
meta init           # scaffold a new project
meta gen            # generate code from metadata
meta migrate        # database migrations
```

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
└── metaobjects.config.ts    # generator wiring
```
