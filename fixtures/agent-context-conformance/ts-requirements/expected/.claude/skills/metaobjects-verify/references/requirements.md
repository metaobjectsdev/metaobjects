# Requirements — what `meta verify` checks

This project declares `requirement.*` nodes, so `verify` checks them. **There is no
subverb**: requirements are metadata, so they are checked on *every* `meta verify` run.

## The split, and why it matters when you read a failure

| | owns |
|---|---|
| **loader** | `@status` enum, required attrs, child rules, levels — unconditional |
| **`verify`** | `@implementedBy` resolution — **severity depends on `@status`** |

A typo'd `@status` fails the **load** ("failed to load metadata"), before verify runs. If you
see that, no other diagnostic in the run is trustworthy — fix it first and re-run.

## The status asymmetry — the one that surprises people

The **same** unresolved `@implementedBy` reference is:

- an **error** on `live` / `partial` — the model moved and the requirement is stale;
- **allowed** on `planned` — those nodes do not exist YET. That is
  the entry doing its job, not drift.

So on a `planned` entry a dangling reference is the entry doing its job, not drift — do not
"fix" it by deleting the reference, or you delete the plan.

## Exit codes

| situation | exit |
|---|---|
| clean tree, or no `requirement.*` nodes at all | 0 |
| dangling `@implementedBy` on `live`/`partial` | 1 |
| the same reference on `planned` | 0 |
| `@implementedBy` above the L4 link floor | 1 |
| live `requirement.architectural` claimed by nothing | 1 |
| an entity no requirement claims | 0 (warning) |

## The error codes, and the fix for each

Match on the stable `code`, never the message text (ADR-0009). The runtime messages already
name the remedy; this table exists so you can act on one without re-deriving the rule.

| code | what it means | fix |
|---|---|---|
| `ERR_REQUIREMENT_DANGLING_REF` | an `@implementedBy` ref does not resolve in the loaded model, on a status that requires live nodes | the model moved and the claim is stale — repoint the ref, or change the status if the capability really went away. **Check the ref is not merely unloaded**: a source missing from `sources` makes a live node look deleted. |
| `ERR_REQUIREMENT_L5_NOT_MEMBER` | an L5 entry's ref names an OBJECT | move the entry to **L4**, or repoint to a member as `pkg::Owner.member`. Moving the level is usually right — the ref is usually what you meant. |
| `ERR_REQUIREMENT_L4_NOT_OBJECT` | an L4 entry's ref names a MEMBER | the symmetric case — move the entry to **L5**, or repoint at the owning object. |
| `ERR_REQUIREMENT_LINK_ABOVE_FLOOR` | `@implementedBy` on an L1–L3 node | L1–L3 are problem-domain altitude and never reference the model. Push the claim down to the L4/L5 child that actually carries it. |
| `ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS` | a `live`/`partial` `requirement.architectural` that nothing implements | a policy declared and applied to nothing. Claim the nodes it governs, or drop it to `planned` — which is exempt, because it is not applied yet by definition. |
| `ERR_REQUIREMENT_LEVEL_NESTING` | a node's `@level` disagrees with the level of the parent it nests under | nesting IS the hierarchy. Move the node to the right parent rather than editing the level to match where it happens to sit. |
| `ERR_REQUIREMENT_BAD_LEVEL` | `@level` is not an integer inside the allowed range | levels are L1–L5 and nothing else. |
| `ERR_MISSING_REQUIRED_ATTR` | a required attr is absent | `@statement`, `@status` and `@counterexample` are required on both subtypes; `@level` is required on `functional` and optional on `architectural`. |
| `ERR_BAD_ATTR_VALUE` | a closed-enum attr has an unknown value | `@status` and `@disposition` are enforced by the LOADER, so a typo fails the load in every port rather than passing in some. |

**A note on the L4/L5 pair.** They are enforced at the same site and fail for opposite
reasons, so reading only the code you hit can send you the wrong way. The question is not
"is this ref valid?" — usually it is — but "does the LEVEL match the shape of the ref?"

## `verify` does not look at your tests

It used to. `@verifiedBy` asked you to name a test, and `verify` checked that the **name**
occurred somewhere in your test sources. That is existence evidence, never proof — an audit of
one real 19-name ledger opened every named test and found **4 that did not verify their
claim**: one matched a comment, one a dependency-injection key, one a real test of a
*different* claim, and one a test of the entry's output where the claim was about its source
text. `verify` reported zero errors throughout. The author picks the string, so the cheapest
way to satisfy the check is to find any name that already exists.

The attribute is retired. Tying a requirement to a test is the job of a generator that emits
the test **from** the requirement, so the link is structural rather than a name someone chose.

## What a green run does NOT prove

It proves **referential integrity**: statuses parse, levels are in range, links sit at or
below the floor, references resolve.

It cannot prove a status is **true**, or that a node genuinely implements the requirement
claiming it. No test can. That judgement is yours.

Coverage is also narrower than the name suggests: it is checked at **entity grain only** —
`object.value` and `object.projection` are exempt, and fields, views, validators and
identities are never required to be claimed. Green means "every entity is claimed by
something", not "every node is described".

Full reference: the repo's `spec/capability-ledger.md`.
