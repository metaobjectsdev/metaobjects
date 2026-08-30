# FR-040 — Codegen ownership is the framework story

_Design. 2026-08-29. Amends [ADR-0034](../../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md) (scaffold-and-own)._

## 1. The claim

**MetaObjects does not need per-framework codegen packages. It needs the ownership
doctrine it already publishes to be true all the way down.**

A codegen library cannot chase frameworks. There are more target frameworks than any
library can carry, they turn over faster than a release line, and every one added is a
permanent maintenance liability that the metamodel — the actual durable asset — gains
nothing from. The project already knows this and already says so in the shipped agent
context:

> Treat this as a first-class, expected activity — not an escape hatch. […] Hand-rolling
> *away from* metadata is the anti-pattern; generating *your own shape from* metadata is
> the point.
>
> — `agent-context/skills/metaobjects-codegen/SKILL.md`

That paragraph is correct and is the whole strategy. This FR is not about adding a
framework. It is about the three places where the product does not yet keep that
promise, each of which was found by trying to adopt onto a framework the default
templates do not target.

**The bar for this work is not "Next.js works." It is: an agent adopting onto a stack
nobody wrote a recipe for — Svelte, Nuxt, Qwik — reaches a working generator unaided,
and treats having done so as normal.**

## 2. How this was found, and the framing error worth recording

A cold adoption probe ran the documented TypeScript quickstart against published
`0.24.4` inside a scratch Next.js 16 / React 19 app on Turbopack, with a real Postgres:
`meta init`, author an entity, `meta gen`, `meta migrate --from-db --apply`, wire an
API, `next build`, then exercise five verbs and the filter grammar over HTTP.

The probe's substantive result was **positive and is not in dispute**: the schema and
server tiers work on that stack unmodified. `queriesFile()` takes `db` as a parameter,
so a React Server Component calls it directly with no HTTP hop. `routesFileHono()` is
deps-injected, which is exactly the shape an App Router Route Handler wants. The full
cross-port API contract held — filters, sort, allowlist, `400` on a declared constraint
violation, fail-closed leading wildcard.

The probe then reported eight "findings," and **most of them were mis-framed as
defects.** The default reference templates target Fastify on Node. That they do not
produce Next.js output is not a bug; it is the templates doing what they say. Recording
the error is the point of this section: the reviewer's instinct was that an adopting
app "almost always creates its own codegen from scratch or copies and modifies starting
templates," and that is both the industry norm and this project's own published
doctrine. A report that treats a template mismatch as a product failure will keep
proposing framework packages forever.

Re-scored honestly:

| # | Probe finding | Correct classification |
|---|---|---|
| 01 | `extStyle: "js"` unresolvable under Turbopack | Config knob the adopter sets. **Skill gap** (§4.3) |
| 02 | Scaffolded routes emit Fastify | Adopter owns it. **Expected**, plus depth gap (§4.2) |
| 03 | No `"use client"` on generated UI files | **Ownership-surface gap** (§4.1) — the UI tier cannot be owned |
| 05 | RSC page silently static-prerenders | Adopter's page + own generator. **Skill gap** (§4.3) |
| 08 | `outDir` assumes `src/` | Config. **Non-issue** |
| **04** | **`@tanstack/react-table` peer `^8.20.0` vs published `latest` `9.2.4`** | **Real library bug** (§4.4) — unrelated to codegen ownership |
| 06 | `meta init` sets `"type": "module"` on the host manifest | Real, minor (§4.4) |
| 07 | Scaffolded `dbImport` points at a file nothing creates | Real, minor (§4.4) |

One real bug and two nits. Everything else is the ownership surface or the skills.

## 3. Why the doctrine did not fire

The doctrine is published, well-argued, and did not help. Three structural reasons,
each verified against the source rather than inferred.

### 3.1 The ownable set stops before the tier where frameworks diverge

```ts
// codegen-ts/src/reference-templates.ts
export const REFERENCE_GENERATOR_NAMES = ["entity", "queries", "routes", "barrel"] as const;
```

Four templates, all server-tier. `formFile()` (`codegen-ts-react`), `tanstackQuery()`,
`tanstackGrid()`, `tanstackGridHook()` (`codegen-ts-tanstack`) and `routesFileHono()`
have **no reference template at all** and can only be imported from their package.

This is exactly inverted. The server tier — a Drizzle table, a typed query helper — is
the *most* portable output the project emits. The UI tier is where React, RSC, Angular,
Svelte and Qwik genuinely disagree about what code should even look like. The tier that
most needs to be owned is the one that cannot be.

### 3.2 Ownership is real, but shallow — the emit is not in the file you own

Every generator in the codebase follows one shape: a **thin generator** and a **fat
renderer**.

| Generator | Thin (ownable shape) | Fat renderer (package) |
|---|---|---|
| `routes` | 70 lines (reference template) | `renderRoutesFile` |
| `form` | 56 lines | `templates/form-file.ts` — 595 lines |
| `tanstackQuery` | 54 lines | `templates/hooks-file.ts` — 557 lines |
| `tanstackGrid` | — | `templates/columns-file.ts` — 239 lines |

The reference templates are precisely the thin half. What an adopter owns today is
**wiring** — which nodes are selected, the output path, the target, the per-entity
opt-out attribute. What they do not own is **the emitted code shape**, which is the
only thing that is framework-coupled.

The shipped `routes` template says so in its own header, honestly:

> To own the composition too, copy `renderRoutesFile`'s body out of the package source.

"Copy the package's internals out" is not the same offer as "this file is yours."
It is the correct instruction today, and it is why ownership stalls at exactly the
moment a framework mismatch makes ownership necessary.

### 3.3 Nothing routes a symptom to the doctrine

A skill fires when something triggers it. Grepping all seven shipped skills:

- **no mention of `extStyle`** as a target-shaped choice (one incidental mention of
  "`extStyle`-aware resolution" in an unrelated passage),
- **no mention of `"use client"`, RSC, Server Components, or a split module graph.**

So the observable symptom carries no route to the doctrine. An agent that sees

```
Error: Module not found: Can't resolve 'fastify'
```

concludes "install fastify" or "this tool is broken." It does not conclude "I own this
generator and should retarget its emit," because nothing in its context connects those.
Worse is finding 03, whose error names a package that **is installed and present** —
`react-hook-form` fails to resolve only because the RSC graph applies the `react-server`
export condition, under which `@hookform/resolvers` declares nothing. That error is
actively misleading without the concept.

## 4. The design

Framework-agnostic throughout. No part of this adds knowledge of a specific framework
to a shipped package.

### 4.1 Extend the ownable set to the UI tier

Add reference templates for the generators that have none: **`form`, `hooks`, `grid`,
`grid-hook`, `routes-hono`.**

The constraint the reference-template mechanism already states carries over
unchanged, and is what makes this cheap:

> The templates import only `@metaobjectsdev/codegen-ts` (the stable engine), so a
> copied file works verbatim with no rewriting.
>
> — `codegen-ts/src/reference-templates.ts`

Generalized: **a reference template imports only its own package's public engine.** A
`form` template imports from `@metaobjectsdev/codegen-ts-react`; a `hooks` template from
`@metaobjectsdev/codegen-ts-tanstack`. The mechanism (`resolveReferenceRoot()` walking
for a `reference/` directory, `files: ["src"]` shipping the assets) is per-package and
already works; each UI package gains its own `src/reference/`.

`meta init` continues to scaffold only the default four, so existing behaviour is
unchanged. The UI templates are obtained on demand (§4.2).

### 4.2 Make the emit ownable, not just the wiring

Two changes, and the second is the one that matters.

**(a) `meta eject <generator>`** — copy a named generator's reference template into
`codegen/generators/` and rewrite the config import to the local path. This is the
existing `init` copy, generalized and available after the fact. It resolves any
generator the registry knows, so it covers UI generators, future generators, and
provider-supplied ones without further work. `meta init` becomes "eject the default
four."

**(b) Promote the render layer to public API.** This is the substantive half. Today the
fat renderers are package-internal, so retargeting means copying 600 lines of internals
out and diverging from every subsequent fix. Instead, export the render functions and
their composable sub-parts, so an owned generator can call the engine for 90% of the
shape and replace only the part its framework disagrees about.

The design rule this establishes:

> **A generator's emit must be reachable as a composition of exported render functions.
> An owned template replaces a step; it never has to fork the pipeline.**

Concretely, an adopter on any RSC-style framework writes:

```ts
// codegen/generators/form.ts — OWNED
import { renderFormFile } from "@metaobjectsdev/codegen-ts-react";
import { perEntity, type Generator } from "@metaobjectsdev/codegen-ts";

export function formFile(): Generator {
  return {
    name: "form-file",
    filter: (e) => e.isEntity,
    generate: perEntity((entity, ctx) => ({
      path: `${entity.name}.form.tsx`,
      // The framework-coupled part is one line the adopter owns.
      content: `"use client";\n` + renderFormFile(entity, ctx),
    })),
  };
}
```

That is the whole fix for probe finding 03, it is written by the adopter, it contains
zero MetaObjects knowledge of Next.js, and it survives regeneration. It also
generalizes: the same one-line prepend is what Qwik (`"use client"` analogues), Angular
(no directive, different imports) or Svelte would each vary in their own way.

**Not chosen:** shipping fat reference templates that inline the renderer. It produces a
600-line copied file that immediately stops receiving upstream fixes — the worst of both
models. Ownership should be cheap to take and cheap to keep.

### 4.3 A diagnostic skill section — "Your framework isn't the default"

Add to `metaobjects-codegen/SKILL.md`. Deliberately a **decision procedure, not a
framework list**, so it serves stacks nobody anticipated:

1. **The templates state their target.** The default reference templates emit for
   Fastify on Node. If that is not your stack, retargeting the generator is the normal
   first move — not a workaround, not a sign of a bug.
2. **Check the target-shaped config first.** `extStyle` (`"js"` for Node ESM and plain
   `tsc`; **`"none"` for any bundler-resolution toolchain** — Vite, Turbopack, webpack,
   esbuild, Rollup), `outDir`, `apiPrefix`, `dialect`, per-generator `targets`. Several
   apparent codegen failures are one config value.
3. **Ask whether your framework splits the module graph.** Some frameworks compile
   server and client from one tree and resolve each half under different conditions
   (React Server Components, Angular universal, Qwik). Where they do, a generated
   artifact that uses client-only APIs may need a marker directive or a distinct import
   path, and the resulting resolution error frequently **names a package that is
   installed** — the failure is the boundary, not the dependency.
4. **If the emit is wrong for your framework, own the generator.** `meta eject <name>`,
   then compose the exported render functions and replace the step that differs.

Point 3 must be stated as a framework-shaped *category* with named examples, never as
a Next.js instruction — the whole value is that it fires on Nuxt.

### 4.4 Fix what survives the reframe

Three items, unrelated to ownership:

- **`@tanstack/react-table` peer range.** `@metaobjectsdev/tanstack` peers `^8.20.0`;
  the published `latest` is `9.2.4`. A plain `npm i @tanstack/react-table` installs v9,
  the tree becomes unresolvable, and **every subsequent install in that project fails**
  with `ERESOLVE` until someone manually pins v8. This is the far side of the 0.21.5
  bounding fix: bounding was right, and the ecosystem moved past the bound. Assess v9
  and either widen the range or state the pin prominently in the grid documentation.
- **`meta init` rewrites the host manifest.** It sets `"type": "module"` unilaterally.
  Next 16 survives it (verified: clean build before and after), so this is a surprising
  mutation rather than a breakage — but a project whose framework owns the manifest
  deserves a narrower touch or a clearer statement of what changed.
- **Scaffolded `dbImport` is dangling and, on a deps-injected stack, unnecessary.**
  `init` writes `dbImport: "../db"` pointing at a file it never creates. On any stack
  using `queriesFile` (db as a parameter) plus a deps-injected routes generator, nothing
  consumes it at all. Consistent with the 0.24.3 direction of demanding it at the point
  of use.

### 4.5 Optional, explicitly not required: a Next.js/Vercel recipe

A `docs/recipes/nextjs-vercel.md` carrying the config delta, the Hono mount, and the
RSC caching note is a **helper**, justified only by that stack's popularity. It is
documentation, never library code, and it must be written so that removing it costs
nothing but convenience. If §4.3 is done well, the recipe is a shortcut past reasoning
the agent could have done itself — which is the correct relationship.

## 5. What is NOT claimed

- **This does not make MetaObjects "support" any framework**, and no shipped package
  gains framework knowledge. An adopter on Svelte still writes their own emit; the claim
  is only that doing so becomes cheap, obvious, and clearly sanctioned.
- **The skill change is unmeasured.** §3.3 establishes that no route from symptom to
  doctrine exists; it does not establish that adding one changes agent behaviour. The
  honest test is §1's bar — an adopting agent on an unanticipated stack — and it has not
  been run. Treat uptake as unproven until it is.
- **§4.2(b) is the risky half.** Promoting renderers to public API widens the supported
  surface permanently and constrains future refactoring of the emit pipeline. That cost
  is real and is the price of the doctrine being true. It should be paid deliberately,
  with the exported surface kept as small as the composition rule allows.
- **The probe covered one bundler.** Turbopack is Next 16's default, but whether webpack
  performs the `.js`→`.ts` rewrite was not tested, so finding 01's blast radius across
  bundlers is asserted from the config's intent, not measured.

## 6. Open questions

1. **How small can the exported render surface be?** The composition rule wants
   sub-steps exported; every export is a compatibility promise. Needs a pass over the
   four fat renderers to find the natural seams before any are made public.
2. **Does `meta eject` need import rewriting beyond the config line?** The thin
   templates import only their package's engine, so probably not — but this must be
   verified per template rather than assumed, since the UI templates are new.
3. ~~**Should `verify --codegen` know about ejected generators?**~~ **ANSWERED: no —
   and the answer is now pinned rather than assumed.** The gate re-runs the same
   `runGen` over the same loaded config, and a generator's provenance (a
   `@metaobjectsdev/*` import, or a local `./codegen/generators/` one) is invisible to
   both, so "what a fresh regen would produce" already means "what the ADOPTER'S
   generator would produce". Ejecting is therefore not drift; editing the owned
   generator is; and the printed remedy converges, because the discriminator is
   `.gen-state/.hashes.json` — a record of what the GENERATOR WROTE — so `meta gen`
   writes through the new generator and re-records the hash. That last point is not
   free: it is exactly where the 0.24.3 hand-edit loop lived, and the two cases must
   not be conflated — a hand edit in a generated FILE is preserved and forgiven, while
   a change to the GENERATOR is real drift until regenerated. Both hold together (a
   preserved hand edit beside a regenerated generator change). None of the nine
   reference templates does project-relative IO, so the temp-tree regen's
   `projectRoot` remapping does not reach them.
   Gate: `cli/test/integration/verify-codegen-ejected-generator.test.ts`. It runs the
   built CLI in a SUBPROCESS per command deliberately — in-process it reports a FALSE
   PASS, because the config is re-read under a fresh temp name each load while the
   `./codegen/generators/entity.js` it imports keeps its stable path in the module
   cache, so the second load silently re-uses the pre-edit generator.
4. ~~**Is `"use client"` ever right to emit by default?**~~ **ANSWERED: a config knob,
   `clientDirective`, defaulted OFF — and never a metamodel attribute.**

   *Not metadata.* ADR-0037's step 0 settles it before "subtype or attribute?" — the
   directive is a fact about the adopter's BUNDLER TOPOLOGY, not about the entity, and
   nothing in the metamodel could derive it. Registered, every non-TS port would carry
   vocabulary it can never dispatch on, which is exactly the `source.rdb @role` mistake
   that retired four members in 0.21.0. It belongs beside `extStyle` and
   `pluralizeCollections`, whose own doc comment states the rule: a per-port codegen
   concern (ADR-0001) is config, not a metadata attribute, and carries no cross-port
   conformance cost.

   *Off by default.* The generated form/hook/grid modules genuinely ARE client
   components, so the directive is a true statement about them — but it is only
   REQUIRED under RSC, and elsewhere it is inert and warned about, so defaulting it on
   would put noise in every generated UI file for the majority to save the minority one
   line. The asymmetry that argued for defaulting on — a runtime error for RSC adopters
   versus a build warning for everyone else — is **what FR-040 itself removed**: the
   question was open because an RSC adopter had no seam at all. Now they have this flag,
   or `meta eject form` and a one-line prepend. The open question answers itself once the
   escape hatch exists.

   *Flipping the default needs evidence, not a majority estimate.* The standard is
   `extStyle` in 0.20.1, where the default moved because the documented quickstart
   provably failed under a stock `tsc --init`. The equivalent trigger here would be the
   quickstart failing on a default Next.js app.

   Scope: one boolean, not per-generator granularity — all four current UI generators
   emit genuinely client-only modules, and §6.1's "defer finer seams until an adopter
   needs one" applies equally. `<Entity>.meta.ts` is deliberately NOT included: it is
   plain data imported BY a client component, and in RSC the boundary is the importing
   component, not everything it reaches. Applied via the exported `withClientDirective`
   so an owned generator does it the same way; gated by
   `codegen-ts-tanstack/test/client-directive.test.ts`, which asserts both halves —
   OFF is byte-identical to omitted, ON is first-token and exactly once.

## 7. Process note

The value of this FR came from a mis-framed report being corrected by someone with the
domain experience to recognise the framing error. The probe's *evidence* was sound and
is reused verbatim above; its *classification* treated normal adoption work as product
failure. The durable lesson is the one already in the skills and worth restating where
release-facing work will see it:

> **A starting template that does not fit an adopter's framework is the template working
> as designed. The product question is never "why didn't it fit" — it is "how quickly can
> they make it fit, and do they know they're allowed to."**
