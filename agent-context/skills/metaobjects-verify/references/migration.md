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

## Output format

`meta migrate` (and the CLI generally) is TTY-aware: when stdout is a terminal it
emits human-readable text; when piped to an agent or CI system it defaults to TOON
(a compact, unambiguous machine-readable format). Override with `--format`:

```bash
meta migrate ... --format toon   # TOON (machine-readable, the pipe/agent default)
meta migrate ... --format json   # JSON
meta migrate ... --format text   # human-readable text (the TTY default)
```

Structured errors and next-step hints are also emitted on stdout (not stderr) in the
active format, so callers can parse them without scraping stderr.

## The workflow

### Fresh database: baseline first

The default `meta migrate` path is **offline** — it diffs metadata against a
committed schema snapshot rather than the live DB. On a fresh database there is no
snapshot yet; run the `baseline` step once before the first migration generate:

```bash
meta migrate baseline --dialect sqlite     # seed snapshot from metadata (no DB needed)
meta migrate baseline --dialect postgres   # same for Postgres
meta migrate baseline --from-db --db postgresql://... --dialect postgres
                                           # alternative: seed from live DB (for existing schemas)
```

`baseline` writes a reference snapshot to `.metaobjects/migrations/` and exits
without emitting any SQL. After this, `meta migrate --dialect <d> --slug <name>`
operates offline against that snapshot.

If you run `meta migrate` before baselining, the CLI surfaces a structured
next-step hint pointing to the exact `baseline` command.

### Generating a migration

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

## Index modeling (Postgres)

Two index types, distinguished by uniqueness (ADR-0040) — both carry the same
physical-shape escapes contributed by the db provider:

- **`identity.secondary`** — a UNIQUE alternate key (uniqueness is the type; the legacy
  `@unique` attr was removed from it).
- **`index.lookup`** — a NON-unique retrieval index (`@fields` required).

Shared physical escapes:

- `@orders` — per-key sort direction, positional to `@fields` (`["asc", "desc"]`).
  Omit for all-ascending; drives `DESC`-ordered index keys (e.g. a recency index).
- `@where` — a partial-index predicate (raw SQL, e.g. `"delivered_at IS NULL"`),
  emitted as `WHERE (<pred>)`. The index then covers only matching rows.
- `@using` / `@expr` — index method and functional-expression escapes.

A non-unique recency index is `index.lookup`:

```json
{ "index.lookup": { "@fields": ["userId", "createdAt"],
    "@orders": ["asc", "desc"], "@where": "archived_at IS NULL" } }
```

The `@where` / `@using` / `@expr` / `@orders` attributes are **index** physical
escapes on `identity.secondary` / `index.lookup` — they are NOT a raw-SQL escape
hatch for views. For a genuinely-irreducible view body, use the `source.rdb`
**`@sql`** escape (a tool-managed, opaque hand-written body — see the
"DDL-ownership escape valves" section below); for a DB object owned entirely by
Flyway / a hand-migration, use **`@unmanaged`**.

## Projection views (generated view DDL)

A read-only projection (`object.projection` with a `source.rdb` `@kind: view` child)
does **not** get a hand-written `CREATE VIEW`. `meta migrate` synthesizes the view
DDL from the projection's `origin.*` children — `passthrough` columns, `aggregate`
rollups (`count`/`sum`/`avg`/`min`/`max`), and `collection` joins — through the one
canonical view-SQL emitter shared with drift detection.

- Change the projection (add a passthrough, change an aggregate) → `meta migrate`
  emits a `create-view` / `replace-view`; a change to a source-table column the view
  selects auto-recreates the dependent view.
- `meta verify --db` **body-compares** a modeled view — a live `CREATE VIEW` that no
  longer matches the projection is `replace-view` drift.
- A **hand-authored, unmodeled** DB view is *unmanaged* — never diffed, never
  dropped, never reported as actionable drift. That is the blind spot: a hand-written
  view that could have been a projection drifts silently, so it is caught by the
  `metaobjects-audit` skill, not here.

**Do not hand-author view SQL for a shape origins can express** — model it as a
projection so the view DDL is generated and drift-checked. For a genuinely
irreducible view (recursive CTE, window function, set operation) that origins
can't express, use the `@sql` escape below rather than a hand-edited migration
file — that keeps the view tool-managed (emitted, fingerprinted, drift-checked)
instead of accidentally unmanaged.

## DDL-ownership escape valves (`@sql` / `@unmanaged`) — #208

Two mutually-exclusive `source.rdb` attributes express *who owns a DB object's
DDL* (ADR-0043). They are the escape from "a projection's view is always
synthesized from its `origin.*` children."

**`@sql`** — a hand-written view body the tool **registers, fingerprints, and
drift-checks but never authors or parses**. The value is the body *inside*
`CREATE VIEW <name> AS …` (not the `CREATE` wrapper, not the name). Legal only on
a read-only kind; v1 migrate lowers it on `@kind: view` only (matview/proc → a
hard error, deferred). Authored sigil-free in YAML as a block scalar:

```yaml
object.projection:
  name: OrgTree
  children:
    - source.rdb: { kind: view, view: v_org_tree, sql: |
        WITH RECURSIVE t AS (
          SELECT id, parent_id FROM org WHERE parent_id IS NULL
          UNION ALL SELECT o.id, o.parent_id FROM org o JOIN t ON o.parent_id = t.id)
        SELECT * FROM t }
    - field.long: { name: id, extends: Org.id }
    - identity.primary: { extends: Org.pk }
```

The `extends`-bound identity/fields declare the read model's shape and row
identity *without* triggering wrong synthesis (the suppression rule). The view is
emitted verbatim with a fingerprint COMMENT stamp; a second `meta migrate` is a
no-op. **Adopting a pre-existing hand-written view** at that name: the first diff
reports `replace-view` **blocked** (an unstamped view is indistinguishable from
someone else's SQL) — run **`meta migrate --allow adopt-view`** once to stamp it,
then it converges. `@sql` **forbids** `origin.*` children and a `@filter` on the
same host (two sources of truth → load error).

**`@unmanaged: true`** — this DB object (a view **or a table**) is managed
elsewhere (Flyway / a hand-migration owns its DDL). `meta migrate` never creates,
drops, or drift-checks it; `meta verify --db` reports it as *external (declared)*.
Legal on any `@kind`, including `table` (the Flyway-owned-entity case). An FK from
a managed table into an `@unmanaged` table resolves its physical name, but the
external object must exist before that FK is applied (a documented ordering caveat,
not enforced).

`@sql` and `@unmanaged` are **mutually exclusive** on one source.

## Adopting an existing database (non-destructive)

`meta verify --db` / `meta migrate` can reach **zero drift** against a hand-built
schema without a rewrite:

- **`meta migrate --from-db`** reverse-engineers a baseline from the live DB so the
  first diff is empty.
- **Auto schema-scope** — the diff manages only the schemas the metadata *declares*
  (via `source.rdb @schema`); tables in undeclared schemas belong to another owner
  and are left untouched. This is what lets several apps share one database, each
  owning its own schema, with a clean per-owner `verify --db` and no manual ignore
  lists. A downstream app that extends the toolkit's DB declares its own `@schema`,
  models only its tables, and runs its own migrate/verify against that scope.
- **`identity.reference @constraintName`** pins a foreign-key constraint name so the
  metadata can match an existing DB's naming convention without a destructive
  rename.

## Not yet shipped

Triggers, generated columns, exclusion + CHECK constraints, MySQL, and data
migrations (column-type changes needing data transformation error out with a hint).
(Partial + descending **indexes** *are* supported — see Index modeling above.)
