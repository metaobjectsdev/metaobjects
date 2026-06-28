# Cross-Port `templateGenerator()` — Design

**Date:** 2026-05-28
**Status:** Shipped (2026-05-28) — all three planned ports (Python, C#, Java) + shared conformance corpus implemented and byte-equivalent against the TS reference
**Scope:** Bring the TS `templateGenerator()` factory contract to the C#, Java, and Python ports so adopters in any port can ship custom template-driven codegen with the same surface as TS.

**Builds on:**
- TS rc.12 (`@metaobjectsdev/codegen-ts@0.7.0-rc.12`) — shipped the factory + the first instance (`docsFile()`)
- The 2026-05-28 internal design doc on template-driven codegen (kept in `forge/` — establishes the "Code → hand-coded generators; Documents → templateGenerator" split that the factory exists to enforce)
- The pure-Mustache + cross-port byte-equivalence commitment (already proven for `render-conformance` fixtures across TS / C# / Java / Kotlin / Python)

## Context

Every port already ships a Mustache render layer (`@metaobjectsdev/render` in TS, `MetaObjects.Render` in C#, `codegen-mustache` + `render` in Java, the `render` module in Python). The `render-conformance` corpus proves these render byte-identically against shared fixtures — that property is the whole point of choosing pure logic-less Mustache.

What rc.12 added to TS is a level above raw rendering: the `templateGenerator()` factory wraps "walk the MetaRoot → render template → emit files" into a single declarative shape an adopter can drop into their `metaobjects.config.ts`. The TS surface:

```ts
templateGenerator({
  name: "my-codegen",
  template: "my-template",      // resolved via Provider chain
  walk: (root) => [...],         // returns { data, outputPath }[]
  format: "markdown",            // drives escaping
})
```

That signature does three things hand-written generators had been duplicating since the codegen layer existed:

1. **Standardize the walk-then-emit shape** so generators stop reinventing iteration over `MetaRoot`.
2. **Standardize provider resolution** so adopters can override any template by dropping a file at the same name into their `templates/` directory — same chain as docsFile / payload-VO codegen.
3. **Couple data shape to template** at a single named site, so the byte-output of an adopter-written codegen survives MO version upgrades the same way framework codegen does.

Without a factory in the other ports, an adopter who wants custom codegen in C# or Java has to write a full `IGenerator` / `Generator` class (≥100 LOC of boilerplate around essentially the same three steps). That undermines the cross-port equivalence claim — pure Mustache + byte-equivalent render is necessary but not sufficient if the *integration surface* differs per port.

## Goal

Each port ships a `templateGenerator` factory with a conceptually-equivalent contract to the TS surface, integrated into that port's existing codegen entry point (`meta gen` CLI / Maven plugin / build-time hook), with a shared conformance fixture proving template + payload → byte-identical output across all four implementations.

The visible adopter surface in each port:

| Port | Surface |
|---|---|
| TS | `templateGenerator({ ... })` in `metaobjects.config.ts` |
| C# | `TemplateGenerator.Configure(opts => { ... })` in the codegen setup |
| Java | `<templateGenerator>` element in the Maven plugin config, or programmatic `TemplateGenerator.builder()` |
| Python | `template_generator(...)` in the project's config module |

Each surface accepts the same conceptual inputs (name, template ref, walk function, format, optional filter/provider/target) and produces the same conceptual output (an iterable of `{ data, outputPath }` rendered through the project's provider chain).

## Non-goals

- **Replacing native codegen for Code outputs.** The `forge/` design doc (2026-05-28) locked in the split: hand-coded generators for `.ts` / `.cs` / `.java` source emission (each port's idiomatic AST builder — ts-poet, KotlinPoet, etc.), `templateGenerator()` for Documents (docs, OpenAPI, Mermaid, HTML doc sites, ADRs, etc.). Cross-porting the factory does not mean migrating any existing entity/repo/route generator off its current AST builder.
- **Mustache dialect features.** The render layer already locks the dialect — bring the factory; don't expand Mustache.
- **Kotlin parity.** Kotlin's codegen layer (`codegen-kotlin`) is KotlinPoet-only by design — it's a Code-emission port, no Document layer. Add the factory only if Kotlin grows a Documents need. Defer until then. _(Superseded 2026-06-28 by SP-1b: Kotlin gained a declarative template generator via the shared JVM `TemplateScopeGenerator` — no KotlinPoet involvement. See `docs/superpowers/specs/2026-06-28-mustache-codegen-parity-design.md`.)_
- **Project scaffolding / template marketplace.** Out of scope. The factory is the integration primitive; sharing templates between adopters is a separate concern (and may never need to exist as a packaged feature — git is a fine distribution mechanism).

## Architecture

### Per-port mapping of the TS contract

```
TS                                  Concept           Other ports
-----------------------------------  ----------------  -------------------------
GeneratorFactory<TemplateGenerator
  Opts>                              Factory shape    Native factory/builder
opts.name (kebab-case)               Identifier        string, kebab-case (port-
                                                       idiomatic case is OK in
                                                       APIs that surface it)
opts.walk: (root) => Result[]        Walk function     port-native callable
                                                       returning iterable of
                                                       (data, outputPath)
opts.template (string ref)           Template ref      string ref through the
                                                       port's render Provider
opts.format ("text"|"html"|...)      Escaper hint      port's existing render
                                                       format enum (already
                                                       cross-port-equivalent
                                                       via render-conformance)
opts.filter (optional)               Entity filter     port-native predicate
opts.provider (optional)             Provider          port's existing Provider
                                                       chain (project → frame-
                                                       work defaults)
opts.target (optional)               Build target      port's existing target
                                                       concept (same as other
                                                       generators)
Returns Generator                    Generator         port's existing
                                                       Generator/IGenerator
                                                       interface
```

### Shared template resolution (already cross-port)

Every port's render layer already implements the project → framework provider chain. The factory does not introduce new resolution rules — it composes the existing chain. An adopter who drops `templates/my-template.mustache` into their project root overrides the framework default of the same name, in any port.

### Generator-interface integration per port

Each port already has a Generator interface its hand-coded generators implement. The factory returns an instance of that interface — so an adopter wiring a `templateGenerator(...)` in their config is indistinguishable, from the runner's POV, from wiring a hand-coded generator. The `meta gen` CLI, the Maven plugin, etc. need no per-instance changes; they iterate Generators and call `generate(ctx)`.

### Provider construction default

TS defaults to `projectProvider(process.cwd())`. Each port mirrors using its own equivalent of "the running project's root" (the directory containing `metaobjects.config.ts` / `pom.xml` / `pyproject.toml` / `.csproj`). The override path (`opts.provider`) covers adopters who want a non-standard lookup chain — same in every port.

## Conformance

This work is byte-equivalence territory; the conformance fixture is the load-bearing piece, not the per-port code. Plan 0 shipped the corpus + TS reference harness:

- **Corpus + format spec:** [`fixtures/render-conformance/template-generator/README.md`](../../fixtures/render-conformance/template-generator/README.md)
- **TS reference harness:** [`server/typescript/packages/codegen-ts/test/conformance/template-generator-conformance.test.ts`](../../server/typescript/packages/codegen-ts/test/conformance/template-generator-conformance.test.ts)

Three reference fixtures ship with Plan 0:

| Fixture | Pattern |
|---|---|
| `fixture-001-flat-entity-walk` | One template, one output file per entity (per-entity pattern). |
| `fixture-002-aggregate-walk` | One template, single aggregated output file. |
| `fixture-003-filter-driven-walk` | One template, output files only for an entity subset (filter pattern). |

Each fixture is a directory containing `meta.json` (declarative entity set), `template.mustache`, `walk.json` (declarative `{entity?, data, outputPath}[]`), and `expected/<outputPath>` byte-exact expected output. The per-port adapter is the only port-specific code in the conformance suite — it parses the fixture, builds a `MetaRoot` via the port's `_meta-build`-equivalent helpers, and asserts emitted files equal `expected/` byte-for-byte. See the corpus README for the full schema.

### Existing test coverage already in TS

The TS port's existing `template-generator.test.ts` exercises the factory directly. That stays; the cross-port conformance fixture lives alongside it.

## Shipped (2026-05-28)

All three planned ports landed on branch `phase-cross-port-template-generator`:

| Port | Factory | Unit tests | Conformance | Notes |
|---|---|---|---|---|
| **TypeScript** (reference) | `server/typescript/packages/codegen-ts/src/generators/template-generator.ts` | (existing) | 8/8 green | rc.12, reference impl |
| **Python** | `server/python/src/metaobjects/codegen/generators/template_generator.py` | 4/4 green | 3/3 fixtures pass byte-equivalently | Satisfies existing `Generator` Protocol |
| **C#** | `server/csharp/MetaObjects.Codegen/Generators/TemplateGenerator.cs` | 4/4 green | 3/3 fixtures pass byte-equivalently | Satisfies existing `IGenerator` interface |
| **Java** | `server/java/render/src/main/java/com/metaobjects/render/templategen/TemplateGenerator.java` | 4/4 green | 3/3 fixtures pass byte-equivalently | New types (does NOT satisfy legacy `Generator` interface — see Java notes below) |

**Plans:** `docs/superpowers/plans/2026-05-28-cross-port-template-generator-plan{0,1,2,3}-*.md` document the per-port TDD work.

### Java cross-port API divergence

Java's existing `com.metaobjects.generator.Generator` interface has `void execute(MetaDataLoader)` — side-effect only, no return value — which doesn't fit the cross-port "factory returns `List<EmittedFile>`" shape. The Java port introduces three new lightweight types (`EmittedFile`, `TemplateWalkResult`, `TemplateGenerator`) under `com.metaobjects.render.templategen` rather than retrofitting the legacy interface.

The Java factory's root parameter is generic (`<R>`) instead of typed as `MetaRoot` — this keeps the render module's dependency graph free of the metadata package. The walk callback knows the actual root type at the call site.

**Deferred for Java:** Maven plugin surface (`mvn meta:generate` integration). Adopters who want it can wrap the factory in their own legacy-`Generator`-conformant glue. Track via a follow-up if/when a Java adopter has the need. _(Resolved 2026-06-28 by SP-1b: `com.metaobjects.generator.template.TemplateScopeGenerator` is a `GeneratorBase` subclass wirable as a standard `<generator>` in `pom.xml` — adopters no longer hand-write glue. See `docs/superpowers/specs/2026-06-28-mustache-codegen-parity-design.md`.)_

## Open questions

- **How do non-TS ports surface adopter-defined walk functions in config files?** The Java Maven-plugin path probably needs a programmatic config option (Maven XML can't express a closure), so the adopter writes a `TemplateGenerator.builder()` call in a small Java class the plugin loads. C# and Python have less friction here. Worth deciding before implementation; not worth deciding now.
- **Should the `walk.json` declarative format be the canonical fixture form, or do we want imperative test fixtures (with per-port walk implementations checked in)?** Declarative is the leaner long-term shape but pushes complexity into the per-port adapter. Probably revisit during fixture-001 implementation.
- **Does `format` need to be cross-port-equivalent at the conformance level, or only per-port?** The render-conformance corpus already proves format-driven escaping is byte-equivalent across ports, so this should fall out for free — but worth confirming with the first fixture.
- **Provider chain override semantics.** TS passes a Provider object. Java/C# may want a more structured config (a list of template directories) rather than a callable. The override-path API doesn't have to match exactly across ports as long as the *default* path does.

## Decisions

- **Kotlin port is out of scope for this design** (KotlinPoet-only, no Documents layer today). Revisit only when Kotlin grows a Documents codegen need. _(Revisited + superseded 2026-06-28 by SP-1b — Kotlin now ships a declarative template generator via the shared JVM engine.)_
- **No changes to the TS factory contract as part of this work.** TS is the reference; other ports adapt to it. Any contract change requires a separate design doc and a TS-side bump.
- **Conformance via shared declarative fixtures** (not per-port test code). Locks the byte-equivalence guarantee at the contract level.
- **Activation gated on adopter pull, not calendar.** This doc plus the conformance design is enough to start work the moment the trigger fires; nothing is gained by starting earlier.

## Roadmap impact

Add to `spec/roadmap.md` under "Planned" — entry tagged "activation-gated."
