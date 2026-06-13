# FR-026 — Fully-qualified canonical refs + YAML-only relative paths (design)

_Status: DESIGNED (settled by conversation + best-practice research 2026-06-13). PRE-1.0 BLOCKER — implement now._
_Decision: [ADR-0032](../../../spec/decisions/ADR-0032-canonical-fqn-refs.md)._

## 1. Problem

A metadata reference (`extends`/`super`, `@objectRef`, `@references`, `origin.*`
`@from`/`@of`/`@via` entity part, `@parameterRef`, `@payloadRef`/`@responseRef`, the
FR-024 dotted `Entity.child`) resolves against a **package** context. The four loaders
disagree on how, and the bare-name rule is a silent-shadowing footgun:

- **Bare `Apple` resolves "current-package, then fall back to root."** So if a type
  named `Apple` exists in BOTH the current package and at the root, you can **never
  deterministically reference the root one** — the local always wins, silently. This
  is the exact ambiguity Python 3 removed (PEP 328) and Rust makes a hard error.
- **`::X` means opposite things across ports.** TS/Python/C# strip the leading `::`
  and resolve from root (absolute); Java's `expandPackageFor` does `basePkg + ::X`
  (prepend). Same authored string, different node.
- **Relative navigation (`..::X`) is resolved at RESOLUTION time, in-place, every
  load** in TS/Python/C# (Java expands only on its eager path; its deferred path —
  where cross-file + the FR-024 dotted refs land — skips expansion). So a relative
  ref can survive into the loaded MetaData tree and be re-interpreted differently
  depending on the resolution site.
- The canonical serializer emits the ref **as authored** (bare stays bare), so the
  on-disk interchange form is not self-contained — its meaning depends on a package
  context a reader must reconstruct.

Best-practice research (PEP 328; Rust RFC 2126 "path clarity"; C++ `::`/C# `global::`;
protobuf FQN contract; Canonical XML / RFC 3076) converges on: **no silent fallback;
one deterministic rule per form; leading-`::` = root/absolute escape; and the
canonical/serialized form is fully-qualified, with relative navigation living only in
the authoring layer** (XML-C14N expands prefixes to full URIs; protobuf makes FQN the
contract).

## 2. Decision (Option A — the protobuf/XML-C14N model)

### 2.1 Authoring forms (YAML, and JSON in the limited cases below)

Resolution is **deterministic — no fallback chain.** Given a ref's declaring node's
package context `P`:

| Form | Meaning | Example (`P = acme::fruit`) |
|---|---|---|
| **bare** `Name` (no `::`, no leading `.`) | the type `Name` in the **current package** `P` — and ONLY there (no root fallback) | `Apple` → `acme::fruit::Apple` |
| **qualified** `pkg::Name` (contains `::`, no leading `::`/`..`) | **absolute** — the fully-qualified path from root | `acme::common::Base` → that exact node |
| **root-absolute** `::Rest` (leading `::`) | **absolute, escape to root**: strip the `::`, resolve `Rest` as a full path from root (reaches an empty-package/root-level type or any absolute path) | `::Apple` → root-level `Apple`; `::other::X` → `other::X` |
| **parent-relative** `..::Rest` (one or more leading `..::`) | drop one package segment from `P` per `..::`, then resolve `Rest` (bare-in-that-package or qualified) against the reduced package; over-drop → error | `..::veg::Carrot` (from `acme::fruit`) → `acme::veg::Carrot` |

The **dotted FR-024 child suffix** (`Owner.child.grandchild`) is orthogonal: the owner
part follows the table above; the `.`-segments traverse child names (ADR-0029,
unchanged). So `::acme::sales::Customer.id` = root-absolute owner `acme::sales::Customer`
→ child `id`.

**The footgun is dead:** bare is always exactly the current package (deterministic);
the root is **always** reachable via `::Name` (escape) or its full `pkg::Name`. Nothing
silently falls back. `::` keeps the universal C++/C#/Rust meaning (root/absolute escape).

### 2.2 Canonical JSON = fully-qualified, no relative navigation

Canonical JSON is the on-disk **interchange** form (ADR-0006). It MUST be
self-contained:

- **Every ref is a literal fully-qualified name.** A packaged type is `pkg::Name`; a
  root/empty-package type is bare `Name`. (Bare in canonical JSON therefore means
  **root-level**, not current-package — there is no package-context magic in the JSON
  reader.)
- **`::`-leading and `..::`-relative forms are REJECTED** in canonical JSON →
  `ERR_RELATIVE_REF_IN_CANONICAL` (new code). They are authoring sugar that the YAML
  desugar must have already expanded.
- The **canonical serializer emits the RESOLVED target's FQN** (`superResolved.fqn()`,
  and `<ownerFQN>.<childTail>` for dotted child refs), never the raw authored string.
  So a load → serialize round-trip of any YAML/JSON input yields FQN-only canonical
  JSON.

### 2.3 YAML desugar expands relative → FQN

The per-port YAML desugar (it already knows the file's `package`) expands every ref per
§2.1 to its FQN **before** producing canonical JSON. After desugar, no `::`-leading /
`..::` / bare-current-package ref survives — every ref is FQN. This is the single place
the §2.1 rules live; the JSON loader and the resolution layer never do relative
navigation again.

### 2.4 Resolution layer simplifies

`resolveSuperRef` (and the Java deferred/dotted resolver) lose their absolute/relative
branches entirely — they do **pure FQN match** against the tree (plus the FR-024 dotted
child traversal on an already-FQN owner). The `::`-strip, `..::`-reduce, and
bare-current-then-root-fallback code is deleted in all four ports.

## 3. Scope / blast radius (this is large — pre-1.0, do it once)

1. **YAML desugar (4 ports):** add ref-expansion (bare→`P::Name`, `::`→strip,
   `..::`→reduce, qualified→unchanged) for every ref-bearing attr.
2. **Canonical serializer (4 ports):** emit `superResolved.fqn()` / resolved FQN for
   every ref, not the raw string.
3. **JSON loader / resolution (4 ports):** pure-FQN resolution; reject `::`/`..::` in
   canonical JSON (`ERR_RELATIVE_REF_IN_CANONICAL`); delete the relative branches.
4. **Conformance corpus sweep:** every bare/same-package ref in `fixtures/conformance/`
   (and persistence/api-contract/render corpora) `input/*.json` and `expected*.json` →
   FQN against the file's declared package. Ref-bearing attrs: `extends`/`super`,
   `@objectRef`, `@references`, `origin.passthrough.@from`, `origin.aggregate.@of`
   (entity part), `@via` (entity part), `@parameterRef`, `@payloadRef`,
   `@responseRef`, the FR-024 dotted `Entity.child`. (Counts: ~67 bare `extends` +
   many bare `@objectRef`/etc.) Mechanical but broad; script + oracle-regenerate.
5. **YAML conformance:** add fixtures proving each §2.1 expansion form desugars to the
   correct FQN; add a canonical-JSON error fixture asserting `::`/`..::` →
   `ERR_RELATIVE_REF_IN_CANONICAL`.
6. **Unit tests:** the 14 TS + 3 Python prefix resolution unit tests move to test the
   **desugar** (input form → FQN), not the resolver.
7. **Docs:** `..::common::id` stays a valid YAML authoring example (METAMODEL.md,
   FORGE-METADATA.md, agent-docs/body.ts) — but show the canonical-JSON FQN it lowers
   to; note bare = current-package (YAML) / root-level (canonical JSON).
8. **`ERROR-CODES.json`** + all 5 ports' error enums gain
   `ERR_RELATIVE_REF_IN_CANONICAL`.

## 4. Sequencing

TS reference first (desugar + serializer + loader + corpus sweep of the shared
fixtures), then the cross-port fan-out (Java/Kotlin → C# → Python) against the swept
corpus, then the YAML/error fixtures, then docs. Each port: read the TS reference, do
not re-derive. Commit per slice; `main` green at every step.

## 5. Open items (settle at planning)

1. Exact canonical FQN form for a dotted child ref in JSON (`<ownerFQN>.<childTail>` —
   confirm the serializer/loader agree byte-for-byte across ports).
2. Whether `@via`/`@from` dotted **relationship/field paths** (`Program.weeks`,
   `Customer.id`) get their entity head qualified to FQN too (they should, for the
   same self-contained-JSON reason) — confirm the path-walker reads FQN heads.
3. Migration of the FR-024 dotted same-package refs (`Customer.id` → `pkg::Customer.id`
   in canonical JSON) in the just-shipped FR-024 fixtures.
4. Whether `super`/`extends` and `@objectRef` should share one ref-expansion helper
   per port (yes — one `expandRef(raw, packageContext)` used everywhere).
