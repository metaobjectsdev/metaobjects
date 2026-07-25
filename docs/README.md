# MetaObjects Documentation

This directory is the user-facing entry point to MetaObjects: the feature reference
(what the metamodel can express, and what each language port emits for it) and the
per-port quickstarts (how to install, wire, generate, and use the output).

If you are a developer adopting MetaObjects, start with your language's quickstart
under [`ports/`](ports/). If you are an LLM helping a developer adopt it, the feature
files under [`features/`](features/) are the source of truth — each file is
self-contained and shows the same `Author` entity across all five ports so you can
copy-paste cross-port without context-switching.

## Layout

```
docs/
├── README.md                    # this file
├── CONFORMANCE.md               # inverse index: fixture → feature doc + per-port pass status
├── features/                    # one file per metamodel feature — see `ls docs/features/`
│                                 # for the definitive, always-current list; as of this
│                                 # writing:
│   ├── entities.md
│   ├── source-kinds.md
│   ├── relationships.md
│   ├── field-types.md
│   ├── templates-and-payloads.md
│   ├── loaders.md
│   ├── migrations-and-drift.md
│   ├── migrations/                  # per-version migration guides (e.g. 0.x → 1.0)
│   ├── api-contract.md          # cross-port REST contract (the universal browser client speaks it)
│   ├── abstracts-and-inheritance.md # abstract: true + extends: — author-side shape reuse
│   ├── extending-with-providers.md  # custom metamodel subtypes/attrs via MetaDataTypeProvider
│   ├── yaml-authoring.md
│   ├── cli.md                       # CLI command matrix across all five ports
│   ├── codegen-concepts.md          # declarative template-codegen scopes (perEntity/perPackage/perModel)
│   ├── codegen-data-shapes.md       # the neutral template data dict shared cross-port
│   ├── downstream-metadata-decisions.md # guidance for adopters extending the metamodel
│   ├── generated-mutations.md       # generated POST/PATCH mutation surface
│   ├── image-upload.md              # view.image form control (TS-web)
│   └── own-your-codegen.md          # scaffold-and-own generator ownership (ADR-0034)
└── ports/                       # one file per language/framework port
    ├── typescript.md
    ├── typescript-client.md     # browser-side TS (React, TanStack, Angular, codegen pairs)
    ├── java.md
    ├── kotlin.md
    ├── csharp.md
    └── python.md
```

If this list and `ls docs/features/` ever disagree, trust the directory listing —
this tree is documentation, not the source of truth.

## When to read which

| You want to … | Read |
|---|---|
| Pick a language and ship a small CRUD app | [`ports/<lang>.md`](ports/) |
| Understand what `object.entity`, `source.rdb`, `template.prompt` mean | [`features/`](features/) |
| Compare what TS vs Java vs Kotlin vs C# vs Python emit for the same metadata | any [`features/*.md`](features/) — every feature shows all five ports side-by-side |
| Author metadata in YAML instead of JSON | [`features/yaml-authoring.md`](features/yaml-authoring.md) |
| Wire prompt construction (FR-004) | [`features/templates-and-payloads.md`](features/templates-and-payloads.md) |
| Share a metadata shape across multiple instances (abstracts, `extends:`) | [`features/abstracts-and-inheritance.md`](features/abstracts-and-inheritance.md) |
| Add a custom metamodel subtype or attribute to a downstream project | [`features/extending-with-providers.md`](features/extending-with-providers.md) + [`recipes/extending-metaobjects-with-providers.md`](recipes/extending-metaobjects-with-providers.md) |
| Wire the universal browser client (React + TanStack, or Angular 18) to any backend | [`ports/typescript-client.md`](ports/typescript-client.md) (see [§Angular 18](ports/typescript-client.md#angular-18) for the Angular tier) + [`features/api-contract.md`](features/api-contract.md) |
| Know which feature is supported in which port today | the capability matrix in the root [`README.md`](../README.md) or the per-port "Capability snapshot" table |
| See which conformance fixtures gate each feature (and which port passes which) | [`CONFORMANCE.md`](CONFORMANCE.md) |
| See a worked, non-toy model end to end (projections, value objects, TPH, prompt payloads on one runnable spine) | [`../examples/advanced-modeling/`](../examples/advanced-modeling/) |
| Read the canonical spec (target-agnostic) | [`../spec/`](../spec/) |
| Find a release recipe (Cloudflare D1, etc.) | [`recipes/`](recipes/) |
| See the deeper design rationale for a feature | [`superpowers/specs/`](superpowers/specs/) |

## Conventions used in these docs

- **Named example.** Every feature file uses an `Author` entity in the `acme::blog`
  package, with `id` (long), `name` (string, required), and `bio` (string, optional).
  Stable across files so you can cross-reference behavior without re-loading
  unrelated context.
- **Both authoring formats shown.** Canonical JSON (the on-disk interchange) and
  sigil-free YAML (the AI-first authoring front-end, [ADR-0006](../spec/decisions/ADR-0006-ai-first-yaml-authoring.md)).
- **Generated output shown per port.** TS / Java / Kotlin / C# / Python. If a port
  doesn't yet support a feature, the section says so explicitly with a pointer to
  the port's roadmap.
- **Code blocks are complete.** No "rest omitted" — drop into a fresh project and run.

## See also

- Root [`README.md`](../README.md) — capability matrix and project status across ports
- [`../spec/roadmap.md`](../spec/roadmap.md) — current + planned work
- [`../spec/decisions/`](../spec/decisions/) — ADRs for cross-cutting contracts
- [`../fixtures/`](../fixtures/) — cross-language conformance corpora (metamodel,
  YAML, render, verify, persistence)
