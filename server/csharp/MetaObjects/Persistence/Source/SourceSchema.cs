// Source attribute schemas — attrs declared on source.rdb (ADR-0007).
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/persistence/source/source-schema.ts
// and the Java sibling MetaSource.registerTypes(...) registration.

using MetaObjects.Core.Attr;

namespace MetaObjects.Persistence.Source;

/// <summary>Attribute schemas for the source.rdb concrete subtype.</summary>
public static class SourceSchema
{
    /// <summary>All attr schemas declared on source.rdb.</summary>
    public static readonly IReadOnlyList<AttrSchema> RdbSourceAttrs =
    [
        // @table — physical SQL table name for @kind: "table" (default). FR-016:
        // one of five kind-aware physical-name aliases; all write to the same
        // internal slot. Pre-1.0 legacy: also accepted with non-table @kind
        // (canonical-serializer rewrites; loader emits WARN_LEGACY_PHYSICAL_NAME_ALIAS).
        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_TABLE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Physical SQL table name for source.rdb @kind: \"table\" (default). FR-016: " +
                "Defaults from the source's bare structural `name` via the project's columnNamingStrategy " +
                "when omitted, then from the owning entity's name. Pre-1.0 legacy spelling for " +
                "view/materializedView/storedProc/tableFunction kinds during the transition; " +
                "canonical-serializer rewrites to the kind-matching alias."),

        // @view — physical SQL view name for @kind: "view" (FR-016 / ADR-0018).
        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_VIEW,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Physical SQL view name for source.rdb @kind: \"view\". Same internal slot as @table."),

        // @materializedView — physical SQL materialized-view name for @kind: "materializedView".
        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_MATERIALIZED_VIEW,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Physical SQL materialized-view name for source.rdb @kind: \"materializedView\". Same internal slot as @table."),

        // @proc — physical SQL stored-procedure name for @kind: "storedProc".
        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_PROC,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Physical SQL stored-procedure name for source.rdb @kind: \"storedProc\". Same internal slot as @table."),

        // @function — physical SQL table-function name for @kind: "tableFunction".
        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_FUNCTION,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Physical SQL table-function name for source.rdb @kind: \"tableFunction\". Same internal slot as @table."),

        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_KIND,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. SourceConstants.SOURCE_RDB_KINDS],
            Description: "The kind of database object this source represents: table (default, writable), view, materializedView, storedProc, or tableFunction. Non-table kinds are read-only."),

        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_ROLE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. SourceConstants.SOURCE_ROLES],
            Description: "Role this source plays when an object has multiple sources: primary (default, system of record) or replica. The former members index, cache, publish and mirror are reserved-not-registered (ADR-0007 Amendment 2): a role member enters the registry only when a shipping consumer dispatches on it."),

        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_SCHEMA,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Optional database schema name (e.g. 'catalog', 'public'). Postgres defaults to 'public'; SQLite rejects any non-default value."),

        // FR-024/#208 escape valve — registration only, no validation/lowering here.
        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_SQL,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "FR-024/#208 escape valve — a hand-written SQL body the tool REGISTERS + " +
                "fingerprints + drift-checks but never authors or parses. The body goes INSIDE " +
                "`CREATE <kind> <physicalName> AS …` (never the CREATE wrapper, never the object name). " +
                "Legal only on a read-only kind (not @kind: table); migrate lowers it on @kind: view " +
                "(matview/proc/tableFunction: registered but not yet migrate-managed). Mutually " +
                "exclusive with @unmanaged; forbids origin.* children (two sources of truth)."),

        // FR-024/#208 escape valve — registration only, no validation/lowering here.
        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_UNMANAGED,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "FR-024/#208 escape valve — this DB object is managed elsewhere (Flyway / " +
                "a hand-migration owns its DDL). meta migrate does NOT create, drop, or drift-check " +
                "it; verify --db reports it as external (declared). Legal on any @kind including " +
                "table (the externally-managed-entity case). Mutually exclusive with @sql."),

        // FR-015: typed-input shape for a callable source (storedProc / tableFunction).
        // Symmetric with template.@payloadRef — reuses object.value as the parameter shape.
        new AttrSchema(
            Name: SourceConstants.SOURCE_ATTR_PARAMETER_REF,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "FR-015: name or FQN of an object.value describing the input shape of " +
                "this source's callable interface. Permitted on @kind: \"storedProc\" / " +
                "\"tableFunction\"; rejected on non-callable kinds (table / view / materializedView). " +
                "Field children of the referenced object.value become the call-site parameter list " +
                "in declaration order. Symmetric with template.@payloadRef in FR-004."),
    ];
}
