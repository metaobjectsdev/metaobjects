<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `source` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `source` types

Each section below is one `source.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### source.base

Abstract base source — the shared root subtype for declaring where an object's data lives (Project E). The base carries no attrs of its own; the concrete paradigm subtype (rdb) carries the physical-storage attrs, which are contributed by the db domain provider.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### source.rdb

The relational-database paradigm source (ADR-0007): binds an object to a physical relational object. Its physical name is the @table attr (not the structural `name`), and read-only-ness is DERIVED from @kind — table is writable; view, materializedView, storedProc, and tableFunction are read-only. The @table/@kind/@role/@schema/@parameterRef attrs are contributed by the db domain provider, not by core-types.

**Owning provider:** metaobjects-core-types

**Rules:** ADR-0007: source declares where an object's data lives; rdb is the relational paradigm subtype. An object may declare multiple sources, distinguished by @role, with exactly ONE @role: "primary" per object (write-through CQRS: a writable table for writes plus a read-only view for reads). The physical name is the @table attr (or the @kind-matching alias), never the structural `name`. Read-only-ness is derived from @kind (table → writable; view / materializedView / storedProc / tableFunction → read-only). The pre-v2 dbTable / dbView subtypes are retired.

**When to use:** The entity is backed by a relational table or view. Set @table/@kind — the default persistence source for any entity.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@function` | string | no |  |  | metaobjects-db | Physical SQL table-function name for source.rdb @kind: "tableFunction". Same internal slot as @table. |
| `@kind` | string | no |  | `table`, `view`, `materializedView`, `storedProc`, `tableFunction` | metaobjects-db | The kind of database object this source represents: table (default, writable), view, materializedView, storedProc, or tableFunction. Non-table kinds are read-only. |
| `@materializedView` | string | no |  |  | metaobjects-db | Physical SQL materialized-view name for source.rdb @kind: "materializedView". Same internal slot as @table. |
| `@parameterRef` | string | no |  |  | metaobjects-db | FR-015: name or FQN of an object.value describing the input shape of this source's callable interface. Permitted on @kind: "storedProc" / "tableFunction"; rejected on non-callable kinds (table / view / materializedView). Field children of the referenced object.value become the call-site parameter list in declaration order. Symmetric with template.@payloadRef in FR-004 — the typed-input pattern reuses object.value rather than minting a new parameter.* node type. |
| `@proc` | string | no |  |  | metaobjects-db | Physical SQL stored-procedure name for source.rdb @kind: "storedProc". Same internal slot as @table. |
| `@role` | string | no |  | `primary`, `replica` | metaobjects-db | Role this source plays when an object has multiple sources: primary (default, system of record) or replica. The former members index, cache, publish and mirror are reserved-not-registered (ADR-0007 Amendment 2): a role member enters the registry only when a shipping consumer dispatches on it. |
| `@schema` | string | no |  |  | metaobjects-db | Optional database schema name (e.g. 'catalog', 'public'). Postgres defaults to 'public'; SQLite rejects any non-default value. |
| `@sql` | string | no |  |  | metaobjects-db | FR-024/#208 escape valve — a hand-written SQL body the tool REGISTERS + fingerprints + drift-checks but never authors or parses. The body goes INSIDE `CREATE <kind> <physicalName> AS …` (never the CREATE wrapper, never the object name). Legal only on a read-only kind (not @kind: table); migrate lowers it on @kind: view (matview/proc/tableFunction: registered but not yet migrate-managed). Mutually exclusive with @unmanaged; forbids origin.* children (two sources of truth). |
| `@table` | string | no |  |  | metaobjects-db | Physical SQL table name for source.rdb @kind: "table" (default). FR-016: Defaults from the source's bare structural `name` via the project's columnNamingStrategy when omitted, then from the owning entity's name. Pre-1.0 legacy spelling for view/materializedView/storedProc/tableFunction kinds during the transition; canonical-serializer rewrites to the kind-matching alias. |
| `@unmanaged` | boolean | no |  |  | metaobjects-db | FR-024/#208 escape valve — this DB object is managed elsewhere (Flyway / a hand-migration owns its DDL). meta migrate does NOT create, drop, or drift-check it; verify --db reports it as external (declared). Legal on any @kind including table (the externally-managed-entity case). Mutually exclusive with @sql. |
| `@view` | string | no |  |  | metaobjects-db | Physical SQL view name for source.rdb @kind: "view". Same internal slot as @table. |

**Allowed children**

_No structural children._

