// Field/entity -> idiomatic C# (EF Core) type + name mapping for codegen.
//
// Property names are PascalCase (C# convention); the metadata field name is
// preserved as the DB column via [Column(...)] so the wire/DB contract is
// unchanged. Scalar subtypes map to the natural .NET types; date/time/timestamp
// use the modern DateOnly/TimeOnly/DateTime trio.

using MetaObjects.Meta;
using MetaObjects.Persistence.Db;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Identity.IdentityConstants;
using static MetaObjects.Core.Index.IndexConstants;
using static MetaObjects.Persistence.Source.SourceConstants;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Codegen;

/// <summary>Physical name + logical field name for one field (§A2/§A3 names artifact).</summary>
public sealed record FieldNames(string Name, string Column);

/// <summary>
/// One <c>source.rdb</c> child, under the ROLE it plays.
///
/// <para>The physical name is carried under an alias NAMED FOR THE KIND — <c>table</c>,
/// <c>view</c>, <c>materializedView</c>, <c>proc</c>, <c>function</c> — and that alias is
/// not invented here: it is <see cref="SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND"/>, the
/// metamodel's own FR-016/ADR-0018 map, the same one the canonical serializer rewrites
/// through. So the artifact spells a physical name the way the metadata that declared it
/// does, and the emitted constant is <c>SourcePrimaryTable</c> / <c>SourceReplicaView</c> /
/// <c>SourcePrimaryProc</c> rather than one <c>Name</c> that meant three different things
/// depending on which object you were looking at.</para>
///
/// <para><c>ReadOnly</c> is deliberately NOT carried, and its removal is the shape's own
/// rule applied to itself: it is not metadata at all but a derivation over <c>@kind</c>
/// (<see cref="MetaSource.IsReadOnly"/>), and a sweep of all five ports found ZERO
/// consumers, generated or hand-written. An artifact that mirrors the metadata tree carries
/// what was declared; a reader who wants read-only-ness asks <c>Kind</c>, which is the thing
/// the author actually wrote.</para>
/// </summary>
public sealed record SourceNames
{
    /// <summary>The metamodel type — always <c>source</c>.</summary>
    public required string Type { get; init; }
    /// <summary>The metamodel subType — <c>rdb</c> today (ADR-0007's one paradigm).</summary>
    public required string SubType { get; init; }
    /// <summary>The <c>@kind</c> value, defaulted per ADR-0007 Rule 3 — the discriminator
    /// for <see cref="PhysicalNameAlias"/>.</summary>
    public required string Kind { get; init; }
    /// <summary>The <c>@schema</c> attr, or null when the source declares none. Null rather
    /// than <c>""</c>: absent means "the dialect's default", which a consumer expresses by
    /// omitting the qualifier entirely — emitting <c>"public"</c> would be this artifact
    /// inventing a name the author never wrote.</summary>
    public string? Schema { get; init; }
    /// <summary>The kind's alias key from <see cref="SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND"/>
    /// — <c>table</c> | <c>view</c> | <c>materializedView</c> | <c>proc</c> | <c>function</c>.
    /// Null only if a future <c>@kind</c> carries no physical-name slot.</summary>
    public string? PhysicalNameAlias { get; init; }
    /// <summary>The physical name itself, carried under <see cref="PhysicalNameAlias"/>.</summary>
    public string? PhysicalName { get; init; }
}

/// <summary>
/// One <c>identity.*</c> or <c>index.*</c> child.
///
/// <para><see cref="SubType"/> is load-bearing rather than decorative: it is the ONLY thing
/// distinguishing a unique alternate key from a non-unique lookup index, which is the whole
/// reason ADR-0040 put uniqueness in the type rather than in an attribute.</para>
///
/// <para><see cref="Index"/> — the database name — is present only where a shared resolver
/// produces it: <c>identity.secondary</c> and <c>index.lookup</c>, via
/// <see cref="IndexNaming.ResolveIndexName"/>. It is deliberately ABSENT on
/// <c>identity.primary</c>, because no such name exists to carry: migrate hardcodes
/// <c>&lt;table&gt;_pkey</c> on Postgres, emits an unnamed PK on SQLite, and no port's
/// codegen names a primary key at all. Carrying it would restate a migrate-only,
/// dialect-conditional formula in an artifact whose entire promise is that a name is spelled
/// once — the #293 defect, re-created by the mechanism built to prevent it. Absent on
/// <c>identity.reference</c> for the same reason unless a constraint name is explicitly
/// declared.</para>
/// </summary>
public sealed record KeyNames
{
    /// <summary>The metamodel type — <c>identity</c> or <c>index</c>.</summary>
    public required string Type { get; init; }
    /// <summary>The metamodel subType — <c>primary</c> | <c>secondary</c> | <c>reference</c> | <c>lookup</c>.</summary>
    public required string SubType { get; init; }
    /// <summary>The node's metamodel name.</summary>
    public required string Name { get; init; }
    /// <summary>The database index name. Present for <c>identity.secondary</c> and
    /// <c>index.lookup</c> only.</summary>
    public string? Index { get; init; }
}

/// <summary>
/// §A2/§A3 — the resolved physical-name shape for an object: what
/// <see cref="Generators.NamesGenerator"/> emits as <c>&lt;Entity&gt;Names</c>, and what
/// the EF Core bindings (entity/db-context generators) are meant to consume instead of
/// re-deriving the same names independently. Mirrors the TS reference
/// <c>ObjectNames</c>/<c>FieldNames</c> (codegen-ts/src/names.ts).
/// </summary>
public sealed record ObjectNames
{
    /// <summary>The metamodel type — always <c>object</c>.</summary>
    public required string Type { get; init; }
    /// <summary>The metamodel subType — <c>entity</c> | <c>projection</c> | <c>value</c>.</summary>
    public required string SubType { get; init; }
    /// <summary>
    /// The object's OWN name — <c>"Customer"</c>, not <c>"TBL_CUST_MASTER"</c>.
    /// <para>It held the PHYSICAL name until 0.25.0, and that is the one change here a
    /// hand-written consumer can adopt WITHOUT a compile error: <c>[Table(CustomerNames.Name)]</c>
    /// still compiles and now binds a table called <c>Customer</c>. No gate can see it,
    /// because the code that breaks is not generated.</para>
    /// </summary>
    public required string Name { get; init; }
    /// <summary>
    /// Every <c>source.rdb</c> child, keyed by effective <c>@role</c> (<c>primary</c> |
    /// <c>replica</c>).
    /// <para>Role is the honest axis: the loader requires exactly one primary, and every
    /// consumer that binds a second source picks it by role. Keying by role is also what
    /// finally gives a WRITE-THROUGH entity's replica view a home — it declares two physical
    /// names, the artifact carried one, and <c>AppDbContext.g.cs</c> emitted the second as a
    /// literal.</para>
    /// <para>Empty on a FRAGMENT: an abstract base with no source of its own contributes
    /// columns and must never acquire a physical name it never declared.</para>
    /// </summary>
    public required IReadOnlyDictionary<string, SourceNames> Sources { get; init; }
    /// <summary>The sources DECLARED HERE — what this artifact emits. See <see cref="OwnFields"/>.</summary>
    public required IReadOnlyDictionary<string, SourceNames> OwnSources { get; init; }
    /// <summary>
    /// Every field, INHERITED INCLUDED. This is what a consumer looks a column up in, so a
    /// lookup for an inherited field must hit — miss and the caller falls back to a literal
    /// (see <see cref="CSharpNaming.ColumnRef"/>), which is the whole defect this artifact
    /// exists to remove.
    /// </summary>
    public required IReadOnlyDictionary<string, FieldNames> Fields { get; init; }
    /// <summary>
    /// The fields DECLARED HERE — what the artifact EMITS. Inherited ones are declared by
    /// the super's artifact and reached through C# base-class inheritance, so a subtype
    /// states each physical name once instead of restating its parent's.
    /// <para>ADR-0039's ONE sanctioned own-accessor use, in the exact form the ADR names it:
    /// codegen emitting a generated subclass, iterating own members so inherited ones are
    /// not re-emitted.</para>
    /// </summary>
    public required IReadOnlyDictionary<string, FieldNames> OwnFields { get; init; }
    /// <summary>Every <c>identity.*</c> child, inherited included; keyed by metamodel name.</summary>
    public required IReadOnlyDictionary<string, KeyNames> Identities { get; init; }
    /// <summary>The identities DECLARED HERE. See <see cref="OwnFields"/>.</summary>
    public required IReadOnlyDictionary<string, KeyNames> OwnIdentities { get; init; }
    /// <summary>Every <c>index.*</c> child, inherited included; keyed by metamodel name.</summary>
    public required IReadOnlyDictionary<string, KeyNames> Indexes { get; init; }
    /// <summary>The indexes DECLARED HERE. See <see cref="OwnFields"/>.</summary>
    public required IReadOnlyDictionary<string, KeyNames> OwnIndexes { get; init; }
    /// <summary>The nearest ancestor carrying an artifact of its own, when there is one.</summary>
    public SuperNames? SuperNames { get; init; }
    /// <summary>
    /// True when the primary source is the SUPER's rather than declared here — a TPH
    /// subtype, which shares its base's single table. Structural (the two resolve to the
    /// SAME source node), never an equality test on the resolved strings.
    /// <para>It does NOT decide what gets emitted — <see cref="OwnSources"/> does, and for a
    /// TPH subtype that is empty, so C# base-class inheritance carries the base's
    /// <c>SourcePrimaryTable</c> down without anything here having to ask. It is kept
    /// because it is the structural FACT a consumer may want to read, and because deriving
    /// it once beside the source lookup is cheaper than every caller re-deriving it.</para>
    /// </summary>
    public bool InheritsSource { get; init; }
}

/// <summary>The object whose names artifact this one extends.</summary>
public sealed record SuperNames(string Name, string? Package);

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
    /// semantics via <c>@localTime: true</c> (a naive wall-clock value).
    /// ADR-0039: resolving — <c>@localTime</c> is a logical/semantic property and may
    /// be inherited via extends (unlike the physical, never-inherited @dbColumnType).
    /// Always false for non-timestamp fields.
    /// </summary>
    public static bool IsLocalTime(MetaField field) =>
        field.SubType == FIELD_SUBTYPE_TIMESTAMP && field.Attr(DbConstants.FIELD_ATTR_LOCAL_TIME) is true;

    /// <summary>
    /// #234 — true iff <paramref name="field"/> is a <c>field.uri</c> / <c>field.inet</c> carrying
    /// <c>@lenient=true</c> (the opt-out of strict well-formedness). A lenient uri/inet degrades to a
    /// plain <c>string</c> property (no <c>System.Uri</c> / <c>IPAddress</c> type, no strict
    /// <c>[JsonConverter]</c>, and a <c>text</c> DB column). Resolving read (<c>field.Attr</c> walks
    /// <c>extends</c>) so an abstract <c>field.uri @lenient</c> inherited via <c>extends</c> degrades too.
    /// </summary>
    public static bool IsLenientNet(MetaField field) =>
        (field.SubType == FIELD_SUBTYPE_URI || field.SubType == FIELD_SUBTYPE_INET)
        && field.Attr(FIELD_ATTR_LENIENT) is true;

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
        IsLocalTime(field) ? "DateTime"
        // #234: a @lenient field.uri / field.inet is a plain string (not System.Uri / IPAddress).
        : IsLenientNet(field) ? "string"
        : ScalarFor(field.SubType);

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
        obj.Fields().Any(f => !f.ResolvedIsArray() && f.SubType == FIELD_SUBTYPE_INET && !IsLenientNet(f));

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

    /// <summary>
    /// #214 — the view read-model class name for a write-through entity: <c>&lt;EntityPascal&gt;View</c>.
    /// EF Core cannot map one CLR type to both a table and a view, so a write-through entity
    /// needs a SECOND, view-mapped CLR type carrying the derived fields the write table omits.
    /// </summary>
    public static string ViewModelClassName(MetaObject entity) => Pascal(entity.Name) + "View";

    /// <summary>#214 — the read-model DbSet property name for a write-through entity: <c>Pluralize(&lt;Entity&gt;View)</c>.</summary>
    public static string ViewDbSetName(MetaObject entity) => Pluralize(ViewModelClassName(entity));

    /// <summary>The per-entity filter allowlist class name: <c>&lt;EntityPascal&gt;FilterAllowlist</c>.</summary>
    public static string FilterAllowlistName(MetaObject entity) => Pascal(entity.Name) + "FilterAllowlist";

    /// <summary>The per-object physical database names class name: <c>&lt;EntityPascal&gt;Names</c>.</summary>
    public static string NamesClassName(MetaObject entity) => NamesClassName(entity.Name);

    /// <summary>Overload taking a bare object name — used when only a super's NAME is in hand.</summary>
    public static string NamesClassName(string objectName) => Pascal(objectName) + "Names";

    /// <summary>The render-helper class name for a template: <c>&lt;TemplateName&gt;RenderHelper</c>.</summary>
    public static string RenderHelperName(string templateName) => templateName + "RenderHelper";

    /// <summary>
    /// The FR-010 response-format fragment class name for a responding prompt:
    /// <c>&lt;PromptName&gt;ResponseFormat</c>. ADR-0052 D4 — named for the DIRECTION, not the
    /// subtype: the pre-ADR <c>&lt;Name&gt;Prompt</c> read as "ClassifyPromptPrompt" once the
    /// tier moved onto <c>template.prompt</c>, which is the confusion the ADR removes.
    /// </summary>
    public static string ResponseFormatClassName(string templateName) => templateName + "ResponseFormat";

    /// <summary>The response-parser class name for a responding prompt: <c>&lt;PromptName&gt;Parser</c>.</summary>
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
    /// <para>
    /// Runs the SAME divergence refusal as <see cref="ResolveObjectNames"/>, and now from
    /// the same code: <see cref="MetaObject.DbTable"/> resolves through
    /// <c>FindPrimaryWritableSource</c>, which calls
    /// <see cref="SourceResolution.RefuseDivergentPrimaries"/>. It has to: this is the arm
    /// a run takes when the <c>names</c> generator is NOT selected, and without the check
    /// a divergent object silently emitted
    /// <c>[Table("&lt;the inherited primary's name&gt;")]</c> — binding the parent's table
    /// while the child declared its own — on exactly the arm where nothing else looks.
    /// A refusal that depends on which generators ran is not a refusal.
    /// </para>
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
    /// #248 — true iff <paramref name="obj"/> declares (or inherits) a primary
    /// <c>source.rdb</c> of ANY kind (table, view, proc, ...). The cheap existence half
    /// of the names-artifact participation gate: whether a primary source exists does
    /// not depend on <see cref="ColumnNamingStrategy"/>, so this never needs one. It
    /// resolves no NAME, which is why it carries no divergence refusal: that lives in
    /// <see cref="SourceResolution.RefuseDivergentPrimaries"/>, reached by every caller
    /// that does resolve one.
    /// ADR-0039: <c>Sources()</c> is the RESOLVING accessor — an inherited primary
    /// source must be seen.
    /// </summary>
    public static bool HasPrimarySource(MetaObject obj) =>
        obj.Sources().Any(s => s.Role == SOURCE_ROLE_PRIMARY);

    /// <summary>
    /// §A2/§A3 — the ONE place a data name is resolved for a generator run. Both
    /// <see cref="Generators.NamesGenerator"/> (the names artifact) and the EF Core
    /// bindings it backs (entity / db-context generators) are meant to call this rather
    /// than each re-deriving <see cref="Table"/>/<see cref="Column"/> independently, so
    /// the constant and the binding it describes cannot be produced by two different
    /// resolvers or two different argument sets. A name computed twice is a name that
    /// can disagree with itself.
    /// <para>
    /// Returns <c>null</c> when <paramref name="obj"/> has no primary source — #248:
    /// participation in the database derives from a declared primary source, never from
    /// the object subtype.
    /// </para>
    /// </summary>
    public static ObjectNames? ResolveObjectNames(MetaObject obj, ColumnNamingStrategy strategy = ColumnNamingStrategy.Literal)
    {
        // SourceResolution.PrimaryRdbSource, not a scan of our own: ADR-0039's RESOLVING
        // source accessor (an inherited primary must be seen, or an entity extending an
        // abstract base with its own primary source would wrongly read as unpersisted),
        // AND the divergence refusal that used to live in this method — see below.
        var source = SourceResolution.PrimaryRdbSource(obj);
        if (source is null) return null;

        var fields = new Dictionary<string, FieldNames>(StringComparer.Ordinal);
        // ADR-0039: Fields() is the RESOLVING accessor — an inherited @column must
        // resolve here, or the constant disagrees with the column EF actually binds.
        foreach (var f in obj.Fields())
            fields[f.Name] = new FieldNames(f.Name, Column(f, strategy));
        // ADR-0039's sanctioned own-accessor use: what this artifact DECLARES.
        var ownFields = new Dictionary<string, FieldNames>(StringComparer.Ordinal);
        foreach (var f in obj.OwnFields())
            ownFields[f.Name] = new FieldNames(f.Name, Column(f, strategy));

        var superObj = NamesArtifactSuperOf(obj);
        // Identity of the resolved source NODE, not equality of the resolved strings: a
        // divergence guard is exactly what this codebase forbids here, and the question
        // being asked is structural — did this object declare a source, or is it using its
        // parent's?
        var inheritsSource = superObj is not null &&
            ReferenceEquals(SourceResolution.PrimaryRdbSource(superObj), source);

        // The divergence refusal — an object whose @role: primary sources resolve to more
        // than one physical name — used to live HERE, and that was the defect. Every
        // consumer downstream references this name UNCONDITIONALLY, with no per-site
        // equality guard, but this method runs only when the `names` generator is in the
        // run — so the M:N RUNTIME resolver, which reads MetaObject.DbTable and executes
        // SQL against it, got no refusal at all. It now lives in
        // MetaObjects.Meta.SourceResolution, reached through PrimaryRdbSource above and
        // through FindPrimaryWritableSource for DbTable, so codegen and runtime inherit
        // one implementation. See that class's doc for the reachability analysis — the
        // shape loads with ZERO errors — and for why the check is DIRECTION-BLIND.

        return new ObjectNames
        {
            Type = TYPE_OBJECT,
            SubType = obj.SubType,
            // The object's OWN name. The primary source's physical name is now reached
            // through Sources[role].PhysicalName, which is the point of the restructure: one
            // key stopped meaning a table, a view and a procedure depending on the object.
            Name = obj.Name,
            Sources = SourcesOf(obj.Sources(), obj.Name),
            OwnSources = SourcesOf(obj.OwnSources(), obj.Name),
            Fields = fields,
            OwnFields = ownFields,
            Identities = KeysOf(obj.Identities()),
            OwnIdentities = KeysOf(obj.OwnIdentities()),
            Indexes = KeysOf(obj.LookupIndexes()),
            OwnIndexes = KeysOf(obj.OwnLookupIndexes()),
            SuperNames = SuperRefOf(superObj),
            InheritsSource = inheritsSource,
        };
    }

    /// <summary>
    /// One source node's names, with the physical name carried under the metamodel's own
    /// kind→alias key. Never a local switch on <c>@kind</c>: a sixth kind must not need an
    /// edit here to be spelled correctly, and a local copy is a second answer to a question
    /// the metamodel already answers — the defect class this file exists for.
    /// </summary>
    private static SourceNames SourceNamesOf(MetaSource source)
    {
        // EffectiveKind, not a hand-rolled kind list — derived from the source's own logic
        // so a second kind list here can't drift from the loader's.
        var kind = source.EffectiveKind;
        PHYSICAL_NAME_ATTR_BY_KIND.TryGetValue(kind, out var alias);
        return new SourceNames
        {
            Type = TYPE_SOURCE,
            SubType = source.SubType,
            Kind = kind,
            Schema = source.Schema,
            PhysicalNameAlias = alias,
            PhysicalName = alias is null ? null : source.PhysicalName,
        };
    }

    /// <summary>
    /// Every <c>source.rdb</c> child of an object, keyed by effective <c>@role</c>.
    /// <para>The refusal below is about DISAGREEMENT, not about the count — deliberately the
    /// SAME rule <see cref="SourceResolution.PrimaryRdbSource"/> already enforces for the
    /// physical name, rather than a stricter one invented here. An abstract base and the
    /// child that extends it may each declare a <c>@role: primary</c> source naming the same
    /// relation; that is legal today, and refusing it would make this artifact stricter than
    /// the invariant it exists to serve.</para>
    /// <para>Two sources in one role that resolve DIFFERENTLY is the real problem, and
    /// silently keeping one is the `dropped` failure mode this artifact makes impossible:
    /// the second name would be carried nowhere, read by nobody, while the binding quietly
    /// took the first's.</para>
    /// </summary>
    private static IReadOnlyDictionary<string, SourceNames> SourcesOf(
        IReadOnlyList<MetaSource> sources, string where)
    {
        var outMap = new Dictionary<string, SourceNames>(StringComparer.Ordinal);
        foreach (var src in sources)
        {
            var resolved = SourceNamesOf(src);
            if (!outMap.TryGetValue(src.Role, out var existing)) { outMap[src.Role] = resolved; continue; }
            // Record value equality — every member compared, not just the physical name.
            if (existing != resolved)
                throw new InvalidOperationException(
                    $"{where} declares more than one source.rdb with @role: \"{src.Role}\", and they " +
                    $"do not agree: {existing} vs {resolved}. The names artifact keys sources by " +
                    "role, so the second has nowhere to go.");
        }
        return outMap;
    }

    /// <summary>
    /// The nodes whose database index name the artifact carries.
    /// <para>A closed set rather than "anything with a name", because the rule is narrow and
    /// worth stating: the artifact carries a physical name only where ONE resolver, shared by
    /// every consumer, produces it. <c>identity.primary</c> and <c>identity.reference</c>
    /// have names that are addressing handles, not database names — see
    /// <see cref="KeyNames.Index"/>.</para>
    /// </summary>
    private static readonly HashSet<string> IndexNamedSubTypes = new(StringComparer.Ordinal)
    {
        $"{TYPE_IDENTITY}.{IDENTITY_SUBTYPE_SECONDARY}",
        $"{TYPE_INDEX}.{INDEX_SUBTYPE_LOOKUP}",
    };

    /// <summary>Every <c>identity.*</c> / <c>index.*</c> child, keyed by metamodel name.</summary>
    private static IReadOnlyDictionary<string, KeyNames> KeysOf(IEnumerable<MetaData> nodes)
    {
        var outMap = new Dictionary<string, KeyNames>(StringComparer.Ordinal);
        foreach (var node in nodes)
        {
            // IndexNaming.ResolveIndexName owns BOTH the package strip and the empty-name
            // refusal, so the artifact and any DDL that ever reads it cannot disagree about
            // what an index is called — and an `index.lookup` with an empty name (which the
            // loader accepts, unlike an identity) fails here instead of reaching an emitter.
            var carriesIndexName = IndexNamedSubTypes.Contains($"{node.Type}.{node.SubType}");
            outMap[node.Name] = new KeyNames
            {
                Type = node.Type,
                SubType = node.SubType,
                Name = node.Name,
                Index = carriesIndexName ? IndexNaming.ResolveIndexName(node) : null,
            };
        }
        return outMap;
    }

    /// <summary>
    /// Whether <paramref name="obj"/> DECLARES anything a names artifact carries.
    /// <para>One predicate, because the artifact has four collections and the two places
    /// that ask this question must agree about all four. They used to ask about fields
    /// alone, and the cost was precise: an intermediate abstract declaring only an
    /// <c>identity.secondary</c> — a key hoisted onto a chain, which is the whole reason
    /// such a node exists — answered "no". <see cref="NamesArtifactSuperOf"/> then walked
    /// past it and <see cref="ResolveSuperFragmentNames"/> emitted nothing for it, so its
    /// key appeared in NEITHER the child's own set nor the grandparent's.</para>
    /// <para>ADR-0039: the own-only accessors are correct HERE — the question is what this
    /// node declares, not what it can see. An inherited key belongs to the ancestor that
    /// declared it and is reached through that ancestor's artifact.</para>
    /// </summary>
    private static bool DeclaresNamesContent(MetaObject obj) =>
        obj.OwnFields().Count > 0
        || obj.OwnIdentities().Count > 0
        || obj.OwnLookupIndexes().Count > 0;

    /// <summary>
    /// The nearest ancestor of <paramref name="obj"/> that carries a names artifact of its
    /// own, or <c>null</c>.
    /// <para>Walks PAST an ancestor with nothing to contribute — an abstract marker with no
    /// fields, no keys and no source emits no artifact, so there is nothing to extend and
    /// the search continues upward rather than stopping at a class that does not
    /// exist.</para>
    /// </summary>
    public static MetaObject? NamesArtifactSuperOf(MetaObject obj)
    {
        for (var cur = obj.SuperData; cur is not null; cur = cur.SuperData)
        {
            if (cur is MetaObject candidate &&
                (DeclaresNamesContent(candidate) || SourceResolution.PrimaryRdbSource(candidate) is not null))
                return candidate;
        }
        return null;
    }

    private static SuperNames? SuperRefOf(MetaObject? sup) =>
        sup is null ? null : new SuperNames(sup.Name, sup.Package);

    /// <summary>
    /// The names FRAGMENT for an object that a sourced object extends but which declares no
    /// source of its own — the <c>BaseEntity</c> pattern: shared fields, no table.
    /// <para>Separate from <see cref="ResolveObjectNames"/> on purpose, and the separation
    /// is the #248 rule intact rather than weakened. "Has a primary source" still decides
    /// whether an object is a database participant, so an <c>object.value</c> carrying
    /// fields resolves to nothing here as it always has. A fragment is emitted only for an
    /// object REACHED from a participant by walking <c>extends</c> upward — which is the
    /// only context in which its fields are columns at all. It carries no
    /// <c>Kind</c>/<c>Name</c>/<c>ReadOnly</c>, because it has no physical name and must
    /// never acquire one.</para>
    /// <para>Returns <c>null</c> when the object declares nothing of its own: an abstract
    /// marker has nothing to extend, and emitting an empty class for it would put a name in
    /// the namespace that says nothing. "Nothing" is <see cref="DeclaresNamesContent"/> —
    /// fields OR keys, the same question <see cref="NamesArtifactSuperOf"/> asks, so the
    /// walk and the emit cannot disagree about which ancestors exist.</para>
    /// </summary>
    public static ObjectNames? ResolveSuperFragmentNames(
        MetaObject obj, ColumnNamingStrategy strategy = ColumnNamingStrategy.Literal)
    {
        if (!DeclaresNamesContent(obj)) return null;
        var own = obj.OwnFields();

        var fields = new Dictionary<string, FieldNames>(StringComparer.Ordinal);
        foreach (var f in obj.Fields())
            fields[f.Name] = new FieldNames(f.Name, Column(f, strategy));
        var ownFields = new Dictionary<string, FieldNames>(StringComparer.Ordinal);
        foreach (var f in own)
            ownFields[f.Name] = new FieldNames(f.Name, Column(f, strategy));

        return new ObjectNames
        {
            Type = TYPE_OBJECT,
            SubType = obj.SubType,
            Name = obj.Name,
            // Empty. A fragment declares no source and must never acquire a physical name it
            // never wrote — the phantom-table failure #248 exists to prevent.
            Sources = new Dictionary<string, SourceNames>(StringComparer.Ordinal),
            OwnSources = new Dictionary<string, SourceNames>(StringComparer.Ordinal),
            Fields = fields,
            OwnFields = ownFields,
            Identities = KeysOf(obj.Identities()),
            OwnIdentities = KeysOf(obj.OwnIdentities()),
            Indexes = KeysOf(obj.LookupIndexes()),
            OwnIndexes = KeysOf(obj.OwnLookupIndexes()),
            SuperNames = SuperRefOf(NamesArtifactSuperOf(obj)),
            InheritsSource = false,
        };
    }

    // ----------------------------------------------------------------------------
    // The artifact's MEMBER names — `<Type><Key><Member>`, one definition shared by the
    // generator that emits them and every consumption site that references them. A member
    // name spelled twice is a member name that can disagree with itself, which is the same
    // defect one level down from the one this file exists to prevent.
    // ----------------------------------------------------------------------------

    /// <summary>
    /// A metamodel name → one PascalCase C# identifier segment, splitting on every
    /// non-alphanumeric run: <c>uq_cust_email</c> → <c>UqCustEmail</c>.
    /// <para>Distinct from <see cref="Pascal"/>, which only upper-cases the FIRST character
    /// and is what field members have always used (<c>customerId</c> → <c>CustomerId</c>).
    /// Field names are camelCase by convention and Pascal is right for them; identity and
    /// index names are snake_case by convention (<c>uq_cust_email</c>, <c>ix_cust_status</c>)
    /// and <c>Pascal</c> would leave <c>Uq_cust_email</c> — a legal identifier, and an ugly
    /// one nobody would reference by hand.</para>
    /// <para>This returns a SEGMENT, never a complete identifier, and every caller below
    /// concatenates it AFTER a type prefix (<c>Identity</c>, <c>Index</c>, <c>Source</c>).
    /// So it does not guard a leading digit, and must not: it used to prepend <c>_</c> when
    /// the segment began with one, which protected a first character this function never
    /// produces and injected a stray underscore into the middle of every identifier that
    /// hit it — an index named <c>2fa-idx</c> came out as <c>Index_2faIdxIndex</c>. A digit
    /// mid-identifier is legal C#. If a caller is ever added that puts this segment FIRST,
    /// the guard belongs at that call site, where the identifier actually starts.</para>
    /// <para>Two names differing only in non-alphanumerics still fold together
    /// (<c>2fa</c> and <c>_2fa</c> both tokenize to <c>2fa</c>). That is inherent to
    /// stripping separators and is caught by the duplicate-member refusal, not here.</para>
    /// </summary>
    public static string PascalToken(string name)
    {
        var sb = new System.Text.StringBuilder(name.Length);
        var startOfSegment = true;
        foreach (var c in name)
        {
            if (!char.IsLetterOrDigit(c)) { startOfSegment = true; continue; }
            sb.Append(startOfSegment ? char.ToUpperInvariant(c) : c);
            startOfSegment = false;
        }
        // A name made entirely of separators would otherwise vanish, silently welding the
        // prefix to the member ("IdentityIndex"). "_" keeps the segment visible.
        return sb.Length == 0 ? "_" : sb.ToString();
    }

    /// <summary>The member prefix for one source: <c>Source</c> + the role — <c>SourcePrimary</c>.</summary>
    public static string SourceMemberPrefix(string role) => Pascal(TYPE_SOURCE) + PascalToken(role);

    /// <summary>
    /// One source member: <c>SourcePrimaryTable</c>, <c>SourceReplicaView</c>,
    /// <c>SourcePrimarySchema</c>. <paramref name="member"/> is the physical-name alias from
    /// <see cref="SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND"/>, or one of the fixed
    /// <c>type</c>/<c>subType</c>/<c>kind</c>/<c>schema</c> keys.
    /// </summary>
    public static string SourceMemberName(string role, string member) =>
        SourceMemberPrefix(role) + PascalToken(member);

    /// <summary>
    /// One identity/index member: <c>IdentityPkName</c>, <c>IdentityUqCustEmailIndex</c>,
    /// <c>IndexIxCustStatusIndex</c>.
    /// <para>The TYPE prefix is load-bearing, not decoration. <c>identity.primary</c>'s
    /// loader <c>defaultName</c> is <c>"primary"</c> (spec/metamodel/identity.json), so
    /// without it an unnamed primary key's members would be <c>PrimaryType</c>/
    /// <c>PrimaryName</c> — colliding, silently, with the source in role <c>primary</c>.</para>
    /// </summary>
    public static string KeyMemberName(string type, string keyName, string member) =>
        Pascal(type) + PascalToken(keyName) + PascalToken(member);

    /// <summary>One field member: <c>EmailField</c> / <c>EmailColumn</c>. See <see cref="PascalToken"/>
    /// for why this stays on <see cref="Pascal"/>.</summary>
    public static string FieldMemberName(string fieldName, string member) =>
        Pascal(fieldName) + Pascal(member);

    /// <summary>The <c>type</c>/<c>subType</c>/<c>name</c> member keys every node carries.</summary>
    public const string MEMBER_TYPE = "type";
    public const string MEMBER_SUB_TYPE = "subType";
    public const string MEMBER_NAME = "name";
    /// <summary>The <c>kind</c> member key on a source, and the <c>index</c> member key on a key node.</summary>
    public const string MEMBER_KIND = "kind";
    public const string MEMBER_INDEX = "index";
    /// <summary>The <c>field</c>/<c>column</c> member keys on a field.</summary>
    public const string MEMBER_FIELD = "field";
    public const string MEMBER_COLUMN = "column";

    /// <summary>
    /// §A6 — the <c>&lt;Owner&gt;Names.&lt;Field&gt;Column</c> constant reference for
    /// <paramref name="field"/>, when BOTH of two independent gates hold; the bare
    /// quoted physical-column literal otherwise (the exact spelling every consumption
    /// site used before Program A added the constant — git 488143e21). Neither gate is
    /// the divergence check — an object whose <c>@role: primary</c> sources disagree on a
    /// physical name has ALREADY thrown, once, inside
    /// <see cref="SourceResolution.RefuseDivergentPrimaries"/>, which every caller that
    /// resolves a name goes through; this is presence and existence, not agreement.
    /// <list type="bullet">
    /// <item><b>C1 — RUN-LEVEL presence</b> (<paramref name="includeNames"/>): is the
    /// <c>names</c> generator even part of THIS run? <c>--generators
    /// entity,db-context</c> (a documented, individually-selectable subset —
    /// <c>GenCommand.DefaultGeneratorNames</c>'s own doc comment says every default
    /// name is selectable individually) emits no <c>&lt;Owner&gt;Names.g.cs</c> at all,
    /// for any object, no matter what <see cref="ResolveObjectNames"/> would say — the
    /// caller supplies this fact; it is never derived from the object.</item>
    /// <item><b>I1 — PER-OBJECT existence</b> (<see cref="ResolveObjectNames"/> non-null):
    /// does <paramref name="owner"/> resolve a names artifact AT ALL? A miss here is
    /// NORMAL — e.g. a value-object-hosted field, whose owner has no primary source and
    /// so no names artifact at all (FR-024 value purity forbids one). Entity and
    /// TPH-subtype fields always hit (when C1 also holds): each owns its own
    /// <c>&lt;Owner&gt;Names.g.cs</c>, resolved over its own <c>Fields()</c> (ADR-0039
    /// resolving), the exact set this method iterates.</item>
    /// </list>
    /// </summary>
    public static string ColumnRef(MetaObject owner, MetaField field, ColumnNamingStrategy strategy, bool includeNames)
    {
        var names = includeNames ? ResolveObjectNames(owner, strategy) : null;
        return names is not null && names.Fields.ContainsKey(field.Name)
            ? $"{NamesClassName(owner)}.{FieldMemberName(field.Name, MEMBER_COLUMN)}"
            : $"\"{Column(field, strategy)}\"";
    }

    /// <summary>
    /// I1/§A6 — the <c>&lt;Owner&gt;Names.Source&lt;Role&gt;&lt;Alias&gt;</c> constant reference for <paramref
    /// name="obj"/>'s physical table/view/proc name, when BOTH C1 (<paramref
    /// name="includeNames"/> — is the <c>names</c> generator part of THIS run, same as
    /// <see cref="ColumnRef"/>) and this method's OWN existence gate
    /// (<see cref="ResolveObjectNames"/> non-null) hold; <paramref name="literal"/>
    /// (quoted) otherwise — the caller's own pre-Program-A spelling
    /// (<see cref="Table"/> for an entity's <c>[Table(...)]</c>; an object's own
    /// <c>DbView</c> for a projection's <c>.ToView(...)</c>).
    /// <para>
    /// The existence gate matters here in a way <see cref="ColumnRef"/> already
    /// handled: #248 — participation derives from a declared primary source, never the
    /// object subtype — so a concrete <c>object.entity</c> with NO source at all (legal;
    /// <c>ValidateOnePrimarySource</c>'s own-sources-empty branch is a documented no-op,
    /// not a load error) resolves no names artifact, no matter which generators ran.
    /// <see cref="Generators.EntityGenerator"/>'s <c>mapped</c> set is a broader SUBTYPE gate
    /// (<c>IsEntity() || DbView != null</c>) that still includes such an object, so its
    /// <c>[Table(...)]</c> line must fall back rather than reference a constant that
    /// will never exist for it.
    /// </para>
    /// <para>
    /// Neither gate is the divergence check — an object whose <c>@role: primary</c>
    /// sources disagree on a physical name has ALREADY thrown, once, inside
    /// <see cref="SourceResolution.RefuseDivergentPrimaries"/>.
    /// </para>
    /// </summary>
    /// <para>
    /// <paramref name="role"/> selects WHICH source — the parameter that did not exist while
    /// the artifact held one name. A write-through entity declares TWO physical names;
    /// passing the replica's role is how its read view stops being a literal in
    /// <c>AppDbContext.g.cs</c>. Never guess the role: take it from the source node the
    /// caller already selected (<see cref="MetaObject.ReplicaSource"/>), or a second
    /// derivation creeps back in under a different name.
    /// </para>
    /// </summary>
    public static string NameRef(
        MetaObject obj, ColumnNamingStrategy strategy, bool includeNames, string literal,
        string role = SOURCE_ROLE_PRIMARY) =>
        SourceNameMember(obj, strategy, includeNames, role) ?? $"\"{literal}\"";

    /// <summary>
    /// The <c>&lt;Owner&gt;Names.Source&lt;Role&gt;&lt;Alias&gt;</c> physical-name
    /// expression for <paramref name="obj"/>'s source in <paramref name="role"/>, or
    /// <c>null</c> when there is nothing to reference — <see cref="NameRef"/>'s two gates,
    /// plus "that role has a source and its <c>@kind</c> carries a physical-name slot".
    /// <para>The alias is read off the resolved source rather than taken as a parameter, so
    /// a call site cannot ask for <c>SourcePrimaryTable</c> on an object whose primary source
    /// is a view — the artifact would not declare that member and the file would not
    /// compile, which is the guarantee, but failing here names the model instead.</para>
    /// </summary>
    public static string? SourceNameMember(
        MetaObject obj, ColumnNamingStrategy strategy, bool includeNames,
        string role = SOURCE_ROLE_PRIMARY)
    {
        if (!includeNames) return null;
        var src = ResolveObjectNames(obj, strategy)?.Sources.GetValueOrDefault(role);
        // No alias means a @kind carrying no physical-name slot. Falling back to the literal
        // keeps a future kind from emitting a member that was never declared.
        return src?.PhysicalNameAlias is null
            ? null
            : $"{NamesClassName(obj)}.{SourceMemberName(role, src.PhysicalNameAlias)}";
    }

    /// <summary>
    /// The <c>&lt;Owner&gt;Names.Source&lt;Role&gt;Schema</c> expression, or <c>null</c> when
    /// the source in <paramref name="role"/> declares no <c>@schema</c> (or the artifact is
    /// not in this run). Null rather than a literal fallback for the ABSENT case: an absent
    /// <c>@schema</c> means "the dialect's default", which a caller expresses by omitting the
    /// qualifier entirely.
    /// </summary>
    public static string? SourceSchemaMember(
        MetaObject obj, ColumnNamingStrategy strategy, bool includeNames,
        string role = SOURCE_ROLE_PRIMARY)
    {
        if (!includeNames) return null;
        var src = ResolveObjectNames(obj, strategy)?.Sources.GetValueOrDefault(role);
        return string.IsNullOrEmpty(src?.Schema)
            ? null
            : $"{NamesClassName(obj)}.{SourceMemberName(role, SOURCE_ATTR_SCHEMA)}";
    }

    /// <summary>
    /// The <c>Schema = ...</c> argument for an EF <c>[Table]</c> attribute, or the empty
    /// string when the object declares no <c>@schema</c>.
    /// </summary>
    /// <remarks>
    /// migrate-ts qualifies every table it creates (<c>CREATE TABLE "sales"."widgets"</c>)
    /// and owns where a table lives (ADR-0015); an unqualified <c>[Table]</c> binds whatever
    /// the connection's <c>search_path</c> resolves to, which is the adopter's configuration
    /// rather than the model's intent. Dropping it did not fail loudly — it silently read a
    /// different table, or the right one, depending on the deployment.
    /// </remarks>
    public static string TableSchemaArg(
        MetaObject obj, ColumnNamingStrategy strategy, bool includeNames,
        string role = SOURCE_ROLE_PRIMARY)
    {
        var src = ResolveObjectNames(obj, strategy)?.Sources.GetValueOrDefault(role);
        if (string.IsNullOrEmpty(src?.Schema)) return "";
        return SourceSchemaMember(obj, strategy, includeNames, role) is { } member
            ? $", Schema = {member}"
            : $", Schema = \"{src.Schema}\"";
    }

    /// <summary>
    /// The <c>&lt;Owner&gt;Names</c> class a consumption site may reference for
    /// <paramref name="obj"/> — when both of <see cref="NameRef"/>'s gates hold (C1: the
    /// <c>names</c> generator is part of THIS run; the object resolves a names artifact at
    /// all) — or <c>null</c>, meaning "spell the literal". <see cref="NameRef"/> and
    /// <see cref="ColumnRef"/> hand back a ready-made expression; this is for a site that
    /// composes the constant into something other than a bare attribute argument — a raw-SQL
    /// string, a doc comment — and so must know WHICH arm it is on. Same two gates, one place.
    /// </summary>
    public static string? NamesClassIfReferenced(MetaObject obj, ColumnNamingStrategy strategy, bool includeNames) =>
        includeNames && ResolveObjectNames(obj, strategy) is not null ? NamesClassName(obj) : null;

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
        // ADR-0039: resolving — @required may be inherited from an abstract base via extends.
        if (field.Attr(FIELD_ATTR_REQUIRED) is true) return true;
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
