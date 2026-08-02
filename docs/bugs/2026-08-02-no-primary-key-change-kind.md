---
name: Bug report
about: Report a defect
title: "migrate: no primary-key change kind, so moving a table's PK leaves it with none and every referencing FK fails"
labels: bug
---

> **Filed as** https://github.com/metaobjectsdev/metaobjects/issues/258 (2026-08-02). Open. Follow-on from #255.

**Affected port(s):** TypeScript (diff + emit; shared migration engine, so all ports)
**Package + version:** `@metaobjectsdev/cli` + `@metaobjectsdev/migrate-ts` 0.20.10

## What happened

Adopting an existing Postgres database whose primary key differs from the metadata,
the apply fails once it reaches the foreign keys:

```
meta: migrate: apply failed: there is no unique constraint matching given keys
      for referenced table "user_profiles"
```

Concretely: the live table has `PRIMARY KEY (user_id)`. The metadata declares the
entity's identity as an inherited `id` (`field.uuid` on an abstract base). The
generated migration emits:

```sql
ALTER TABLE "user_profiles" ADD COLUMN "id" UUID DEFAULT gen_random_uuid() NOT NULL;  -- line 243
ALTER TABLE "user_profiles" DROP COLUMN "user_id";                                    -- line 253
CREATE UNIQUE INDEX "user_profiles_auth_user_id_unique" ON "user_profiles" ("auth_user_id");
ALTER TABLE "agent_configs" ADD CONSTRAINT … FOREIGN KEY ("created_by")
  REFERENCES "user_profiles" ("id");                                                  -- ×49
```

`DROP COLUMN "user_id"` takes the old primary key with it, and **nothing ever makes
`id` the primary key** (or unique). The table is left with no PK, so all 49 FKs
referencing `user_profiles(id)` are rejected.

The apply is transactional and rolls back cleanly — verified, the table still has
`PRIMARY KEY (user_id)` and no `id` column afterwards.

## What you expected

The diff recognises that the table's primary key moved from `user_id` to `id`, and
emits the key migration (`ADD PRIMARY KEY ("id")`, plus dropping the old one) after
the column is added and before any FK references it.

## Root cause

The table model *knows* about primary keys —
`server/typescript/packages/migrate-ts/src/types.ts:35`:

```ts
  primaryKey: string[];              // column names; [] if none
```

— but there is **no primary-key change kind** in the emitted plan.
`STAGE_ORDER` in `src/emit/postgres.ts` is an exhaustive
`Record<Change["kind"], number>` and contains only:

```
drop-view, drop-fk, drop-check, create-table, drop-index,
add-column, drop-column, change-column-type, change-column-nullable,
change-column-default, rename-column, rename-table, add-index,
add-fk, add-check, drop-table, create-view, replace-view
```

No `add-primary-key` / `drop-primary-key` / `change-primary-key`. So the diff can
*read* a table's PK but cannot *express a change to it*: a PK move degrades silently
into an unrelated add-column plus drop-column, and the constraint is simply lost.

This is only observable when adopting an existing database (`baseline --from-db`)
whose PK disagrees with the metadata — a greenfield `create-table` carries its PK
inline, which is why it has not shown up before.

## Suggested fix

Add primary-key change kinds to the `Change` union and to both emitters, staged so
the key exists before anything references it and after the column exists:

```ts
  "drop-fk": 1, "drop-check": 1,
  "drop-primary-key": 1.6,        // NEW: after drop-fk, before column mutation
  "add-column": 2, "drop-column": 2,
  …
  "add-primary-key": 4.5,         // NEW: after columns/indexes, before add-fk
  "add-fk": 5,
```

The invariant is `drop-fk < drop-primary-key`, `add-column < add-primary-key < add-fk`.
`src/emit/sqlite.ts` needs the same kinds (SQLite requires the recreate-and-copy path
for a PK change).

If a PK change is considered too dangerous to automate, the alternative is to
**detect and refuse** it — fail the diff with a clear "primary key differs; not
migratable" message rather than emitting SQL that cannot apply.

## Reproduction

```
-- live DB
CREATE TABLE parent (legacy_id UUID PRIMARY KEY, name TEXT);
CREATE TABLE child  (id UUID PRIMARY KEY, parent_ref UUID);
```

Metadata declares `Parent` with identity `id` (not `legacy_id`) and a
`identity.reference` from `Child.parentRef` → `Parent`.

```
meta migrate baseline --from-db --db postgresql://… --dialect postgres
meta migrate --db postgresql://… --dialect postgres --slug repro \
  --allow drop-column,drop-fk --apply
```

→ `there is no unique constraint matching given keys for referenced table "parent"`.

## Environment

Linux, Node 24, Postgres 16, pnpm. Reproduced against a restored copy of a real
database (~198 pending changes), not a synthetic fixture.

## Context

Found immediately behind #255 (statement ordering), which is fixed in 0.20.10 — the
apply now gets past the column drops and fails at the FK stage instead. This is the
"second failure class" that issue's closing note predicted.
