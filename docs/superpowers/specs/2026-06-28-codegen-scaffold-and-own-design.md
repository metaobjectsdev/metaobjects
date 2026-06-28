# Codegen scaffold-and-own — design (shadcn-for-codegen)

_Status: DESIGN / for sharpening (not yet a plan)._
_Date: 2026-06-28._
_Decision: [ADR-0034](../../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md)._

## 1. Problem

The library ships generators as an imported black box
(`@metaobjectsdev/codegen-ts/generators`); `meta init` scaffolds the config but not
the generators. Reality: **nearly every downstream copies the generators to
customize them** — true of the predecessor Java tool too — because a single template
set never fits across projects (framework conventions, naming, structure, business
patterns are per-project). This contradicts the project's own philosophy ("generated
code is the disposable artifact; templates are user-owned plain TS") and drives the
measured adoption friction: an agent customizes the codegen almost always, and
having to *fork the package* mid-build (or hand-edit output against three-way merge)
is exactly the cost that suppresses adoption.

The proven model is **shadcn/ui**: not a library you import — code you copy into your
repo and own. We adopt it for codegen.

## 2. The model

The library splits into two cleanly-separated things that look alike today:

- **Engine + primitives** (stays in the package, versioned, imported): the
  `Generator` interface, `runGen`, `perEntity` / `oncePerRun`, `RenderContext`, the
  metadata loader, and the render / naming / column-mapper helpers.
- **Templates** (scaffolded into the consumer repo, owned, edited freely): the emit
  logic for `entity` / `queries` / `routes` / `form` / `grid` / `hooks`.

A copied generator imports the primitives but owns the emit:

```ts
// codegen/generators/entity.ts — YOURS, edit freely
import { perEntity, type GenContext } from "@metaobjectsdev/codegen-ts"; // versioned engine
export const entityFile = () =>
  perEntity((entity, ctx: GenContext) => {
    /* owned template logic — emit whatever shape this project wants */
  });
```

```
project/
├── metaobjects/              # the metamodel — the durable spine (unchanged)
├── codegen/
│   ├── generators/           # YOUR generators (scaffolded, owned, customized)
│   │   ├── entity.ts
│   │   ├── queries.ts
│   │   └── routes.ts
│   └── .reference            # provenance: which reference version each was copied from
├── metaobjects.config.ts     # imports ./codegen/generators (NOT the package)
└── ...
```

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
export default defineConfig({ generators: [entityFile(), queriesFile()] });
```

**Forcing it:** the generator emit logic is removed from the public package export.
There is no `import { entityFile } from "@metaobjectsdev/codegen-ts/generators"` —
nothing to fight. `meta init` scaffolds working defaults, so quick-start is intact;
you own the result immediately.

## 3. Mechanism: a documented, growing template library + guidance — *not* a CLI

**The selection and adaptation of starting templates is a human/Claude judgment
task, not CLI automation.** Every project differs; the template set grows over time;
you cannot capture "the right starting point + the right customizations" in CLI
flags without a parameter explosion that still won't fit the next project. So the
intelligence lives in two places that scale — **a documented template library** and
**guidance** — and the actor is a human or Claude, doing plain file operations.

**(a) The template library.** A growing set of reference templates, each a plain
source file plus self-describing guidance (frontmatter or a sibling README):
*"use this when…", "this emits…", "you'll typically customize…", "composes-with…"*.
Adding a new starting point is **adding a documented file**, never a code/CLI change.
The decision data lives *in the templates*, where it scales, not in CLI logic that
would need editing per template.

```
codegen-templates/                         # in the repo / shipped as reference
├── entity/
│   ├── drizzle-entity.ts        # "use when: Drizzle + Postgres; emits: table + Zod; customize: column naming"
│   ├── prisma-entity.ts
│   └── README.md                # the menu + how to choose
├── routes/
│   ├── fastify-crud.ts
│   └── hono-crud.ts
└── ...                          # grows freely — new file + its "use when"
```

**(b) The guidance** (`metaobjects-codegen` skill + agent-context). Teaches the
**decision framework**, not commands: read the project's stack and conventions →
pick (or compose from several) starting templates using their "use when" data →
copy them into `codegen/generators/` → wire the config to import them → customize to
the project. The *mechanics* are plain `read template → write into repo → edit
config`, which Claude does natively and a human does trivially.

**(c) Tooling stays minimal — a running start, not a selector.**
- `meta init` scaffolds the metamodel layout, a **sensible default** generator set,
  and the config wired to import them locally — enough to run immediately. It does
  **not** try to interview the project or select templates.
- That's essentially it. Optional thin conveniences (a `meta codegen list` that just
  prints the library and each template's "use when") are *discovery aids*, never the
  decision-maker, and never carry per-template flags. Copying is `read`+`write`; we
  do not build a parameterized `add`/`configure` surface.

`meta gen` is unchanged — it runs the owned local generators.

## 4. Authoring mechanisms — a menu, all exposed (the consumer/Claude picks)

Owning your codegen is **not one mechanism per port** — it's a menu, and *all options
are exposed*. The library ships reference starting templates in several forms;
guidance helps pick; the consumer copies + owns whichever fits. Several already exist.

1. **Native code generators (full power, idiomatic).** Compose/extend generators in
   the port's own language: TS `Generator` functions; **Java / C# subclass-the-
   generator-class + override seams** (`SpringNaming`, `CSharpNaming`, `appliesTo`,
   protected emit hooks). The Java tool was **built this way already** — extending the
   generator classes is the native model, not a retrofit. Highest power, type-safe to
   the target, with a compile step on the JVM/C#.

2. **Mustache templates (data-driven, cross-port byte-identical).** Author a
   logic-light Mustache template + a payload binding; the render engine emits it.
   Already shipped (`codegen-mustache`, `MetaObjects.Render`, gated by render-
   conformance). Simpler and language-agnostic — and **the same template produces
   byte-identical output through *any* port's render engine**, which makes it the
   natural cross-language bridge.

3. **JVM scripting (Groovy).** On the JVM (Java/Kotlin), author generators in
   **Groovy** — dynamic, no compile step, scriptable. A lighter authoring path than a
   compiled class while still full-power on the JVM.

4. **Cross-language generation.** The metamodel loader *and* the render engine exist
   in every port, so a generator authored in **TypeScript or Python can emit
   Java / C# / Kotlin** (string-emit, or cleanest, via a target-shaped Mustache
   template). Author all your generators in one preferred language regardless of the
   target runtime — e.g. a TS team emitting a C# backend.

**How to pick** (this is the guidance, applied by a human/Claude): native for full
power + target type-safety; Mustache for simple, portable, cross-port output; Groovy
for scriptable JVM authoring; cross-language to author once for any target. Native
classes are port-bound; Mustache and cross-language **travel**.

All four are scaffold-and-own: reference starting points ship in each form; you copy
and own them. The metamodel + engine contracts (loader, `RenderContext`, render
conformance) are identical across ports — only the *authoring form* differs, and the
consumer chooses it.

## 5. Keeping owned forks current — a tool, decided by a human/Claude

shadcn's known pain: once you own a template, upstream fixes don't reach you.
Same principle as §3 — *whether* to take an upstream change is a judgment call (does
this fix matter for my fork?), so we ship a **tool**, not a smart command. We have an
advantage: the three-way merge already shipped for generated files.

- Optionally record, per copied generator, the reference version it came from (a git
  sha or template-version) so a diff has a base. Lightweight provenance, not required
  for the model to work.
- A thin `diff` surface (or just: Claude reads the current reference vs the owned
  file) shows the divergence; the human/Claude **decides** what to pull, and applies
  it (the three-way merge is the mechanical helper, invoked when wanted — not an
  automatic "update everything"). Conflicts are surfaced, never silently resolved.
- Conformance gates the **reference** templates (correct starting points). Owned
  forks are the consumer's; ungated by us.

## 6. Conformance + maintenance

- The reference templates stay byte-gated by the codegen conformance corpus — they
  must be correct scaffolds.
- The engine + primitives stay strictly versioned + tested (this is the stable API).
- Cross-port render/persistence/api-contract conformance is unaffected — it tests the
  *engine + reference output*, which still exist.

## 7. Open questions to sharpen

1. **Hard-remove vs deprecate** the package generator export. Hard-remove is the
   clean "force"; deprecate is gentler for existing consumers. (Lean: deprecate one
   minor, then remove — pre-GA gives latitude.)
2. **Per-mechanism gaps** (the menu in §4 is the answer; what's missing to make each
   first-class + scaffoldable?): native-extend — scaffold-the-class vs override-seam
   ergonomics (Java has it; bring C# to the same first-class level); **Groovy**
   generator support on the JVM (new); **cross-language** emit ergonomics (raw
   string-emit vs a target-shaped Mustache vs a poet-for-Java/C# — what's the
   authoring surface?); which mechanisms get reference starting templates first.
3. **Where templates live**: in-package as copyable assets, or a dedicated
   `@metaobjectsdev/codegen-ts-templates` scaffold package? (Affects how `add` fetches.)
4. **Provenance** (optional, only to give `diff` a base): git sha vs a monotonic
   template-version. Must survive the consumer not having our git history. The model
   works without it; it only sweetens pulling upstream changes.
5. **Granularity**: copy whole generators, or also the shared template *lib* (naming
   overrides, column maps) so those are owned too? Probably yes for the lib that
   shapes output.
6. **Migration** for existing consumers (those importing from the package): a one-time
   mechanical move — Claude (or a human) copies the currently-imported generators into
   the repo and rewrites the config. A thin helper is optional, not required.
7. **Library organization + "use when" schema**: how templates are grouped and how
   each declares its selection guidance (frontmatter fields? a README convention?) so
   the menu stays browsable and self-describing as it grows.

## 8. Scope / phasing

- **Phase 1 (TS) — the bulk of the value, and it's mostly *content*:**
  1. The **template library**: organize the existing generators as documented
     reference templates, each with "use when / emits / customize / composes-with"
     guidance. This is the thing that grows forever.
  2. The **guidance**: rewrite the `metaobjects-codegen` skill + agent-context to
     teach the decision framework (read project → pick/compose → copy → wire →
     customize) and the plain file mechanics — so Claude (or a human) does it.
  3. Minimal tooling: `meta init` scaffolds a sensible default + local-import config;
     deprecate the package generator export.
- **Phase 2:** lightweight provenance + a thin diff helper for pulling upstream
  improvements (decided by human/Claude, not automatic).
- **Phase 3 (compiled ports):** the per-port copy/seam mechanism for
  Java/Kotlin/C#/Python; cross-port docs parity.

The engine is largely unchanged throughout — it already runs arbitrary consumer
generators. The work is **a template library + guidance + a thin `meta init`**, not a
CLI build-out and not new codegen machinery.

## 9. Why this is the right call

- Matches reality (everyone copies) and the project's stated philosophy.
- Proven model (shadcn) loved precisely for ownership + no black box.
- Directly reduces the measured adoption friction (own, in-repo source; no
  fork-mid-build).
- Makes the product boundary honest: the metamodel + engine are the product;
  templates are scaffolding.
