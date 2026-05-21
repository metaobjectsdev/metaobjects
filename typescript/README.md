# MetaObjects — TypeScript

TypeScript implementation of the MetaObjects standard.

**Status:** v0.3 — Projects D–G shipped end-to-end, 1784+ tests passing. Reference quality.

The workspace is **Bun-first** for development (zero-config TS, native test runner). Distribution stays Node-compatible — consumers install via npm, pnpm, or bun without any runtime lock-in.

## Packages

Each package lives under `typescript/packages/<name>/` and publishes under the `@metaobjects/` npm scope.

| Package | Purpose |
|---|---|
| `@metaobjects/metadata` | Loader, registry, typed views |
| `@metaobjects/codegen-ts` | Code generation (TS targets) |
| `@metaobjects/codegen-ts-tanstack` | TanStack hooks + grid codegen |
| `@metaobjects/runtime-ts` | Server-side runtime (Node, Fastify integration) |
| `@metaobjects/runtime-ts-client` | Browser runtime (React, TanStack hooks, currency, components) |
| `@metaobjects/migrate-ts` | Database migration tooling |
| `@metaobjects/sdk` | Programmatic SDK (memory, paths, workspace) |
| `@metaobjects/cli` | The `meta` CLI binary (`init`, `gen`, `migrate`) |
| `@metaobjects/forge` | AI-collaboration capabilities (agent-docs, future MCP) |
| `@metaobjects/conformance` | Cross-language conformance test runner |

## Getting started

```bash
bun install
bun run build
bun test
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

## Metadata format

Metadata uses the canonical fused-key encoding: every node is a one-key map `{ "<type>.<subType>": <body> }`.

```jsonc
{ "metadata.root": {
    "package": "acme::commerce",
    "children": [
      { "object.entity": { "name": "Program", "children": [
        { "field.long": { "name": "id" }},
        { "field.string": { "name": "title" }},
        { "identity.primary": { "@fields": ["id"] }}
      ]}}
    ]
}}
```

See [`../spec/metamodel.md`](../spec/metamodel.md) and [`../spec/wire-format.md`](../spec/wire-format.md) for the full format.
