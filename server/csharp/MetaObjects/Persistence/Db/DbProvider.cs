// DbMetaDataProvider — the DB-domain IMetaDataTypeProvider. Registers the DB-domain
// field attributes (@column / @db.indexed / @dbColumnType) by EXTENDING the
// core-registered field types. Mirrors Java's CoreDBMetaDataProvider
// (com.metaobjects.database) and TS's dbProvider (db-provider.ts).
//
// These attrs are DB-domain concerns, NOT core field properties, so they live in
// this provider rather than on FieldSchema.CommonFieldAttrs — the same end-state
// as Java and TS, keeping all domain field-attrs in domain providers.

using MetaObjects.Core.Field;
using MetaObjects.Core.Identity;
using MetaObjects.Core.Index;

namespace MetaObjects.Persistence.Db;

/// <summary>
/// DB-domain provider: registers <c>@column</c> / <c>@db.indexed</c> / <c>@dbColumnType</c>
/// on every field subtype via <see cref="TypeRegistry.Extend"/>. Depends on the core
/// types being registered first.
/// </summary>
public sealed class DbMetaDataProvider : IMetaDataTypeProvider
{
    /// <summary>The shared singleton — composed into the default registry alongside the core provider.</summary>
    public static readonly IMetaDataTypeProvider Instance = new DbMetaDataProvider();

    public string Id => "metaobjects-db";

    public string? Description =>
        "DB-domain attributes — @column / @db.indexed / @dbColumnType on every field subtype.";

    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        // Extend every field subtype with the DB-domain attrs (mirrors TS's FIELD_SUBTYPES loop
        // and Java's field.base optionalAttribute calls — C# registers per-subtype since it has
        // no concrete field.base type def).
        foreach (string subType in FieldConstants.FIELD_SUBTYPES)
        {
            registry.Extend(
                MetaObjects.Shared.BaseTypes.TYPE_FIELD,
                subType,
                attributes: [DbSchema.ColumnSchema, DbSchema.DbIndexedSchema, DbSchema.DbColumnTypeSchema]);
        }

        // ADR-0036 Wave 2 — @localTime (the naive-timestamp opt-out) is field.timestamp-ONLY
        // (it has no meaning on any other subtype), mirroring db.json's field.timestamp extends
        // block. Default field.timestamp is an absolute instant (timestamptz / DateTimeOffset);
        // @localTime:true opts into a naive wall-clock value (timestamp / DateTime).
        registry.Extend(
            MetaObjects.Shared.BaseTypes.TYPE_FIELD,
            FieldConstants.FIELD_SUBTYPE_TIMESTAMP,
            attributes: [DbSchema.LocalTimeSchema]);

        // Physical RDB index/constraint attrs on identity subtypes — DB-domain
        // concerns (index ordering / partial predicate / FK constraint naming),
        // NOT core identity. Mirror the TS db.json identity extends.
        // NOTE: @unique is intentionally NOT extended onto identity.secondary —
        // identity.secondary is always a unique constraint. @unique was removed
        // from the identity.secondary schema; non-unique indexes use index.lookup.
        registry.Extend(
            MetaObjects.Shared.BaseTypes.TYPE_IDENTITY,
            IdentityConstants.IDENTITY_SUBTYPE_SECONDARY,
            attributes: [DbSchema.OrdersSchema, DbSchema.WhereSchema, DbSchema.ExprSchema, DbSchema.UsingSchema]);
        registry.Extend(
            MetaObjects.Shared.BaseTypes.TYPE_IDENTITY,
            IdentityConstants.IDENTITY_SUBTYPE_REFERENCE,
            attributes: [DbSchema.ConstraintNameSchema, DbSchema.ReferenceOnDeleteSchema, DbSchema.ReferenceOnUpdateSchema]);

        // Physical RDB index attrs on index.lookup — the db provider contributes
        // @orders / @expr / @where / @using (the same attrs as identity.secondary,
        // reusing the DbSchema constants). Mirrors TS db.json index.lookup extends.
        registry.Extend(
            MetaObjects.Shared.BaseTypes.TYPE_INDEX,
            IndexConstants.INDEX_SUBTYPE_LOOKUP,
            attributes: [DbSchema.OrdersSchema, DbSchema.WhereSchema, DbSchema.ExprSchema, DbSchema.UsingSchema]);
    }
}
