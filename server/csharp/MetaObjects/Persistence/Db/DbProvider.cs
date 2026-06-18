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

        // Physical RDB index/constraint attrs on identity subtypes — DB-domain
        // concerns (index ordering / partial predicate / FK constraint naming),
        // NOT core identity. Mirror the TS db.json identity extends.
        registry.Extend(
            MetaObjects.Shared.BaseTypes.TYPE_IDENTITY,
            IdentityConstants.IDENTITY_SUBTYPE_SECONDARY,
            attributes: [DbSchema.OrdersSchema, DbSchema.WhereSchema]);
        registry.Extend(
            MetaObjects.Shared.BaseTypes.TYPE_IDENTITY,
            IdentityConstants.IDENTITY_SUBTYPE_REFERENCE,
            attributes: [DbSchema.ConstraintNameSchema]);
    }
}
