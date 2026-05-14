# MetaObjects

A cross-language metadata standard for declaring typed entity models that drive code generation, runtime metadata access, and drift detection across multiple languages.

The metamodel is the durable spine; generated code is the disposable artifact. Substrate is local-first: typed metadata lives in your repo, generated code is idiomatic per-language output that runs without any MetaObjects dependency at runtime.

## Languages

| Language | Status | Directory |
|---|---|---|
| TypeScript | Reference implementation | [`typescript/`](typescript/) |
| Java | Planned (H3) | [`java/`](java/) |
| Python | Planned | [`python/`](python/) |
| C# | Planned | [`csharp/`](csharp/) |

## What's in this repo

- [`spec/`](spec/) — cross-language design docs, roadmap, conformance test documentation
- [`fixtures/`](fixtures/) — shared cross-language conformance test fixtures
- [`typescript/`](typescript/) — TypeScript implementation (codegen, runtime, CLI, SDK)
- [`java/`](java/), [`python/`](python/), [`csharp/`](csharp/) — placeholders for upcoming ports

## Getting started (TypeScript)

```bash
cd typescript
pnpm install
pnpm build
```

CLI binary: `meta`. Project config: `metaobjects.config.ts`. Project marker directory: `.metaobjects/`.

## Roadmap

See [`spec/roadmap.md`](spec/roadmap.md) for current + planned work.

## License

Apache 2.0 (see [LICENSE](LICENSE)).
