# Codegen concepts

The durable design ideas behind MetaObjects codegen. Generators are disposable;
the metamodel is the spine. This guide is the *why* — the tradeoffs and techniques
you reach for when "it works" needs to become "it works at scale, and the next
person (or LLM) can change it safely."

See also: [ADR-0034 (scaffold-and-own)](../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md),
[ADR-0020 (codegen tiering)](../../spec/decisions/ADR-0020-codegen-tiering-native-vs-neutral.md),
[ADR-0001 (build-time type binding)](../../spec/decisions/ADR-0001-cross-language-type-binding.md).

---

## 1. Pattern-derivable from metadata is codegen — never hand-code

If the metadata fully describes it (FK references, CRUD, validator chains, type-safe
finders, relations), generate it. The only things you hand-write are what metadata
genuinely *cannot* express (regex from outside the model, business logic, and
*irreducible* SQL views — recursive CTEs, window functions, set ops). This is the
raison d'être; when in doubt, generate. **Most SQL views are not irreducible:** a
derived/aggregate read model is an [`object.projection`](source-kinds.md) whose
`CREATE VIEW` DDL is generated from its `origin.*` children — hand-writing that view
is drift, and because an unmodeled view is *unmanaged*, `meta verify --db` can't
even see it.

## 2. You own your codegen (scaffold-and-own)

The library ships the **engine** + a documented **template library**; you copy
templates into your repo and own them. A single standard template set has never fit
across projects — framework conventions, naming, structure, and business patterns are
per-project. Don't fight a black-box generator; own a starting point and edit it.
Choosing and adapting a starting template is a **human/Claude judgment call**, not a
CLI flag. (See ADR-0034.)

For a running start, `meta init` scaffolds a sensible default set —
`codegen/generators/{entity,queries,routes,barrel}.ts`, copied from the reference
templates — and wires `metaobjects.config.ts` to import them locally, so `meta gen`
runs from generators you own from the first run. Each file is written only if absent,
so re-running `meta init --force` never clobbers a hand-edited generator. Importing
those factories from `@metaobjectsdev/codegen-ts/generators` instead is **deprecated**
and slated for removal in a future major — own the local copy.

## 3. Authoring mechanisms — and their tradeoffs

There is no single right way to author a generator. The menu, and when to reach for
each:

| Mechanism | Speed | Readability of output shape | Travels across ports? | Reach for it when… |
|---|---|---|---|---|
| **Direct code** (TS/Java/C#/Python/Kotlin generator) | **Fastest** | Lower — the output is assembled in code; you don't *see* the shape at a glance | No (port-bound) | You want speed + full programmatic power, and complex logic |
| **Mustache template** | Slower | **Highest** — the output shape is right there in the template; easy to read + review | **Yes** — byte-identical across every port's render engine | The output shape matters more than raw speed; you want one template to serve several languages |
| **Groovy** (JVM) | Slower | Medium | JVM | Scriptable JVM authoring without a compile step |
| **Cross-language** (TS/Python emitting Java/C#) | — | — | Yes | One team authors all generators in their preferred language for any target |

**The core tradeoff:** direct code is *far* faster than a template engine, but a
template is *cleaner to look at* — the generated shape is visible in the template
instead of buried in string assembly. Pick speed (direct) when the logic is gnarly or
the run is hot; pick a template (Mustache) when the shape is what you're iterating on,
or when you want the same output across languages. Mustache is also the natural
cross-language bridge: the render engine is byte-identical in every port, so one
template emits identical output anywhere.

## 4. Regeneration strategy — only optimize when it's worth it

A common optimization: **skip regeneration when the output is already up-to-date** —
compare the mtime of the generator code and/or template against the mtime of the
existing generated file, and don't regenerate if the output is newer.

The catch: **it's only worth the effort for the slow paths.** Mustache and Groovy
templates are slow enough that skipping unchanged output is a real win. **Direct-code
codegen is so fast that the skip logic costs more than it saves** — just regenerate
every time. Match the optimization to the mechanism: timestamp-skip for templates,
always-regenerate for direct code.

## 5. Preserving hand edits — one shipped strategy, and two you would build

Generated code is disposable, but people *do* edit it. **MetaObjects ships exactly one
of the three strategies below. The other two are patterns you can build with your own
generators — no shipped generator on any port emits a base/extension or a partial
pair, and no write path is write-if-absent.** Treat 2 and 3 as design options for
generators you author, not as behaviour to expect from `meta gen`.

1. **Three-way merge — SHIPPED (TypeScript only).** Edit the generated file in place; a
   snapshot baseline + `git merge-file --diff3` re-applies your edits on every regen.
   Best when edits are small and scattered through otherwise-generated files. The
   baseline lives in `.metaobjects/.gen-state/` and its **bodies are gitignored**, so
   the merge happens on the machine that generated the file and nowhere else; elsewhere
   an edited file is refused rather than merged. C# and Python refuse rather than merge;
   Java and Kotlin have neither — they check a marker (see
   [own-your-codegen.md](own-your-codegen.md)). Say which of those you mean whenever you
   say "hand edits survive".
2. **Generated base class + your extension — a pattern, not a feature.** Generate a base
   and hand-write a subclass that overrides what you need. Nothing ships this: there is
   no base/subclass pair in any port's generator set, and no generator emits a
   hand-owned half. If you want it, your generator emits the base and you write the
   subclass by hand, once.

   **The one Java output that looks like this pattern isn't it.** `JavaObjectCodeGenerator`
   (registered as `entity`) does emit `abstract class <Base>` alongside `class <Concrete>
   extends <Base>` when the metadata declares an abstract entity with concrete subtypes —
   but both halves are metadata-derived and **both regenerate on every `mvn
   metaobjects:generate` run**; nobody hand-writes the subclass, so it is not a
   hand-owned extension and carries no write-once semantics. It is also off the
   documented mainline: the showcase and `docs/ports/java.md` wire `SpringDtoGenerator`'s
   `<Entity>Dto` record for the entity shape, not this generator. **Kotlin does not
   produce the shape at all by default** — `KotlinEntityGenerator` emits one flat data
   class per concrete entity, and abstract entities are simply skipped. Its opt-in
   `emitAbstractShapes` argument (default `false`) does not create an inheritance pair
   even when enabled: it emits a standalone Kotlin `interface` for the abstract parent,
   with no `implements`/`extends` link back to the concrete data class. Write-once
   semantics of any kind live one layer up, in generator *scaffolding* (`meta init`,
   `meta eject`) — never in generated output on any port.
3. **Partials — a pattern, not a feature.** Where the language supports it (C# `partial`
   classes are the clean case), generate one partial and own another. The C# generators
   emit no `partial` types today, so this is something you would add.

## 6. The extension + git pattern (if you build strategy 2 or 3)

Nothing below is implemented by MetaObjects — it is the **git layout** that makes a
base/extension split pleasant if you author one:

- **The extension** (the subclass / your-side partial you edit): generate it **once**,
  **commit it**, and from then on it's yours. Your generator has to make that "once" real
  — `runGen` accepts a `skip-existing` merge strategy for exactly this shape, but no CLI
  flag selects it, so it is reachable only from a programmatic caller.
- **The base class** (the regenerated half): emit it into a **separate directory** and
  **gitignore it**. It's regenerated on every build, never reviewed, never committed.

This cleanly separates *owned + edited* (committed, stable, in review) from
*regenerated + disposable* (gitignored, invisible). You get full regeneration of the
mechanical half with zero merge noise, and a small hand-owned half that's the only
thing in git and the only thing anyone reads.

## 7. Safety: never clobbering hand edits — by two different mechanisms

The backstop under every strategy above is that the generator will not silently eat your
work. **How it knows is not the same on every port, and the `@generated` header is only
half the story:**

- **TypeScript** decides from `.metaobjects/.gen-state/` — the snapshot body if this
  machine has one (three-way merge), otherwise the committed `.hashes.json` (byte-for-byte
  what we wrote ⇒ overwrite; anything else ⇒ refused, path named, exit 1). The
  `@generated` header is emitted for human readers and **the write decision never reads
  it**. Deleting it does not take ownership of a file — it changes the content, so the
  hash stops matching and the file is refused like any other edit.
- **Java and Kotlin** decide from the header: `GeneratedFileWriter` refuses any existing
  file whose header carries no `GENERATED` marker, and **deleting that line is exactly
  how you take ownership**. A refusal there is a warning, not a build failure.

Both are stated in full, per port, in
[own-your-codegen.md](own-your-codegen.md).

## 8. Bind metadata → native types at build time, never runtime reflection

Resolving an object's native class/module from its FQN happens in **generated code**
(static imports for data-oriented ports; an FQN-keyed registry for OO ports), never via
`Class.forName` / `Type.GetType` / `importlib`. Runtime reflection is impossible in TS
and breaks under GraalVM native-image / .NET AOT. (ADR-0001.)

## 9. Tiering: idiomatic-per-port vs language-neutral-shared

Keep native code generators **per-port and idiomatic** (Drizzle/Zod for TS, EF Core for
C#, Spring for Java/Kotlin, Pydantic for Python) — collapsing them to one generic
emitter is the OpenAPI-Generator trap. Keep language-*neutral* artifacts (migrations,
docs, future OpenAPI/Mermaid) as **one shared engine**. The test: does the output depend
on the implementation language? If yes, it's per-port; if no, it's shared. (ADR-0020.)

## 10. Codegen scopes — object, package, app

MetaObjects codegen has been object-centric (one artifact per MetaObject), but
generation has three natural scopes, and all three are legitimate first-class
patterns. **The scope *is* the walk** — what the generator iterates over:

| Scope | Walks | Emits | Examples |
|---|---|---|---|
| **Object** | each MetaObject | one artifact per object | entity, queries, routes, DTO, repository |
| **Package** | each package (objects grouped by package) | one artifact per package | a service-layer module, a package barrel/index, a package-scoped registry or config |
| **App** | the whole model once | one artifact for the app | a shared component, an app-wide config (e.g. a Spring `@Configuration`), a global object/binding registry, the overall barrel, a whole-model diagram |

**Lineage (the Java predecessor).** App-level generation was first-class there —
`SingleFileDirectGeneratorBase` (one whole-model PlantUML diagram), or overriding
`execute(loader)` to emit a single app config (`KotlinSpringConfigGenerator`), or the
`getFinalWriter()` hook (per-object files *plus* one final app file). Package-level
was *not* first-class even there — it was done ad-hoc, grouping by `getPackage()`
inside a generator's `execute()` (the FR-019 shared-enum aggregation). The newest,
cleanest shape is the cross-port `TemplateGenerator`'s caller-supplied **`walk`
function**: the walk returns the units to render, so per-object / per-package /
whole-model are just different walks.

**The model to expose.** Three scope helpers, so the scope is declared, not buried in
custom iteration:

- **`perEntity(fn)`** — object scope. Runs `fn` once per matched object.
- **`perPackage(fn)`** — package scope: group matching objects by package (packages
  ascending, objects keeping `ctx.entities` order), run `fn` once per package. Groups
  by `effectivePackage` so objects with a bare FQN (FR5d) still bucket correctly.
- **`perModel(fn)`** — app scope: run once over all matching objects. (`oncePerRun`
  is kept as a soft-deprecated alias — "run" is ambiguous under multi-target output;
  `perModel` names the data scope.)

A generator picks its scope by which helper it composes — the same way it picks
object vs model today. Reference templates and the guidance call out the scope each
starting point is for, so "I need a per-package service layer" maps to a clear
pattern instead of hand-rolled grouping.

### Declarative template scopes

A `templateGenerator` can take the scope walk declaratively instead of a hand-written
`walk` — pass `scope` (`"perEntity" | "perPackage" | "perModel"`) plus an
`outputPattern`, and the generator derives the neutral template data dict per unit and
names each file via the pattern. `walk` and `scope` are mutually exclusive — provide
exactly one. The `outputPattern` placeholders are `{name}`, `{Name}`, and `{package}`
(an unknown placeholder throws); `{package}` resolves through `effectivePackage` and
renders `::`-separated segments as nested path directories.

In TypeScript this call goes in `metaobjects.config.ts`'s `generators: [...]` array,
like any other generator — there is no `--template-spec` flag on `meta gen`, because the
config already takes generator values and keeping the declaration there is what keeps
`meta verify --codegen` regenerating WITH it. Worked example, plus how to reuse a
CLI-port JSON spec: [the TypeScript port page](../ports/typescript.md#declarative-template-codegen-mustache).

```ts
templateGenerator({
  name: "entity-doc",
  scope: "perEntity",
  outputPattern: "{package}/{Name}.md",
  template: "entity-doc",
});
```

The same declarative surface is available on the **JVM (Java + Kotlin)** via
`TemplateScopeGenerator` (`com.metaobjects.generator.template`), a Maven-wirable
generator over the byte-equivalent render engine. Wire it as a standard
`<generator>` in `pom.xml` with `<template>`, `<scope>`, `<outputPattern>`,
optional `<format>` (default `text`), and `<templatesDir>` args — no hand-written
walk class. The three scope walks, the neutral data dict, and the output-pattern
grammar are gated byte-identical against the same
`fixtures/template-codegen-conformance/` corpus the TS port passes, so a template
renders identically on either side. This is where **Kotlin** gains a template
generator (it reuses the shared JVM engine — no KotlinPoet involvement).

The **CLI-port surface** (Python and C#) exposes the same declarative
walk through a JSON **template-spec** instead of code/XML wiring — the cross-port
contract shape (`{"generators": [{ name, template, scope, outputPattern, format? }]}`,
JSON-schema'd beside the TS port at
`codegen-ts/src/template-codegen/template-spec.schema.json`). Pass it on `gen`:
`metaobjects gen <metadataDir> --out <dir> --template-spec spec.json --templates <dir>`
(Python), or `dotnet meta gen <metadataDir> --out <dir> --template-spec spec.json --template-root <dir>` (C#).
The named generators are appended to the default suite, resolving template refs
under the templates root (`--templates` in Python, `--template-root` in C#; default
`templates`). `scope` must be one of
`perEntity`/`perPackage`/`perModel` and `format` (when present) one of the
registered escaper formats; a `target` field is **rejected** (the CLI ports have no
output-target concept). The same neutral data dict, output-pattern grammar, and
conformance corpus apply, so a spec renders byte-identically across ports. (Because
a template's output flows through the standard write path — which refuses to
overwrite a file lacking the `@generated` marker — a regenerable template must emit
that header in its own body. The JVM's `TemplateScopeGenerator` writes directly and
carries no such obligation.)

**The spec is auto-discovered.** With no `--template-spec`, both CLI ports read
`<projectRoot>/template-spec.json` (projectRoot = the metadata dir's parent, the anchor
`.metaobjects/` already uses); the flag overrides it. This is what lets `verify --codegen`
regenerate WITH your template generators — it accepts no `--template-spec` of its own, so a
flag-only setup would leave the gate resolving a different generator list from `gen` and
convicting gen's own output. The ports with a code seam (TypeScript, JVM) declare template
generators in the build config the gate already re-runs, reaching the same guarantee a
different way.
