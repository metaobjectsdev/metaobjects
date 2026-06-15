# FR-033 Phase 4 — cross-port fan-out (Java → C# → Python; Kotlin via JVM)

_Status: PLANNED 2026-06-14. Follows the TS strict re-architecture (S0–S3, branch
`fr-033-strict-constraint-model`). Makes the 4 non-TS ports' `registry-conformance`
go RED→green against the strict, description-carrying, constraint-graph
`fixtures/registry-conformance/expected-registry.json`._

## The oracle rule (cross-language-porting skill)
`fixtures/registry-conformance/expected-registry.json` is the (correct, TS-produced)
golden. Port each language to MATCH it. NEVER edit the golden to match a port. If a
fixture looks wrong, escalate — don't silently regenerate. Update the
expected-failures ledger honestly for what isn't done.

## Gap analysis (measured 2026-06-14)
The golden grew (TS S0–S3) to carry, per `type.subType`: `description`, optional
`rules`/`example`/`whenToUse`, the `children` constraint graph (childRules with
cardinality, the `(attr,*,*)` wildcard REMOVED), `parents?`, and **strict
per-subtype attr scoping** (e.g. `@maxLength` only on `field.string`,
`@storage` only on `field.object`, `@autoSet` only on temporal fields,
`@discriminator` only on `object.entity`). Per attr: `description` (+ optional
rules/example/whenToUse) alongside `name`/`valueType`/`isArray`/`required`.

Each non-TS port currently emits only the **v1 manifest** (`types[{type, subType,
attrs[{name, valueType, isArray, required}]}]` + `commonAttrs` + `defaultSubTypes`)
and explicitly EXCLUDES description / children / rules. So all four are RED at the
first type. (Confirmed for Java: `RegistryManifestConformanceTest` fails at
`type: "base"`.)

**Two load-bearing facts that shrink the work:**
1. **The manifest is provider-agnostic.** It emits the COMPOSED per-type view with
   NO `provider` field (provenance is derived at TS doc-gen time, not in the
   manifest). So the **5-concern provider split is an internal Tier-3 detail** — a
   port does NOT need the same provider structure, only the same composed
   per-`type.subType` `{description, attrs, children, parents, rules}`.
2. **Descriptions must be byte-identical to TS.** Hand-maintaining identical prose
   across ports is the exact duplication FR-033 kills. So the correct port reads the
   **shared `spec/metamodel/*.json`** (embedded) for descriptions + the strict
   constraint graph — single-sourced, byte-identical by construction. (Java's
   `TypeDefinition` already has a `description` slot; its `ChildRequirement` likely
   needs a per-attr `description` added. Verify per port.)

## Per-port recipe
For each of Java, C#, Python (Kotlin inherits via the shared JVM `metadata` module):
1. **Embed the shared definitions.** Bundle the repo-root `spec/metamodel/*.json`
   (the 15 provider definition files) as build-time resources / embedded constants
   (the port's existing asset-embed pattern). A byte-identity gate per port.
2. **Read them at registration.** A port-local `defineProviderFromData` equivalent:
   parse the embedded JSON, register each `type.subType` with its strict
   constraints + `description` (+ rules/example/whenToUse) + the `children` graph
   (named attrs → the port's attr-requirement; structural entries → child rules;
   `extendsBase` → additive inheritance; universal `*.*` → common attrs;
   `extends` directives → the port's "extend an existing type" path). Keep the
   port's factories / native bindings / validation passes as code (Tier 2/3).
   - **Strict scoping reconciliation:** the registered per-subtype attr set must
     equal TS's (move attrs off subtypes where TS scoped them away). Java already
     has a per-subtype `ChildRequirement` model (pre-6.0 typesConfig) — reconcile it
     to the JSON, don't reinvent.
   - **Drop the any-attr wildcard** from the registered childRules (strict).
3. **Grow the manifest emitter** to output, in the TS key order: per type
   `description`, optional `rules`/`example`/`whenToUse`, `attrs` (each now with
   `description` + optional doc fields), `children` (the constraint graph: childType,
   childSubType [value|list|`*`], childName, `min?`/`max?` emitted only when defined,
   `named?`), `parents?` (sorted). Match `server/typescript/packages/metadata/src/
   registry-manifest.ts` exactly (key order, sorting, `null` for polymorphic
   valueType, single trailing newline).
4. **Run `registry-conformance`** → byte-match the golden. Iterate the diff.
   Per-port: Java `mvn -q -pl metadata test -Dtest=RegistryManifestConformanceTest -o`;
   C# `dotnet test MetaObjects.Conformance.Tests/...`; Python `uv run pytest tests/conformance/`.
   Kotlin's `codegen-kotlin` RegistryManifestConformanceTest uses the shared JVM
   `metadata` registry — it goes green when Java does (re-verify it after Java).
5. **Enforce placement in validate().** Port the `ERR_CHILD_NOT_ALLOWED`
   structural-child check (Java already has `ValidationPhase` + `acceptsChild`;
   wire the strict check). Misplaced attr → `ERR_UNKNOWN_ATTR` (the ports likely
   already enforce per-type attrs). Fix any port-local fixture that placed an attr
   on a now-disallowed subtype (fix the fixture, not the model — and confirm it's a
   genuine misplacement first).
6. **Expected-failures ledger:** while a port is mid-port (RED), record it honestly.
   The conformance byte-match is all-or-nothing, so intermediate commits stay RED
   until that port completes — expected.

## Sequencing
**Java first** (the pre-6.0 strict typesConfig is the closest existing model; Kotlin
rides its `metadata` module → mostly free, re-verify `codegen-kotlin`), **then C#,
then Python** (mirrors the FR-032 fan-out). Each port is its own multi-step effort
(embed + reader + emitter + scoping reconcile + enforce) — comparable to a slice of
the TS arc. Budget a focused session per port; the byte-match diff is the guide.

## Scale note
This is the largest remaining FR-033 phase — effectively porting the strict model +
description/constraint-graph emission into 3 engines (Java/C#/Python; Kotlin free).
Do it port-by-port with the subagent-driven review discipline; keep the TS reference
(`registry-manifest.ts`, `provider-data.ts`, `constraint-merge.ts`) as the spec.
