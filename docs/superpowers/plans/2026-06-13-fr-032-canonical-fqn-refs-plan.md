# FR-032 — Canonical FQN refs: implementation plan

> Spec: `docs/superpowers/specs/2026-06-13-fr-026-canonical-fqn-refs-design.md`; ADR-0032.
> Pre-1.0. Slices land on `main`, green at each step. TS reference first, then fan out.

## Ref-bearing attrs (the full set the change must cover)

`extends`/`super` (structural), and the type/entity-reference attrs:
`@objectRef`, `@references` (identity.reference), `origin.passthrough.@from`,
`origin.aggregate.@of`, `@via` (entity head of the dotted relationship path),
`@parameterRef`, `@payloadRef`, `@responseRef`. The FR-024 dotted `Entity.child`
suffix rides on `extends`/`@from`/`@of`/`@via`.

## The one shared primitive

`expandRef(raw, packageContext) → fqn` implementing ADR-0032 §1 (bare→`P::name`,
`::Rest`→strip-to-root, `..::Rest`→reduce, qualified→unchanged; preserve any
`.child` suffix on the tail). One helper per port, used by BOTH the YAML desugar
(authoring expansion) AND a JSON-input validation that REJECTS a still-relative ref
(`::`/`..::`) with `ERR_RELATIVE_REF_IN_CANONICAL`. Canonical JSON is assumed already
FQN; the validation is the guard.

## Slice T (TS reference) — phases

**T1 — `expandRef` + unit tests.** New `src/naming-refs.ts` (or fold into `naming.ts`):
`expandRef`, `isRelativeRef` (leading `::`/`..::`). Port the 14 super-resolve prefix
unit tests to drive `expandRef` (input form → FQN) instead of the resolver. RED→GREEN.

**T2 — desugar wiring.** In `core/parser-yaml.ts` desugar, expand every ref-bearing
attr (the list above) via `expandRef(raw, filePackage)` so the produced canonical JSON
is FQN. (YAML knows the file `package`.)

**T3 — JSON-input guard + resolution simplify.** In `parser-core.ts` (the JSON path)
+ `super-resolve.ts`: reject `::`/`..::` refs in canonical JSON
(`ERR_RELATIVE_REF_IN_CANONICAL`, add to errors.ts + ERROR-CODES.json); DELETE the
absolute/relative branches in `resolveSuperRef` (pure FQN match + FR-024 dotted child
traversal remains). Apply the same FQN-or-reject rule to the validation-pass resolvers
for `@objectRef`/`@from`/`@of`/`@via`/`@references`/`@parameterRef`.

**T4 — serializer emits FQN.** `serializer-json.ts:110` emit `model.superResolved.fqn()`
(fall back to `superRef` only if unresolved) so a round-trip yields FQN. Confirm the
other ref attrs already serialize their (now-FQN, post-sweep) string verbatim.

**T5 — corpus sweep (shared fixtures).** Script: for every `fixtures/conformance/`
(+ persistence/api-contract/render) `input/*.json` + `expected*.json`, qualify each
bare/same-package ref-bearing attr to FQN against the file's declared `package`
(root-level/empty-package types stay bare). Regenerate goldens via the TS oracle. The
diff must be ONLY ref-qualification — STOP if anything else changes.

**T6 — fixtures + gate.** New YAML-conformance fixtures: each `expandRef` form
(`::`/`..::`/bare/qualified) desugars to the right FQN; a canonical-JSON error fixture
asserting `::`/`..::` → `ERR_RELATIVE_REF_IN_CANONICAL`. Full `cd server/typescript &&
bun test` green; typecheck; registry-conformance byte-identical.

## Cross-port fan-out (after Slice T reviewed green)

Per port (Java/Kotlin → C# → Python), read the TS reference; implement `expandRef`
+ desugar wiring + JSON guard + serializer FQN + resolution simplify; run against the
already-swept shared corpus (no per-port corpus edits — the corpus is shared and swept
once in T5); the FQN serializer must round-trip byte-identical. Java specifics: fold
`expandPackageFor` into the canonical `expandRef` semantics (fix `::`=prepend → `::`=
root-absolute), and make the deferred/dotted path use the expanded ref (closes the
review's leading-`::` Java gap by construction). Update each port's error enum with
`ERR_RELATIVE_REF_IN_CANONICAL`. Un-ledger nothing new; this should be byte-identical
cross-port once the corpus is FQN.

## Docs (last)

`..::common::id` stays a valid YAML example (METAMODEL.md, FORGE-METADATA.md,
agent-docs/body.ts) — annotate the canonical-JSON FQN it lowers to; note bare =
current-package (YAML) / root-level (canonical JSON). Regenerate agent-context corpus
if body.ts changes.
