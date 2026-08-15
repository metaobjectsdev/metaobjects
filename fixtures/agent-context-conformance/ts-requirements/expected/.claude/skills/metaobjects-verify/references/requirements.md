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
