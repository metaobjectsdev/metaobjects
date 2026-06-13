# ADR-0032: Canonical refs are fully-qualified; relative paths are YAML-only

## Status

Accepted (2026-06-13). Pre-1.0 blocker. Defined by FR-026
(`docs/superpowers/specs/2026-06-13-fr-026-canonical-fqn-refs-design.md`).

## Context

Metadata references resolve against a package context, and the four loaders disagreed:
bare names resolved "current-package then fall back to root" (a silent-shadowing
footgun — a root-level type a local shadows is unreachable), `::` meant root-absolute in
TS/Python/C# but prepend-base in Java, and relative navigation was resolved in-place at
resolution time (so a relative ref could survive into the loaded tree). Best-practice
research (PEP 328 removing implicit relative imports; Rust RFC 2126; C++ `::` / C#
`global::` = root; protobuf FQN contract; Canonical XML RFC 3076 expanding prefixes to
full URIs) converges on: no fallback, deterministic per-form resolution, leading-`::` =
root/absolute escape, and a fully-qualified canonical/serialized form with relative
navigation confined to the authoring layer.

## Decision

1. **Resolution is deterministic — no fallback.** Per a ref's declaring package `P`:
   - **bare `Name`** → the current package only (`P::Name`); never a root fallback.
   - **qualified `pkg::Name`** → absolute (full path from root).
   - **`::Rest`** (leading `::`) → root-absolute escape (strip `::`, resolve `Rest`
     from root; reaches an empty-package/root-level type or any absolute path).
   - **`..::Rest`** → parent-relative (drop one package segment per `..::`, then
     resolve; over-drop is an error).
   The FR-024 dotted child suffix (`Owner.child…`) is orthogonal: the owner follows the
   rules above, the `.`-segments traverse child names (ADR-0029).
2. **Leading `::` means root/absolute escape** in all five ports (C++/C#/Rust
   convention) — Java's prepend-base behavior is corrected. This is the deterministic
   way to reference a root-level name a local would otherwise shadow.
3. **Canonical JSON is fully-qualified.** Every ref is a literal FQN (`pkg::Name`, or
   bare `Name` only for a root/empty-package type — i.e. bare in canonical JSON means
   root, not current-package). `::`-leading and `..::` are REJECTED in canonical JSON
   (`ERR_RELATIVE_REF_IN_CANONICAL`). The canonical serializer emits the resolved
   target's FQN, never the raw authored ref.
4. **Relative/sugar forms are YAML-only.** The per-port YAML desugar expands every ref
   to its FQN (using the file's package context) before producing canonical JSON. After
   desugar no relative or current-package-bare ref survives. The single place the §1
   rules live is the desugar; the JSON loader and resolution layer do pure FQN match.

## Consequences

- The shadowing footgun is removed: bare is deterministically current-package; root is
  always reachable via `::Name` (YAML) or the literal FQN (JSON).
- The absolute/relative branches in every port's `resolveSuperRef` (and Java's
  deferred/dotted resolver) are deleted — resolution simplifies to FQN match + the
  FR-024 dotted child traversal.
- The conformance corpus is swept once: every bare/same-package ref in canonical JSON
  fixtures → FQN; serializers emit FQN; YAML conformance gains expansion + the
  `ERR_RELATIVE_REF_IN_CANONICAL` fixtures.
- Authoring ergonomics are unchanged in YAML (`..::common::id` etc. stay valid); only
  the on-disk canonical JSON becomes self-contained.
- Supersedes the informal relative-ref handling that the FR-024 pre-release review
  surfaced as divergent (the Java leading-`::` dotted gap is resolved by this ADR
  rather than patched in place).
