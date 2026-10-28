# @metaobjectsdev/render

Deterministic text render engine for MetaObjects templates — Mustache (logic-less, the default and cross-port engine) and Jinja (via nunjucks, ADR-0061) — with provider-resolved partials, format-driven escaping, and stable, snapshot-testable output. Zero runtime dependency on the rest of MetaObjects.

Part of the [MetaObjects](https://github.com/metaobjectsdev/metaobjects) monorepo.

## Install

```bash
npm install @metaobjectsdev/render
```

## What it provides

- **`render()`** — render a MetaObjects `template.output` / `template.prompt` against a typed payload. Deterministic and cache-stable (no whitespace drift that would silently break exact-prefix prompt-cache hits), so output is snapshot-testable.
- **Provider-resolved partials + format-driven escaping** (text / html / xml / csv / json / markdown).
- **Providers** — `InMemoryProvider` (root entry, browser-safe) and `FilesystemProvider`
  (Node-only, on the `@metaobjectsdev/render/providers` subpath so the root entry never
  pulls in `node:fs`). `new FilesystemProvider("./prompts").resolve("lobby/welcome")` reads
  `./prompts/lobby/welcome.mustache`, exactly as the C#, Java and Python ports do; when there
  is none it reads `welcome.jinja`, `.j2` or `.jinja2`, and `engineOf(ref)` says which engine
  that file is for.
- **Jinja bodies** — a ref that resolves to a Jinja file renders with nunjucks, through the
  same escapers and provider. `render({ engine: "jinja", … })` and
  `verify(text, fields, { engine: "jinja" })` name the engine explicitly (for an
  `InMemoryProvider`, or pass `{ engine: "jinja" }` to its constructor). The Python port renders
  the same vocabulary byte-identically with jinja2; Java, Kotlin and C# render Mustache only.
- **`verify()`** — a build-time drift check that every `{{field}}` referenced by a template resolves to a field on its payload value-object; a renamed field fails the build instead of silently degrading a prompt. For a Jinja body it walks the parsed template (paths, loop targets, filter arguments, includes) and reports what it cannot settle statically as `ERR_TEMPLATE_NOT_STATIC`.

This engine backs the prompt-construction pillar — the generated `render<Name>()` helpers emitted by `@metaobjectsdev/codegen-ts` wrap it. See the **metaobjects-prompts** skill and the repo `docs/` for authoring `template.*` and payload VOs.
