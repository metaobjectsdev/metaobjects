# Cross-Language MetaData Spike — Findings

**Date:** 2026-05-15
**Spike:** C# + Python implementations of the `MetaData` / `MetaObject` / `MetaField`
node model, validating the TypeScript typed-tree design (metadata rebuild Phase 1).

## Result

Both spikes implement the abstract `MetaData` base + concrete `MetaObject` /
`MetaField`, with super-chain effective children and a frozen-gated read cache,
and pass a smoke check proving `MetaObject.fields()` returns the effective
(own + inherited) set, `ownFields()` excludes inherited, and accessor results
are memoized after freeze.

- **C#** — `Program.cs` smoke check passes (`dotnet run`).
- **Python** — `test_spike.py` passes (`python3 -m unittest`).

## C#

Direct port — `abstract class MetaData` + `class MetaObject : MetaData` +
`class MetaField : MetaData`. Java-like inheritance throughout.

**Friction observed:** None. `net8.0` with `Nullable` and `ImplicitUsings`
enabled made the port clean. The generic `Cached<T>(key, compute)` helper on the
abstract base behaves identically to the TS pattern — pre-freeze calls compute
fresh, post-freeze calls return the memoized reference (which is what makes the
`ReferenceEquals` caching assertion pass). The `EffectiveChildren()` super-chain
walk is a direct structural port of the TS node model.

## Python

Direct port — `class MetaData(abc.ABC)` + `class MetaObject(MetaData)` +
`class MetaField(MetaData)`.

**Friction observed:** None. `from __future__ import annotations` on Python 3.10
handled forward references cleanly without `TYPE_CHECKING` guards. The stdlib
(`abc.ABC`, `typing`) covered everything — zero third-party dependencies.

## Feedback into the TS Phase 1 spec

None required. The typed-tree design — abstract node base + concrete node
subclasses, super-chain effective children, effective-by-default accessors with
`own*` variants, and a frozen-gated per-instance read cache — ports cleanly and
without surprise to both inheritance languages. The TS Phase 1 typed-tree-core
spec is confirmed; no change is needed before executing it.

## Out of scope / deferred

- **Rust and Go** were dropped after a business-value review: metaobjects'
  codegen pillar is largely redundant against Rust's proc macros (in-language
  codegen) and weakly differentiated against Go's `ent` / `sqlc`; neither has a
  consumer in the portfolio. Revisit only on real polyglot-consumer demand — and
  a Rust target would likely be a different product shape (a derive-macro crate
  consuming the shared metamodel), a separate strategic decision.
- **Codegen** portability is a separate concern from the node model and is
  deferred to a future, separate effort. This spike validated the node model
  only — and confirmed the metamodel vocabulary is language-agnostic; only a
  language's in-memory representation is its own business.

## Disposition of the spike code

The C# (`metaobjects/csharp/`) and Python (`metaobjects/python/`) node classes
are not throwaway — they are the seed of the real C#/Python implementations and
should be carried forward when the polyglot roadmap reaches those languages.
