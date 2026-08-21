# Requirements — what `meta verify` checks

This project declares `requirement.*` nodes, so `verify` checks them. **There is no
subverb**: requirements are metadata, so they are checked on *every* `meta verify` run.

## The split, and why it matters when you read a failure

| | owns |
|---|---|
| **loader** | `@status` enum, required attrs, child rules, levels — unconditional |
| **`verify`** | `@implementedBy` / `@verifiedBy` resolution — **severity depends on `@status`** |

A typo'd `@status` fails the **load** ("failed to load metadata"), before verify runs. If you
see that, no other diagnostic in the run is trustworthy — fix it first and re-run.

## The status asymmetry — the one that surprises people

The **same** unresolved `@implementedBy` reference is:

- an **error** on `live` / `partial` — the model moved and the requirement is stale;
- **allowed** on `abandoned` / `superseded` — those nodes are *supposed* to be gone. That is
  the entry doing its job, not drift.

So do not "fix" a dangling reference on an abandoned requirement by deleting it. Deleting it
destroys the record that something was deliberately retired, which is the single thing this
mechanism exists to preserve.

## Exit codes

| situation | exit |
|---|---|
| clean tree, or no `requirement.*` nodes at all | 0 |
| dangling `@implementedBy` on `live`/`partial` | 1 |
| the same reference on `abandoned`/`superseded` | 0 |
| `@implementedBy` above the L4 link floor | 1 |
| live `requirement.architectural` claimed by nothing | 1 |
| `@verifiedBy` naming a test that exists nowhere | 1 |
| `@verifiedBy` naming a name found only in an **unrecognised** test file | 0 (warning) |
| `@verifiedBy` naming a test that is **skipped** | 0 (warning) |
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
| `ERR_REQUIREMENT_TEST_MISSING` | `@verifiedBy` names a test found nowhere | the test was renamed or deleted. If your project's test convention is simply unrecognised, declare it in `verify.testFiles` rather than deleting the claim. |
| `ERR_MISSING_REQUIRED_ATTR` | a required attr is absent | `@statement`, `@status` and `@violation` are required on both subtypes; `@level` is required on `functional` and optional on `architectural`. |
| `ERR_BAD_ATTR_VALUE` | a closed-enum attr has an unknown value | `@status` and `@disposition` are enforced by the LOADER, so a typo fails the load in every port rather than passing in some. |

**A note on the L4/L5 pair.** They are enforced at the same site and fail for opposite
reasons, so reading only the code you hit can send you the wrong way. The question is not
"is this ref valid?" — usually it is — but "does the LEVEL match the shape of the ref?"

## What counts as a test file is YOUR project's call

The scan ships patterns for jest/vitest/bun, JUnit, Maven Failsafe (`*IT`), xUnit/NUnit,
pytest and Kotlin. Those are a convenience, **not an authority** — a built-in list is a guess
about your repository, and a wrong guess reports a real test as a broken claim. Declare your
conventions and they are added to the built-ins:

```ts
// metaobjects.config.ts
export default defineConfig({ verify: { testFiles: ["**/*IT.kt", "**/*.feature"] } });
```

If a named test is missing from the corpus but present in some other source file, `verify`
warns and names that file rather than failing — an unrecognised convention is the tool's
ignorance, not your mistake.

## What a green run does NOT prove

It proves **referential integrity**: statuses parse, levels are in range, links sit at or
below the floor, references resolve, named tests exist and are not skipped.

It cannot prove a status is **true**, or that a node genuinely implements the requirement
claiming it. No test can. That judgement is yours.

Coverage is also narrower than the name suggests: it is checked at **entity grain only** —
`object.value` and `object.projection` are exempt, and fields, views, validators and
identities are never required to be claimed. Green means "every entity is claimed by
something", not "every node is described".

Full reference: the repo's `spec/capability-ledger.md`.
