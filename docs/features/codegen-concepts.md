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
genuinely *cannot* express (custom SQL views, regex from outside the model, business
logic). This is the raison d'être; when in doubt, generate.

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

## 5. Preserving hand edits — pick the strategy that fits the language and the change

Generated code is disposable, but people *do* edit it. Three strategies, each with
per-language variations — choose by what you're protecting:

1. **Three-way merge.** Edit the generated file in place; a committed baseline +
   `git merge-file --diff3` re-applies your edits on every regen. Best when edits are
   small and scattered through otherwise-generated files. (MetaObjects' default for
   generated files; the baseline lives in `.metaobjects/.gen-state/`.)
2. **Generated base class + your extension.** Generate a base, and you write a
   subclass that overrides what you need. The base regenerates freely; your subclass
   is yours. Best when the customization is behavioral and naturally subclassable.
3. **Partials.** Where the language supports it (C# `partial` classes are the clean
   case), generate one partial and own another. Best when the language gives you a
   first-class "split one type across files" seam.

Each port has its own idiom — Java/Kotlin lean on subclass+override seams, C# on
partials, TS on three-way merge or composition. The strategy is a per-project, often
per-artifact choice.

## 6. The extension + git pattern (when you use base-class / partials)

When you go with the base-class/extension strategy, the **git layout** is what makes
it pleasant:

- **The extension** (the subclass / your-side partial you edit): generate it **once**,
  **commit it**, and from then on it's yours — you and the LLM edit it freely; codegen
  never touches it again.
- **The base class** (the regenerated half): emit it into a **separate directory** and
  **gitignore it**. It's regenerated on every build, never reviewed, never committed.

This cleanly separates *owned + edited* (committed, stable, in review) from
*regenerated + disposable* (gitignored, invisible). You get full regeneration of the
mechanical half with zero merge noise, and a small hand-owned half that's the only
thing in git and the only thing anyone reads.

## 7. Safety: the `@generated` header, and never clobbering hand edits

Every generated file carries a `@generated` header. Codegen overwrites only files that
carry it; a file you've taken ownership of (header removed, or a never-generated path)
is never clobbered. This is the backstop under every strategy above — the generator
will not silently eat your work.

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

- **`perEntity(fn)`** — object scope. *(exists)*
- **`perPackage(fn)`** — package scope: group matching objects by package, run `fn`
  once per package. *(the gap — Java never had this cleanly either, so this is an
  improvement on the predecessor, not just parity.)*
- **`oncePerRun(fn)`** — app scope: run once over all matching objects. *(exists; an
  `appLevel` alias can make the intent explicit.)*

A generator picks its scope by which helper it composes — the same way it picks
object vs run today. Reference templates and the guidance call out the scope each
starting point is for, so "I need a per-package service layer" maps to a clear
pattern instead of hand-rolled grouping.
