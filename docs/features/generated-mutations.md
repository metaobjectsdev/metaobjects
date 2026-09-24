# Generated mutations — create, partial patch, delete, and `@autoSet` stamping

The generated data-access surface gives you `create`, a **partial-update patch**,
and `delete` per entity — driven entirely by the metadata, so a renamed or dropped
column is a build error, not a silent write. This page is the durable **contract**
(identical in every port) plus the per-port shape it takes.

> The one rule that saves the most hand-written code: **never hand-write a
> single-column `UPDATE`.** Use the generated patch. A hand-maintained setter is a
> place the column list can typo, drift from the metadata, or silently revert a
> concurrent writer's column. The generated patch touches only what you assign.

## Why partial patch, not full-row update

A full-row `update(model)` writes *every* column, which forces a read-modify-write
and is a **lost-update hazard**: between the read and the write, another writer's
change to an *unrelated* column is silently reverted, because the full row carries
stale values for every column you didn't touch. Partial patch removes both
problems — the SQL `SET` clause contains only the columns you assigned (a single
statement, no read-first), so disjoint concurrent writes don't clobber each other.

## The patch contract (identical in every port)

The surface syntax is per-port idiomatic (native codegen, not the shared engine),
but the semantics are one contract — call them **PATCH-1..7** (FR-035):

- **PATCH-1 (subset).** A patch is a set of `field → value` assignments over an
  entity's *settable* fields. Exactly the assigned columns are written; **absent
  fields are untouched.**
- **PATCH-2 (tristate — absent ≠ null).** An explicit `null` sets the column NULL
  and is valid only on a non-`@required` field (else a validation error). An
  *omitted* field is left alone. This is JSON-Merge-Patch present-key semantics
  with `null` meaning *set null*, not *delete*.
- **PATCH-3 (settable set).** Never settable: the primary key, the TPH
  discriminator, `@mutability: "readOnly"` fields, `@mutability: "writeOnce"` fields
  (settable on POST, frozen thereafter), `origin.*`-derived fields.
  `@autoSet:onUpdate` columns are stamped server-side regardless of the caller;
  `@autoSet:onCreate` columns are not patch-settable.
  **A non-settable key present in a PATCH body is STRIPPED, not rejected.** The
  generated `<Entity>UpdateSchema` is a plain `z.object()` (never `.strict()`) that
  simply omits every non-settable field, and Zod drops unknown keys — so
  `safeParse` succeeds and the key never reaches the `SET`. The TPH discriminator
  is additionally deleted by hand after parse, the same convention. A malformed
  *value* on a settable key is still `400 {"error":"validation"}`.
  This matters for `writeOnce` specifically: the generated edit form submits EVERY
  registered field (`handleSubmit` passes all values, and 0.19.2 switched the
  resolver to `UpdateSchema` on edit rather than diff-and-omit), so rejecting a
  present-but-frozen key would fail every save on every generated edit form for an
  entity carrying one.
- **PATCH-4 (validation).** Assigned values run the same per-field validation and
  the same write codec as `create`.
- **PATCH-5 (empty patch).** A body that strips to zero *caller* assignments answers
  `200` with the current row — never a `400`, and never an empty-`SET` SQL error.
  Note how this meets PATCH-3: the server-side `@autoSet:onUpdate` stamp is itself an
  assignment, so on an entity carrying one the `SET` is never actually empty and an
  ordinary write runs (bumping that column, as it does for any other patch). The
  literal zero-assignment read-back path is reachable only for an entity with **no**
  onUpdate column. Both routes answer identically, which is what makes the contract
  stable; what a port must not do is let the caller's empty set decide the status.
  Gated cross-port by `fixtures/api-contract-conformance/scenarios/patch-empty-noop.yaml`.
- **PATCH-6 (result).** The patch returns the full updated row (`RETURNING`, or a
  same-transaction re-read); a missing row is the port's not-found idiom
  (`null` / `Optional.empty` / `404`).
- **PATCH-7 (verbs).** At the HTTP tier both `PATCH` and `PUT` route to the update
  handler with partial-merge semantics. True PUT-as-full-replace is out of scope.

The generated update does **not** guard against a concurrent write: two callers
patching the same row both succeed, and the last one wins. Adding that guard is
adopter-owned — see [Optimistic concurrency](#optimistic-concurrency-adopter-owned).

## The generated surface, per port

All of these are **generated output** — what an adopter calls.

**TypeScript** — the update function is already partial; it is typed against
`<Entity>Patch` (a compile-safe partial shape) and validates through
`<Entity>UpdateSchema`:

```ts
export async function updateAuthor(db: Db, id: number, patch: AuthorPatch): Promise<Author | null> {
  const validated = AuthorUpdateSchema.parse(patch);
  if (Object.keys(validated).length === 0) return findAuthorById(db, id); // PATCH-5
  const [author] = await db.update(authors).set(validated).where(eq(authors.id, id)).returning();
  return author ?? null;
}

await updateAuthor(db, 42, { bio: "…" });   // writes ONE column; a renamed field is a compile error
```

**Kotlin** — the generated repository ships both a full `update(id, dto)` and a
`patch` that takes the Exposed statement lambda, so a renamed/dropped column is a
compile error at the call site:

```kotlin
repo.patch(id) { it[Authors.bio] = "…" }     // touches only what you set
```

**Java** — the repository interface gains `Optional<Dto> patch(PkType id, <Entity>Patch patch)`;
the controller binds the partial JSON body via `<Entity>Patch.fromJson` (presence-tracked)
and delegates to `repository.patch`, so an omitted key is never written.

**Python** — the generated FastAPI route binds the raw JSON body (the set of
*present* keys — the tristate signal) and validates the present values against the
generated `<Entity>Patch` model before delegating to the runtime `update`, which
`SET`s only those keys.

**C#** — the generated route runs a per-field merge loop over the present JSON keys
(the app's configured `JsonSerializerOptions`), writing only the columns the body
carried; omitted columns are untouched.

## `@autoSet` timestamp stamping

Mark a `field.timestamp` with `@autoSet: onCreate` or `onUpdate` and the generated
CRUD stamps `now()` for you — so adopters stop hand-writing `now()` in every
repository. The contract (cross-port):

- **create** stamps every `onCreate` *and* `onUpdate` column with `now()`; the
  model's value is ignored (a fresh row's `updatedAt` equals its `createdAt`).
- **update / patch** stamps `onUpdate` columns with `now()` and **skips `onCreate`
  entirely** — `createdAt` is never rewritten (omitting this is the latent
  lost-update bug the feature closes). On a patch, `onUpdate` is stamped even when
  the caller assigns nothing else, so a partial update still bumps `updatedAt`.
- **`insertPreserving`** — an escape hatch that writes the `@autoSet` columns
  verbatim (import / restore / replication); generated only for entities that
  declare `@autoSet` fields.

```jsonc
{ "field.timestamp": { "name": "updatedAt", "@autoSet": "onUpdate" }}
```

## Optimistic concurrency (adopter-owned)

Optimistic concurrency means an update succeeds only if the row has not changed since
the caller read it. Without it, two people editing the same record both save, and the
second silently overwrites the first.

**What the metadata already carries.** An `@autoSet: onUpdate` field changes on every
write, so it is the lock column. There is no separate attribute for this: a dedicated
`@rowVersion` was declined (owner ruling 2026-07-13, ADR-0023), because it would be a
second name for what `@autoSet: onUpdate` already says.

**What is not generated.** No port's generated update route or query checks the lock
column. The update code is a [reference helper](own-your-codegen.md) (ADR-0034 Amendment 3),
so the guard belongs in your owned copy: `meta eject` the query and route generators
(`dotnet meta eject`, `mvn metaobjects:eject`, `metaobjects eject` in the other ports)
and add it there.

**The pattern, in any port:**

1. The client sends back the lock value it read (for example `updatedAt`, as a body
   field or an `If-Match` header).
2. The update adds it to the `WHERE` clause:
   `UPDATE … SET … WHERE id = ? AND updated_at = ?`. The generated update already
   stamps the `onUpdate` column with `now()` on every write, so a successful update
   moves the lock forward.
3. When no row matches, read the row by id. If it is gone, answer `404`. If it exists,
   someone saved first: answer `409` with the standard error envelope, for example
   `{ "error": "stale_write" }`, and let the client re-read and retry.

In an ejected TypeScript query module (Drizzle) the guarded update is one extra
condition:

```ts
import { and, eq } from "drizzle-orm";

export async function updateOrderIfCurrent(
  db: Db, id: number, seenUpdatedAt: Date, patch: OrderPatch,
): Promise<Order | null> {
  const validated = OrderUpdateSchema.parse(patch);   // also stamps updatedAt = now()
  const [order] = await db.update(orders).set(validated)
    .where(and(eq(orders.id, id), eq(orders.updatedAt, seenUpdatedAt)))
    .returning();
  return order ?? null;   // null: the row is gone, or someone saved since seenUpdatedAt
}
```

**Known limit: SQLite and D1 timestamps.** A timestamp lock is only as fine as the
stored value. SQLite and D1 commonly store whole seconds, so two writes within the same
second carry the same lock value and the second is not caught. On those dialects use a
store that keeps sub-second precision, or keep an integer counter you increment in the
same `SET`. The metamodel does not declare an integer lock column today. If one is
needed, the approved route is to allow `@autoSet` on `field.int`/`field.long` rather
than add a new attribute.

## See also

- [`docs/features/api-contract.md`](api-contract.md) — the REST contract these
  mutations mount into (routes, verbs, error shapes)
- [`docs/features/codegen-data-shapes.md`](codegen-data-shapes.md) — the
  create / update / patch input shapes per port
- [`docs/features/field-types.md`](field-types.md) — `field.timestamp`,
  `@autoSet`, and per-subtype wire encoding
- `docs/superpowers/specs/2026-07-13-generated-mutation-surface-design.md` — the
  full FR-035 design (prior art, per-port plan, the owner rulings)
