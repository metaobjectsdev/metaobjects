# MetaObjects

A cross-language metadata standard for declaring typed entity models that drive code generation, runtime metadata access, and drift detection across multiple languages.

The metamodel is the durable spine; generated code is the disposable artifact. Substrate is local-first: typed metadata lives in your repo, generated code is idiomatic per-language output that runs without any MetaObjects dependency at runtime.

## Languages

| Language | Status | Directory |
|---|---|---|
| TypeScript | Reference implementation (v0.3) | [`typescript/`](typescript/) |
| Java | In progress (H3a shipped 2026-05-19; H3b active) | [`java/`](java/) |
| Python | Planned | [`python/`](python/) |
| C# | Loader + conformance shipped | [`csharp/`](csharp/) |

## What's in this repo

- [`spec/`](spec/) — cross-language design docs, roadmap, conformance test documentation
- [`fixtures/`](fixtures/) — shared cross-language conformance test fixtures
- [`typescript/`](typescript/) — TypeScript implementation (codegen, runtime, CLI, SDK)
- [`java/`](java/), [`python/`](python/), [`csharp/`](csharp/) — placeholders for upcoming ports

## Getting started (TypeScript)

```bash
cd typescript
bun install
bun test
```

(Bun-first dev workflow; no separate build step. Typecheck across the workspace with `bun run --filter '*' typecheck`. Distribution artifacts remain Node-compatible — consumers can install via npm/pnpm/bun.)

CLI binary: `meta`. Project config: `metaobjects.config.ts`. Project marker directory: `.metaobjects/`.

## Roadmap

See [`spec/roadmap.md`](spec/roadmap.md) for current + planned work.

## License

Apache 2.0 (see [LICENSE](LICENSE)).
