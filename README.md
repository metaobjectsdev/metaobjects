# MetaObjects

A cross-language metadata standard for declaring typed entity models that drive code generation, runtime metadata access, and drift detection across multiple languages.

The metamodel is the durable spine; generated code is the disposable artifact. Substrate is local-first: typed metadata lives in your repo, generated code is idiomatic per-language output that runs without any MetaObjects dependency at runtime.

## Languages

| Language | Status | Directory |
|---|---|---|
| TypeScript | Reference implementation — published on npm (`0.5.0`) | [`server/typescript/`](server/typescript/) · [`client/web/`](client/web/) |
| Java | In progress (H3a shipped 2026-05-19; H3b active) | [`java/`](java/) |
| Python | Planned | [`python/`](python/) |
| C# | Loader + conformance shipped | [`csharp/`](csharp/) |

## What's in this repo

- [`spec/`](spec/) — cross-language design docs, roadmap, conformance test documentation
- [`fixtures/`](fixtures/) — shared cross-language conformance test fixtures
- [`docs/recipes/`](docs/recipes/) — deployment recipes (Cloudflare Workers, more on the way)
- [`server/typescript/`](server/typescript/) — server-side TypeScript (codegen, runtime, CLI, SDK); [`client/web/`](client/web/) — browser packages (React, TanStack, framework-agnostic runtime)
- [`java/`](java/), [`csharp/`](csharp/), [`python/`](python/) — other language ports (see status table above)

## Getting started (TypeScript)

```bash
bun install                        # at the repo root (the JS/TS workspace root)
cd server/typescript && bun test   # server suite
```

(Bun-first dev workflow; no separate build step. Typecheck across the workspace with `bun run --filter '*' typecheck` from the repo root. Published packages are on npm — consumers install via npm/pnpm/bun, e.g. `npm i @metaobjectsdev/cli`.)

CLI binary: `meta`. Project config: `metaobjects.config.ts`. Project marker directory: `.metaobjects/`.

## Roadmap

See [`spec/roadmap.md`](spec/roadmap.md) for current + planned work.

## Releasing

Publishing the TypeScript packages to npm: see [`docs/RELEASING.md`](docs/RELEASING.md).

## License

Apache 2.0 (see [LICENSE](LICENSE)).
