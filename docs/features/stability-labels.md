# Stability labels

Three words describe how settled a piece of MetaObjects is: **stable**, **preview** and
**experimental**. This page lists which pieces carry which word today. It is a list of
facts, not a promise: it adds no support window and no fix time, and it changes nothing in
the [compatibility policy](../compatibility-policy.md), which stands as written.

## What the words mean

| Label | Meaning |
|---|---|
| **stable** | Covered by the compatibility policy. Additive within a MINOR; a break needs a MAJOR (or, for the metadata contract, a `metamodelVersion` major). |
| **preview** | Exempt from that promise. The shape may change in a MINOR, including removals and renames. Promoted on evidence: one external estate running it with the drift gate enforced. |
| **experimental** | New vocabulary that registers, loads and validates, and whose shape may change in a MINOR until generated code runs on it in an adopter estate with the drift gate enforced. A model that declares none of it is unaffected. |

## What carries which label today

| Piece | Label | Where it is defined |
|---|---|---|
| Metamodel, loader, canonical format, registry | stable | [Compatibility policy](../compatibility-policy.md) |
| `meta verify` and its drift gates | stable | [Compatibility policy](../compatibility-policy.md) |
| Prompt render and the reply parser | stable | [Compatibility policy](../compatibility-policy.md) |
| Generators and their generated code in TypeScript, Java, Kotlin, C#, Python and Rust (the Rust crates are ready to publish and not yet published) | supported helpers, compiled and tested against their fixtures; their internals are not a public API | [Own your codegen](own-your-codegen.md), ADR-0034 Amendment 11 |
| Library `ai` | stable | [Libraries](libraries.md) |
| Library `iam` | preview | [Libraries](libraries.md) |
| Angular packages | source-only, on their own `0.6` line, not published | ADR-0048 |
| Business-rules vocabulary: `api.*`, `operation.*`, `binding.*`, `transition.*`, `@permission`, `@public`, and the `rules` and `verify.lifecycle` settings | experimental | [Business rules](business-rules.md), ADR-0066 |
| Reserved names (`transition.timed`, the event and streaming sibling of `api.operational`, `index.fulltext`, `index.vector`, `index.spatial`) | reserved: not in the registry | [Compatibility policy](../compatibility-policy.md) |

## What is not here yet

- **Helper versions.** In 1.3.0 every published package still moves with its registry's
  lockstep line. ADR-0035 Amendment 6 records the ruling that each helper package will carry its
  own version, a stable one starting at `1.x` and a new one at `0.x`, and that existing code moves
  after 1.3.0.
- **A label per generator.** `meta gen --list` prints a `stability` for each library. It does not
  yet print one for each generator, and a generated file carries no stability header.

## Where a label is written

- A library's `stability` is in its manifest and is printed by `meta gen --list`.
- The business-rules label is in the compatibility policy, the CHANGELOG entry for 1.3.0, and
  [Business rules](business-rules.md).
- A port's status is on its page under `docs/ports/`.
