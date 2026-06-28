# ADR-0034: Codegen is scaffold-and-own — the library ships the engine; templates are copied into the consumer repo

## Status

Proposed (2026-06-28). Design: `docs/superpowers/specs/2026-06-28-codegen-scaffold-and-own-design.md`.
Reframes the codegen adoption model; does not change the metamodel or the wire/conformance contracts.

## Context

The library ships built-in generators (`entityFile`, `queriesFile`, `routesFile`,
`formFile`, …) that consumers import from `@metaobjectsdev/codegen-ts/generators`
and wire in `metaobjects.config.ts`; `meta init` scaffolds the *config* but not the
generators. The implicit model is "consume our templates; customize when needed."

Two observations falsify that model:

1. **Empirically, nearly every downstream project copies the generators to customize
   them** — the same pattern held in the predecessor Java-only tool. A single
   standard template set that fits across projects has never worked; framework
   conventions, naming, structure, and business patterns are per-project. The
   "OOTB templates that fit everyone" promise is one adopters routinely abandon.
2. **It contradicts the project's own stated philosophy** — "the metamodel is the
   durable spine; generated code is the disposable artifact; templates are
   user-owned plain TS." The docs teach import-the-black-box; the philosophy says
   own-your-output. The docs are wrong, not the philosophy.

This also drives measured **adoption friction**: an AI agent (a primary audience)
customizes the codegen almost always, and discovering mid-build that it must *fork
the package* — or hand-edit generated output and fight three-way merge — is exactly
the friction that suppresses adoption. The proven prior art is **shadcn/ui**: "not a
component library — code you copy into your project and own."

## Decision

1. **Split the engine from the templates.** The library's public, versioned API is
   the **engine + primitives**: the `Generator` interface, `runGen`, `perEntity` /
   `oncePerRun`, `RenderContext`, the metadata loader, and the render/naming/
   column-mapper helpers. The **templates** — the emit logic for entity/queries/
   routes/form/grid/hooks — are **not** a public import; they are reference scaffold
   source.

2. **Scaffold-and-own is the default and only taught path — driven by human/Claude
   judgment, not a CLI.** Choosing and adapting starting templates is a judgment call
   over infinite per-project variation; it cannot be captured in CLI flags. The
   intelligence lives in **a documented, growing template library** (each template
   self-describes *"use when / emits / customize / composes-with"*) and in
   **guidance** (the `metaobjects-codegen` skill + agent-context teach the decision
   framework: read the project → pick/compose → copy → wire → customize). The actor —
   a human or Claude — does the copy + config wiring with plain file operations. A
   copied generator imports the *primitives* from the package but **owns the emit
   logic**. Tooling stays minimal: `meta init` scaffolds a sensible default generator
   set + local-import config for a running start; it does **not** interview the
   project or select templates. **Adding a new starting point is adding a documented
   file, never a CLI change.**

3. **"Force" by making generators scaffold-only — there is no black-box to fight.**
   The generator emit logic is removed from the public package surface; you cannot
   `import { entityFile } from "@metaobjectsdev/codegen-ts/generators"`. The
   reference generators remain in-repo as the scaffold source and the
   conformance-gated reference.

4. **Conformance gates the reference templates, not consumer forks.** The scaffolded
   reference templates stay byte-gated by the codegen conformance corpus (they must
   be correct starting points). A consumer's owned fork is theirs and ungated. The
   engine + primitives stay strictly versioned and tested.

5. **Authoring is a menu — all options exposed, not one mechanism per port.** Owning
   your codegen can be: **native code generators** (compose/extend the generator
   classes — the model the Java tool was already built on; with `SpringNaming` /
   `CSharpNaming` / `appliesTo` / protected emit seams), **Mustache templates**
   (data-driven, cross-port byte-identical — already shipped via `codegen-mustache` /
   `MetaObjects.Render`), **Groovy** scripting on the JVM, or **cross-language
   generation** (a TS/Python generator emitting Java/C#/Kotlin, since the metamodel
   loader *and* render engine exist in every port). The library ships reference
   starting points in each form; the consumer/Claude picks. Native classes are
   port-bound; Mustache and cross-language travel. This dissolves the "compiled ports
   are awkward to copy" concern — Mustache and cross-language give clean, owned,
   portable options alongside extend-the-class.

6. **Upstream improvements reach owned forks via diff/update**, reusing the existing
   three-way merge the library already ships for generated files: `meta codegen
   diff` / `update` reconcile an owned generator against the current reference,
   tracking the reference version the fork was copied from.

## Consequences

- The product boundary becomes honest: **the metamodel + the engine are the
  product; templates are scaffolding.** Marketing/docs/skills reposition from
  "use our generators" to "own your generators."
- First-run still works (init scaffolds defaults), so the pivot costs no quick-start.
- Adoption friction drops: the agent/dev edits owned, in-repo source; no
  fork-mid-build, no merge-fighting.
- Cost is mostly **content, not code**: organizing the generators into a documented
  template library, rewriting the docs/skills/agent-context to teach the decision
  framework, and a thin `meta init` change. The **engine is largely unchanged** — it
  already runs arbitrary consumer generators — so this is a repositioning, not a
  rewrite, and explicitly **not** a CLI build-out.
- New obligations: owned forks don't auto-receive fixes (diff/update mitigates, not
  eliminates); the compiled-port copy story risks feeling inconsistent with TS until
  designed; we must track template provenance (which reference version was copied)
  for update to work.
- TS ships first (cleanest, proves the model); the compiled-port story follows.
- Open: whether to hard-remove the package generator export or deprecate it; the
  exact compiled-port mechanism per language; whether templates live in-package as
  assets or in a dedicated scaffold package. Tracked in the design doc.
