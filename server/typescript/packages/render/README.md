# @metaobjectsdev/render

Logic-less, deterministic text render engine (Mustache) for MetaObjects templates — provider-resolved partials, format-driven escaping, and stable, snapshot-testable output. Zero runtime dependency on the rest of MetaObjects.

Part of the [MetaObjects](https://github.com/metaobjectsdev/metaobjects) monorepo.

## Install

```bash
npm install @metaobjectsdev/render
```

## What it provides

- **`render()`** — render a MetaObjects `template.output` / `template.prompt` against a typed payload. Deterministic and cache-stable (no whitespace drift that would silently break exact-prefix prompt-cache hits), so output is snapshot-testable.
- **Provider-resolved partials + format-driven escaping** (text / html / xml / csv / json / markdown).
- **`verify()`** — a build-time drift check that every `{{field}}` referenced by a template resolves to a field on its payload value-object; a renamed field fails the build instead of silently degrading a prompt.

This engine backs the prompt-construction pillar — the generated `render<Name>()` helpers emitted by `@metaobjectsdev/codegen-ts` wrap it. See the **metaobjects-prompts** skill and the repo `docs/` for authoring `template.*` and payload VOs.
