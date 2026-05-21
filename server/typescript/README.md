# MetaObjects — TypeScript

TypeScript implementation of the MetaObjects standard.

## Packages

| Package | Purpose |
|---|---|
| `@metaobjects/metadata` | Loader, registry, typed views |
| `@metaobjects/codegen-ts` | Code generation (TS targets) |
| `@metaobjects/codegen-ts-react` | React codegen (form-file generator) |
| `@metaobjects/codegen-ts-tanstack` | TanStack hooks + grid codegen |
| `@metaobjects/runtime-ts` | Server-side runtime (Node, Fastify integration) |
| `@metaobjects/runtime-web` (under `client/web/`) | Browser core: currency, filter-qs, fetcher types |
| `@metaobjects/react` (under `client/web/`) | React runtime: `useEntityForm`, `<CurrencyInput>` |
| `@metaobjects/tanstack` (under `client/web/`) | TanStack runtime: `EntityFetcherProvider`, `<EntityGrid>` |
| `@metaobjects/migrate-ts` | Database migration tooling |
| `@metaobjects/sdk` | Programmatic SDK (memory, paths, workspace) |
| `@metaobjects/cli` | The `meta` CLI binary (`init`, `gen`, `migrate`) |
| `@metaobjects/forge` | AI-collaboration capabilities (agent-docs, future MCP) |

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
