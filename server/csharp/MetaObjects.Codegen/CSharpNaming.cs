// Field/entity -> idiomatic C# (EF Core) type + name mapping for codegen.
//
// Property names are PascalCase (C# convention); the metadata field name is
// preserved as the DB column via [Column(...)] so the wire/DB contract is
// unchanged. Scalar subtypes map to the natural .NET types; date/time/timestamp
// use the modern DateOnly/TimeOnly/DateTime trio.

using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen;

/// <summary>Field-subtype -> C# type + naming helpers for the EF Core generators.</summary>
public static class CSharpNaming
{
    private static readonly IReadOnlyDictionary<string, string> ScalarType =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [FIELD_SUBTYPE_STRING]    = "string",
            [FIELD_SUBTYPE_CLASS]     = "string",
            [FIELD_SUBTYPE_INT]       = "int",
            [FIELD_SUBTYPE_SHORT]     = "short",
            [FIELD_SUBTYPE_BYTE]      = "byte",
            [FIELD_SUBTYPE_LONG]      = "long",
            [FIELD_SUBTYPE_CURRENCY]  = "long",   // integer minor units (wire contract)
            // FIELD_SUBTYPE_ENUM is intentionally absent: enum fields get a nested C# enum
            // type, not a primitive scalar. ScalarFor(enum) returns null to trigger the
            // dedicated enum-field branch in the generators.
            [FIELD_SUBTYPE_DOUBLE]    = "double",
            [FIELD_SUBTYPE_FLOAT]     = "float",
            [FIELD_SUBTYPE_DECIMAL]   = "decimal",
            [FIELD_SUBTYPE_BOOLEAN]   = "bool",
            [FIELD_SUBTYPE_DATE]      = "DateOnly",
            [FIELD_SUBTYPE_TIME]      = "TimeOnly",
            [FIELD_SUBTYPE_TIMESTAMP] = "DateTime",
        };

    /// <summary>Value types that take a <c>?</c> suffix when nullable (vs. reference types).</summary>
    private static readonly HashSet<string> ValueTypes = new(StringComparer.Ordinal)
        { "int", "short", "byte", "long", "double", "float", "decimal", "bool", "DateOnly", "TimeOnly", "DateTime" };

    /// <summary>The base C# scalar type for a field subtype (no nullability), or null for object fields.</summary>
    public static string? ScalarFor(string fieldSubType) =>
        ScalarType.GetValueOrDefault(fieldSubType);

    /// <summary>True when the C# type is a value type (gets <c>?</c> for nullable; needs no <c>= default!</c>).</summary>
    public static bool IsValueType(string csharpType) => ValueTypes.Contains(csharpType);

    /// <summary>PascalCase the (camelCase) metadata name for a C# member/type identifier.</summary>
    public static string Pascal(string name) =>
        name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];

    /// <summary>
    /// The DB table name for an entity: the <c>dbTable</c> source override, else the
    /// raw object name. Shared so the schema DDL and the [Table] annotation agree.
    /// </summary>
    public static string Table(MetaObject entity) => entity.DbTable ?? entity.Name;

    /// <summary>
    /// The DB column name for a field: the <c>@dbColumn</c> override, else the raw
    /// field name. Shared so the schema DDL and the [Column] annotation agree.
    /// </summary>
    public static string Column(MetaField field) => field.DbColumn ?? field.Name;

    /// <summary>
    /// The bare object name from a possibly package-qualified reference (the segment
    /// after the last <c>::</c>), for resolving an <c>@objectRef</c>/<c>@references</c>
    /// against <see cref="MetaRoot.FindObject"/>. Shared by the schema + generators.
    /// </summary>
    public static string StripPkg(string name)
    {
        var i = name.LastIndexOf("::", StringComparison.Ordinal);
        return i < 0 ? name : name[(i + 2)..];
    }

    /// <summary>
    /// Cosmetic pluralization for a DbSet property name + the route collection
    /// segment (the table name itself comes from [Table]). Shared so the DbContext
    /// and routes generators agree.
    /// </summary>
    public static string Pluralize(string name)
    {
        if (name.EndsWith("s", StringComparison.Ordinal) || name.EndsWith("x", StringComparison.Ordinal) ||
            name.EndsWith("z", StringComparison.Ordinal) || name.EndsWith("ch", StringComparison.Ordinal) ||
            name.EndsWith("sh", StringComparison.Ordinal))
            return name + "es";
        if (name.Length > 1 && name.EndsWith("y", StringComparison.Ordinal) && !"aeiou".Contains(name[^2]))
            return name[..^1] + "ies";
        return name + "s";
    }

    /// <summary>
    /// Whether a field is non-nullable in the generated entity: explicitly @required,
    /// or part of the primary identity.
    /// </summary>
    public static bool IsRequired(MetaObject entity, MetaField field)
    {
        if (field.OwnAttr(FIELD_ATTR_REQUIRED) is true) return true;
        var pk = entity.PrimaryIdentity();
        return pk is not null && pk.Fields.Contains(field.Name);
    }

    /// <summary>
    /// The C# enum type name for an enum-subtype field:
    /// <list type="bullet">
    ///   <item>When the field <c>extends:</c> an abstract super, use the PascalCased super name
    ///   (one enum type shared by all fields that extend it).</item>
    ///   <item>Otherwise use <c>&lt;EntityPascal&gt;&lt;FieldPascal&gt;</c>.</item>
    /// </list>
    /// </summary>
    public static string EnumTypeName(MetaObject entity, MetaField field)
    {
        if (field.ResolveSuper() is { } super)
            return Pascal(super.Name);
        return Pascal(entity.Name) + Pascal(field.Name);
    }
}
