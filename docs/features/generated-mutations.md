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
  discriminator, `@readOnly` fields, `origin.*`-derived fields. `@autoSet:onUpdate`
  columns are stamped server-side regardless of the caller; `@autoSet:onCreate`
  columns are not patch-settable. At the HTTP tier an unknown or non-settable key
  is a `400 {"error":"validation"}`.
- **PATCH-4 (validation).** Assigned values run the same per-field validation and
  the same write codec as `create`.
- **PATCH-5 (empty patch).** Zero assignments is a no-op — the current row is read
  back and returned, never an empty-`SET` SQL error.
- **PATCH-6 (result).** The patch returns the full updated row (`RETURNING`, or a
  same-transaction re-read); a missing row is the port's not-found idiom
  (`null` / `Optional.empty` / `404`).
- **PATCH-7 (verbs).** At the HTTP tier both `PATCH` and `PUT` route to the update
  handler with partial-merge semantics. True PUT-as-full-replace is out of scope.

Optimistic concurrency (a `WHERE … AND version = ?` guard) is **not** a separate
vocabulary item: an [`@autoSet`](#autoset-timestamp-stamping) field already models
"stamps on every write," which is the natural lock column (owner ruling,
2026-07-13 — a dedicated `@rowVersion` attribute was declined per ADR-0023).

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

## See also

- [`docs/features/api-contract.md`](api-contract.md) — the REST contract these
  mutations mount into (routes, verbs, error shapes)
- [`docs/features/codegen-data-shapes.md`](codegen-data-shapes.md) — the
  create / update / patch input shapes per port
- [`docs/features/field-types.md`](field-types.md) — `field.timestamp`,
  `@autoSet`, and per-subtype wire encoding
- `docs/superpowers/specs/2026-07-13-generated-mutation-surface-design.md` — the
  full FR-035 design (prior art, per-port plan, the owner rulings)
