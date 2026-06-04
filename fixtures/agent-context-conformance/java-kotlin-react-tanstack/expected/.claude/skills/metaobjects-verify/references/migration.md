# Schema migrations — the shared TypeScript engine (every port)

Schema migration is owned by **one shared TypeScript engine** regardless of your
server language (ADR-0015). The Node `meta` CLI (`@metaobjectsdev/cli`, on top of
`@metaobjectsdev/migrate-ts`) is the migration + live-DB-drift toolchain for **TS,
Java, Kotlin, C#, and Python alike**. The non-TS ports have **no** migration command
of their own — their former migrate goals/modules were removed. A JVM service may
auto-create dev/test tables at startup for convenience, but production schema is
always the Node migrate engine's output.

So even in a Java / Python / C# / Kotlin project you run `meta migrate` and
`meta verify --db` through Node. Only schema crosses to Node; per-port `gen`/codegen
stays native to the language.

## Install (Node, dev-only)

```bash
npm install --save-dev @metaobjectsdev/cli @metaobjectsdev/migrate-ts
```

You point the tool at the **same database your server connects to** — its
connection is independent of your runtime tier.

## The workflow

1. **Generate a migration** by diffing metadata vs the prior state (the live DB or a
   committed snapshot). The engine emits paired `up.sql` + `down.sql`:

   ```bash
   meta migrate --db postgresql://...               # emit up.sql + down.sql
   meta migrate --db postgresql://... --slug initial # name the migration
   meta migrate --dry-run                            # preview without writing
   ```

2. **Review the SQL.** Read the emitted `up.sql` (forward) and `down.sql`
   (rollback) before applying. Destructive changes (drop column / drop table) are
   opt-in — the engine blocks them unless explicitly allowed, and routes ambiguous
   rename-vs-drop+add decisions through a prompt rather than guessing.

3. **Apply** the pending migrations against the DB; migration history is tracked in
   a ledger table:

   ```bash
   meta migrate --db postgresql://... --apply       # run pending up.sql
   meta migrate --db postgresql://... --rollback     # run down.sql for the last migration
   ```

## Dialects

- `postgres` (default) — native `ALTER`s.
- `sqlite` (libsql / Turso) — native `ALTER`s where supported (≥ 3.35), bundling
  recreate-and-copy per table when a change needs it.
- `d1` (Cloudflare D1) — **TS-only**; targets D1 via the wrangler CLI, writes
  Wrangler's native `migrations/<seq>_<slug>.sql` layout. Pass `--dialect d1`.

## Live-DB drift: `meta verify --db`

`meta verify --db` introspects the live database and fails if its schema has
diverged from the metadata (a column the metadata no longer declares, a missing
index, a type mismatch). This is the **authoritative** DB-vs-metadata gate for every
port — wire it into CI. On the JVM ports a runtime startup validator can catch
generated-table drift at app boot as a complementary check, but the gate that owns
DB drift is the Node `meta verify --db`.

A clean run is silent; a failure names the drifted table/column. Bias toward
trusting the tool — a drift failure almost always means the metadata changed and the
DB didn't follow.

## Not yet shipped

Triggers, generated columns, partial/exclusion/check constraints, MySQL, and data
migrations (column-type changes needing data transformation error out with a hint).
