// Field/entity -> idiomatic C# (EF Core) type + name mapping for codegen.
//
// Property names are PascalCase (C# convention); the metadata field name is
// preserved as the DB column via [Column(...)] so the wire/DB contract is
// unchanged. Scalar subtypes map to the natural .NET types; date/time/timestamp
// use the modern DateOnly/TimeOnly/DateTime trio.

using MetaObjects.Meta;
using MetaObjects.Persistence.Db;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen;

/// <summary>
/// Column-naming strategy for fields with no <c>@column</c> override. C# port
/// defaults to <see cref="Literal"/> (EF Core property=column convention); TS
/// port defaults to <see cref="SnakeCase"/> (PG convention).
/// </summary>
public enum ColumnNamingStrategy
{
    /// <summary>Field name verbatim. EF Core default.</summary>
    Literal,
    /// <summary>camelCase / PascalCase → snake_case. PG / TS default.</summary>
    SnakeCase,
    /// <summary>camelCase / PascalCase → kebab-case.</summary>
    KebabCase,
}

/// <summary>Field-subtype -> C# type + naming helpers for the EF Core generators.</summary>
public static class CSharpNaming
{
    private static readonly IReadOnlyDictionary<string, string> ScalarType =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [FIELD_SUBTYPE_STRING]    = "string",
            [FIELD_SUBTYPE_INT]       = "int",
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
            // ADR-0036 Wave 2 — field.timestamp's CLR type is CONDITIONAL on @localTime
            // (see ScalarForField): default = DateTimeOffset (an absolute instant), and
            // @localTime:true = DateTime (a naive wall-clock value). This subtype-keyed
            // entry is the DEFAULT (no field in hand); the per-field overload overrides it.
            [FIELD_SUBTYPE_TIMESTAMP] = "DateTimeOffset",
            // R6 Plan 2a — field.uuid binds to the native System.Guid value type
            // (ADR-0001), independent of its string wire form. The native uuid DB
            // column is a separate migrate-engine concern (SubtypeToSqlType).
            [FIELD_SUBTYPE_UUID]      = "Guid",
            // ADR-0036 Wave 3 — field.uri binds to the native System.Uri reference type
            // (DB column is text); field.inet binds to System.Net.IPAddress (DB column is
            // the Postgres-native inet type). Both are string-backed on the wire.
            [FIELD_SUBTYPE_URI]       = "Uri",
            [FIELD_SUBTYPE_INET]      = "IPAddress",
        };

    /// <summary>Value types that take a <c>?</c> suffix when nullable (vs. reference types).</summary>
    private static readonly HashSet<string> ValueTypes = new(StringComparer.Ordinal)
        { "int", "long", "double", "float", "decimal", "bool", "DateOnly", "TimeOnly", "DateTime", "DateTimeOffset", "Guid" };

    /// <summary>
    /// ADR-0036 Wave 3 — the CANONICAL hostname matcher for <c>@stringFormat: hostname</c>,
    /// emitted into a <c>[RegularExpression(@"...")]</c> verbatim string literal. The matcher
    /// lives in codegen (NOT author <c>validator.regex</c>) so every port replicates the SAME
    /// canonical form. RFC-1123 labels: 1–63 chars each, alphanumeric + internal hyphens,
    /// dot-separated; total ≤253, anchored. Byte-identical to the TS Zod <c>.regex(...)</c> source.
    /// </summary>
    public const string HostnameRegex =
        @"^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$";

    /// <summary>The base C# scalar type for a field subtype (no nullability), or null for object fields.</summary>
    public static string? ScalarFor(string fieldSubType) =>
        ScalarType.GetValueOrDefault(fieldSubType);

    /// <summary>
    /// ADR-0036 Wave 2 — true when a <c>field.timestamp</c> opts OUT of instant
    /// semantics via <c>@localTime: true</c> (a naive wall-clock value). Own-only,
    /// matching the loader's physical-attr policy. Always false for non-timestamp fields.
    /// </summary>
    public static bool IsLocalTime(MetaField field) =>
        field.SubType == FIELD_SUBTYPE_TIMESTAMP && field.OwnAttr(DbConstants.FIELD_ATTR_LOCAL_TIME) is true;

    /// <summary>
    /// The base C# scalar type for a field (no nullability), accounting for the
    /// ADR-0036 Wave 2 conditional <c>field.timestamp</c> binding:
    /// <list type="bullet">
    ///   <item>default <c>field.timestamp</c> → <c>DateTimeOffset</c> (an absolute instant / <c>timestamptz</c>);</item>
    ///   <item><c>field.timestamp @localTime:true</c> → <c>DateTime</c> (a naive wall-clock value / <c>timestamp</c>).</item>
    /// </list>
    /// Every other subtype delegates to the subtype-keyed <see cref="ScalarFor(string)"/>.
    /// Returns null for object fields.
    /// </summary>
    public static string? ScalarForField(MetaField field) =>
        IsLocalTime(field) ? "DateTime" : ScalarFor(field.SubType);

    /// <summary>
    /// The System.Text.Json type that holds a parsed JSON value — the CLR property
    /// type for a <c>@dbColumnType:jsonb</c> open-JSON bag. <c>JsonDocument</c> is
    /// mapped to <c>jsonb</c> natively by Npgsql (no <c>EnableDynamicJson</c>), round-trips
    /// an arbitrary JSON object, and is (de)serialized by System.Text.Json as a real
    /// JSON value at the minimal-API boundary — not a double-encoded string (issue #98).
    /// </summary>
    public const string JsonbClrType = "JsonDocument";

    /// <summary>
    /// The CLR type override implied by a field's <c>@dbColumnType</c> physical override,
    /// or null when the override does not change the CLR type. Only <c>jsonb</c> shifts
    /// the CLR type (string → <see cref="JsonbClrType"/>, exposing the parsed JSON value);
    /// <c>uuid</c> keeps the <c>string</c> property and converts at the DB seam (ADR-0013).
    /// </summary>
    public static string? DbColumnTypeClrOverride(MetaField field) =>
        field.DbColumnType == DbConstants.DB_COLUMN_TYPE_JSONB ? JsonbClrType : null;

    /// <summary>True when any of <paramref name="obj"/>'s own fields is a jsonb open-bag
    /// (so the generated file needs <c>using System.Text.Json;</c> for the JsonDocument type).</summary>
    public static bool RequiresSystemTextJson(MetaObject obj) =>
        obj.Fields().Any(f => DbColumnTypeClrOverride(f) is not null);

    /// <summary>ADR-0036 Wave 3 — true when any of <paramref name="obj"/>'s own fields is a
    /// <c>field.inet</c> (so the generated file needs <c>using System.Net;</c> for the
    /// <c>IPAddress</c> type). <c>field.uri</c> needs only <c>System</c> (always imported).</summary>
    public static bool RequiresSystemNet(MetaObject obj) =>
        obj.Fields().Any(f => !f.IsArray && f.SubType == FIELD_SUBTYPE_INET);

    /// <summary>True when the C# type is a value type (gets <c>?</c> for nullable; needs no <c>= default!</c>).</summary>
    public static bool IsValueType(string csharpType) => ValueTypes.Contains(csharpType);

    /// <summary>
    /// The C# value type of a <c>field.map</c> (an open-keyed map): the value-object
    /// (@objectRef → Pascal class name) when set, else the scalar named by @valueType
    /// (defaulting to <c>string</c>). Keys are always strings, so the emitted property
    /// type is <c>Dictionary&lt;string, V&gt;</c>. Mirrors the TS/Python map value mapping.
    /// </summary>
    public static string MapValueType(MetaField field)
    {
        if (field.ObjectRef is { } oref && oref.Length > 0)
            return Pascal(StripPkg(oref));
        var vt = field.ValueType;
        return vt is not null ? (ScalarFor(vt) ?? "string") : "string";
    }

    /// <summary>PascalCase the (camelCase) metadata name for a C# member/type identifier.</summary>
    public static string Pascal(string name) =>
        name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];

    // ----------------------------------------------------------------------------
    // Generated-SDK SYMBOL names — the single source of truth for the public C#
    // identifiers the generators emit. Each generator calls one of these instead of
    // re-concatenating the string inline, so the api-docs builder (which documents
    // the SDK surface) can enumerate the SAME names the generators emit. Moving the
    // concatenation here is behavior-preserving (the emitted strings are unchanged).
    // ----------------------------------------------------------------------------

    /// <summary>The entity model class name (the EF Core entity / value-object POCO): <c>Pascal(name)</c>.</summary>
    public static string ModelClassName(MetaObject obj) => Pascal(obj.Name);

    /// <summary>The routes static class name for an entity: <c>&lt;EntityPascal&gt;Routes</c>.</summary>
    public static string RoutesClassName(MetaObject entity) => Pascal(entity.Name) + "Routes";

    /// <summary>The REST collection URL segment for an entity: <c>Pluralize(name).ToLowerInvariant()</c>.</summary>
    public static string RoutePath(MetaObject entity) => Pluralize(entity.Name).ToLowerInvariant();

    /// <summary>The DbSet property name for an entity: <c>Pluralize(Pascal(name))</c>.</summary>
    public static string DbSetName(MetaObject entity) => Pluralize(Pascal(entity.Name));

    /// <summary>The per-entity filter allowlist class name: <c>&lt;EntityPascal&gt;FilterAllowlist</c>.</summary>
    public static string FilterAllowlistName(MetaObject entity) => Pascal(entity.Name) + "FilterAllowlist";

    /// <summary>The render-helper class name for a template: <c>&lt;TemplateName&gt;RenderHelper</c>.</summary>
    public static string RenderHelperName(string templateName) => templateName + "RenderHelper";

    /// <summary>The output-format prompt class name for a template: <c>&lt;TemplateName&gt;Prompt</c>.</summary>
    public static string PromptClassName(string templateName) => templateName + "Prompt";

    /// <summary>The output-parser class name for a template: <c>&lt;TemplateName&gt;Parser</c>.</summary>
    public static string ParserClassName(string templateName) => templateName + "Parser";

    /// <summary>The extractor class name for a payload value-object: <c>&lt;PayloadRef&gt;Extractor</c>.</summary>
    public static string ExtractorClassName(string payloadRef) => payloadRef + "Extractor";

    /// <summary>The reverse-finder static query class name for an entity: <c>&lt;EntityPascal&gt;Queries</c>.</summary>
    public static string QueriesClassName(MetaObject entity) => Pascal(entity.Name) + "Queries";

    /// <summary>
    /// ADR-0038 — the cross-port FK-field disambiguator for a reverse finder: the
    /// PascalCased FK field name with a single trailing <c>Id</c> dropped (but never a
    /// bare <c>Id</c> → <c>""</c>). <c>currentSceneId</c> → <c>CurrentScene</c>. This is
    /// the SSOT that makes same-pair FKs (3× GameSession→Scene) yield distinct finders.
    /// </summary>
    public static string ReverseFinderFkSegment(string fkFieldName)
    {
        var pascal = Pascal(fkFieldName);
        return pascal.Length > 2 && pascal.EndsWith("Id", StringComparison.Ordinal)
            ? pascal[..^2]
            : pascal;
    }

    /// <summary>ADR-0038 — the single-value reverse finder name: <c>Find&lt;EPlural&gt;By&lt;FkField&gt;</c>.</summary>
    public static string ReverseFinderName(MetaObject entity, string fkFieldName) =>
        $"Find{Pluralize(Pascal(entity.Name))}By{ReverseFinderFkSegment(fkFieldName)}";

    /// <summary>ADR-0038 — the batched (anti-N+1) reverse finder name: <c>Find&lt;EPlural&gt;By&lt;FkField&gt;In</c>.</summary>
    public static string ReverseFinderInName(MetaObject entity, string fkFieldName) =>
        ReverseFinderName(entity, fkFieldName) + "In";

    /// <summary>
    /// The DB table name for an entity: the <c>dbTable</c> source override, else the
    /// raw object name. Shared so the schema DDL and the [Table] annotation agree.
    /// </summary>
    public static string Table(MetaObject entity) => entity.DbTable ?? entity.Name;

    /// <summary>
    /// The DB column name for a field: the <c>@column</c> override, else the raw
    /// field name run through <paramref name="strategy"/>. Shared so the schema
    /// DDL and the [Column] annotation agree.
    /// </summary>
    public static string Column(MetaField field, ColumnNamingStrategy strategy = ColumnNamingStrategy.Literal) =>
        field.DbColumn ?? ApplyStrategy(field.Name, strategy);

    /// <summary>Apply <paramref name="strategy"/> to a raw field name.</summary>
    public static string ApplyStrategy(string name, ColumnNamingStrategy strategy) => strategy switch
    {
        ColumnNamingStrategy.Literal    => name,
        ColumnNamingStrategy.SnakeCase  => ToSnakeCase(name),
        ColumnNamingStrategy.KebabCase  => ToSnakeCase(name).Replace('_', '-'),
        _ => name,
    };

    // Insert _ between lower→upper (camelCase) and at the end of an acronym run
    // (UPPER followed by Upper+lower, e.g. URLHost → url_host).
    private static string ToSnakeCase(string s)
    {
        if (string.IsNullOrEmpty(s)) return s;
        var sb = new System.Text.StringBuilder(s.Length + 4);
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (i > 0 && char.IsUpper(c))
            {
                var prev = s[i - 1];
                var next = i + 1 < s.Length ? s[i + 1] : '\0';
                if (char.IsLower(prev) || char.IsDigit(prev) || (char.IsUpper(prev) && char.IsLower(next)))
                    sb.Append('_');
            }
            sb.Append(char.ToLowerInvariant(c));
        }
        return sb.ToString();
    }

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
