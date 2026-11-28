// routes-generator — emits ASP.NET Core Minimal API CRUD endpoints per entity.
//
// One static class per entity with a Map<Entity>Routes(this IEndpointRouteBuilder,
// string prefix) extension. Single-PK entities get full CRUD (list/get/post/
// patch/put/delete) over the generated AppDbContext; composite-/no-PK entities
// get the collection GET only (item addressing needs a single key) with a
// warning.
//
// Cross-port API contract conformed by the generated handlers
// (see docs/features/api-contract.md):
//   - GET list honours ?limit=N&offset=N pagination. With `api.pagination` set, no limit
//     takes `defaultLimit` and a limit above `maxLimit` is 400 { "error": "limit_too_large",
//     "maxLimit": N }; without it, no limit answers 50 rows (ApiSettings.DefaultPageLimit,
//     the default of every port) and an explicit limit is served as asked.
//   - GET list honours ?sort=<field>:asc|desc against static SortRules derived from the
//     entity's scalar fields (case-insensitive lookup); ?sort=<field> takes the field's
//     @sortableDefaultOrder. Unknown field → 400 { "error": "invalid_sort", "field": ... }.
//   - GET list honours ?search= (case-insensitive, over the filterable text fields) and
//     filter[or][i] / filter[and][i] groups, five levels deep. A bare ?<field>= is
//     400 filter.bare_field and a leading % on like is filter.leading_wildcard_disallowed.
//   - A body that is not JSON is 400 { "error": "invalid_json" }, and a path id the key's type
//     cannot hold is 400 { "error": "invalid_id" } (RouteErrors).
//   - Create, PATCH and PUT: under `api.unknownFields: reject` (the default) a body key no
//     field declares is 400 { "error": "unknown_fields", "fields": [...] } (UnknownFieldCheck);
//     under `drop` it is ignored. A failed validation is 400 { "error": "validation",
//     "issues": [{ code, path, message }, ...] } listing every issue (ValidationIssues).
//   - GET list honours ?withCount=1 → switches the envelope from a bare row
//     array to { rows, total }. The grid hook always sends withCount=1.
//   - Update accepts BOTH PATCH and PUT (TS reference exposes both; we match).
//   - 404 responses carry a JSON envelope: { "error": "not_found" }.
//   - A read-only projection mounts the reads AND every write verb, each answering
//     405 { "error": "method_not_allowed" } (F22) — see WriteProjectionRejects.
//   - A view-backed report (FR-044) is served as a keyless read: the list GET and a 405
//     on POST, with no /{id} address at all (a report has no identity).
//
// Filter operators (eq/ne/gt/gte/lt/lte/in/like/isNull) ship via FR-009 — the
// generated list handler calls ListQueryParser.Parse against the per-entity
// <Entity>FilterAllowlist (emitted by FilterAllowlistGenerator), then
// applies the parsed filter tree and search onto the IQueryable<T> via
// EfCoreFilterDispatch.Apply. Those helpers (and ValueObjectValidator,
// ConstraintErrors) live in the namespace HelperRuntimeNamespace names: the
// MetaObjects.AspNetCore package for the packaged generator, the adopter's
// own codegen/runtime/ copy (Codegen.Runtime) once `dotnet meta eject routes` has
// copied both — see MetaObjects.Codegen.HelperRuntime.

using System.Text;
using MetaObjects.Codegen.Writer;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Object.ObjectConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>Generates Minimal API CRUD route registration per <c>object.entity</c>.</summary>
public class RoutesGenerator : PerEntityGenerator
{
    public override string Name => "routes-generator";

    // Where the emitted routes import ListQueryParser / EfCoreFilterDispatch / RouteErrors /
    // ValueObjectValidator / ConstraintErrors from. `dotnet meta eject routes` rewrites
    // this one line to "Codegen.Runtime" and copies those helpers' source into
    // codegen/runtime/, so an owned copy's output binds to code the adopter owns.
    private const string HelperRuntimeNamespace = "MetaObjects.AspNetCore";

    public override bool Filter(MetaObject entity) =>
        // FR-044: a report has routes iff it is served (see AppliesTo).
        entity.IsReport()
            ? ReportRows.IsViewBacked(entity)
            : (entity.IsEntity() || entity.DbView is not null) && InstanceArtifacts.EmitsInstanceArtifacts(entity);

    /// <summary>
    /// True iff this entity gets a generated routes file: it passes <see cref="Filter"/>
    /// (persisted, instance-emitting) and is NOT a TPH subtype (subtypes are served via
    /// the base's per-subtype routes). Single source of truth shared by the generator
    /// loop AND the api-docs builder (so docs never claim REST a routes-off entity lacks).
    /// </summary>
    public static bool AppliesTo(MetaObject entity, MetaRoot root) =>
        // FR-044 — a report applies iff it is served: its read source is a view (contract
        // Table A). Asked of the report itself, so the declared node (what the api-docs
        // builder and a test harness pass) and its row model (what Generate iterates) get
        // the same answer. A sourceless report mounts nothing.
        entity.IsReport()
            ? ReportRows.IsViewBacked(entity)
            : (entity.IsEntity() || entity.DbView is not null)
                && InstanceArtifacts.EmitsInstanceArtifacts(entity)
                && !TphPlanBuilder.IsTphSubtype(entity, root);

    // FR-017 TPH: a concrete subtype is served via its base's per-subtype routes — it
    // emits NO standalone routes file (the base mounts polymorphic + per-subtype CRUD).
    // The subtype skip needs the root, which Filter doesn't receive, so it is applied
    // here where the GenContext is in scope.
    // FR-044 — a served report joins the set as its ROW MODEL (ReportRows): a keyless,
    // projection-shaped object, so GenerateStandardRoutes emits the list GET and the POST
    // refusal and nothing else. A raw report node in the entity set is dropped.
    public override IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var served = ReportRows.WithReportRows(ctx.Narrow(Include))
            .Where(e => AppliesTo(e, ctx.Root))
            .ToList();
        // One routes entry is mounted under one prefix, so two objects whose segments match
        // serve one path. A TPH subtype is served under its base's segment and claims none.
        // Each entry of the run is its own scope: two entries mount under two prefixes.
        var entry = ctx.EntryLabel(this);
        foreach (var e in served.Where(e => e.OwnAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE) is not string { Length: > 0 }))
            ctx.Claim($"the REST collection segments of routes entry {entry}", CSharpNaming.RoutePath(e), e.ResolutionKey(),
                "rename one, set @collectionName on one of them, or generate them with two routes entries mounted under different prefixes",
                NameClaims.ERR_COLLECTION_NAME_COLLISION);
        foreach (var e in served.Where(e => e.OwnAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE) is not string { Length: > 0 }))
            ctx.Claim($"the C# namespace {ValueObjectNames.CompanionNamespace(e, ctx.Config)}", $"{CSharpNaming.Pascal(e.Name)}Routes", e.ResolutionKey(),
                ctx.Config.PackageNamespacesFromMetadata
                    ? "map the packages to distinct namespaces (csharp.packageNamespaces, or GenConfig.PackageNamespaces), or rename one"
                    : "rename one");
        return served.Select(e => GenerateOne(e, ctx));
    }

    protected override EmittedFile GenerateOne(MetaObject entity, GenContext ctx)
    {
        if (TphPlanBuilder.For(entity, ctx.Root) is { } tph)
            return GenerateTphRoutes(entity, tph, ctx);
        return GenerateStandardRoutes(entity, ctx);
    }

    // #367 — a generated route file carries no auth by default; ASP.NET Core applies no
    // policy to a bare Map* call, and an adopter that doesn't notice ships it open. The XML
    // doc on the mount method is the one place a consumer reads before wiring it into their
    // host, so it says so and shows the fix rather than leaving it to a README nobody opens.
    protected virtual void WriteUnauthenticatedRoutesDoc(CsWriter w, string cls, bool readOnly)
    {
        var verbs = readOnly ? "read endpoints" : "endpoints";
        w.Line($"/// <summary>Maps <c>{cls}</c> REST routes. Unauthenticated — see remarks.</summary>");
        w.Line("/// <remarks>");
        w.Line($"/// These {verbs} are unauthenticated. Guard them by mapping on a group that requires");
        w.Line($"/// authorization, e.g. <c>app.MapGroup(\"\").RequireAuthorization().Map{cls}Routes();</c>");
        w.Line("/// A row-ownership rule (\"only the owner may read this row\") cannot be expressed on a mount:");
        w.Line($"/// eject this generator with <c>dotnet meta eject</c> and hand-write those {verbs}.");
        w.Line("/// </remarks>");
    }

    /// <summary>
    /// The most rows a report list answers when its generator sets no cap, the same default in
    /// every port. With no <c>limit</c> a report answers every row up to the cap and is refused
    /// above it, never truncated.
    /// </summary>
    public const int DefaultReportMaxRows = 10_000;

    /// <summary>
    /// The row cap of a report list route: <c>new RoutesGenerator { ReportMaxRows = 500 }</c>.
    /// With no <c>limit</c> the route answers every row up to the cap; one more row, or a
    /// <c>limit</c> above the cap, is <c>400 { "error": "report_too_large", "maxRows": N }</c>.
    /// Reports only: an entity's list keeps its paging.
    /// </summary>
    public int ReportMaxRows { get; init; } = DefaultReportMaxRows;

    // A report answers all of its rows or refuses: no silent page default and no truncation. A
    // bound that is not usable (limit below 1, negative offset, not an integer) is refused with
    // the envelope the TypeScript mounts use, rather than ignored. The query fetches one row past
    // the cap when no limit was sent, so the refusal comes before any body is written.
    //
    // ONE CAP RULE, TWO NAMES. Without ?format the cap is ReportMaxRows and the refusal is
    // report_too_large. With a report-export generator wired and ?format set, the export cap
    // (that generator's MaxRows) governs instead and the refusal is export_too_large;
    // report_too_large never answers on an export. With no report-export generator wired the
    // emitted text is the same as before export existed.
    protected virtual void WriteReportPaging(CsWriter w, int? exportMaxRows)
    {
        var max = ReportMaxRows.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var tooLarge = "Results.BadRequest(new { error = \"report_too_large\", maxRows })";
        w.Line("// Pagination (report): every row up to the cap, refused above it.");
        if (exportMaxRows is not { } exportCap)
        {
            w.Line($"const int maxRows = {max};");
        }
        else
        {
            var exportMax = exportCap.ToString(System.Globalization.CultureInfo.InvariantCulture);
            w.Line($"const int listMaxRows = {max};");
            w.Line($"const int exportMaxRows = {exportMax};");
            w.Line("// With ?format the export cap governs and report_too_large never answers.");
            w.Line("var maxRows = format is null ? listMaxRows : exportMaxRows;");
            tooLarge = "format is null ? " + tooLarge + " : ReportExportHttp.TooLarge(maxRows)";
        }
        // ListQueryParser has refused a bound that is not a non-negative integer; a report also refuses
        // limit=0 (a bad bound, not an empty answer) and a limit above the cap.
        w.Line("var limit = listQuery.Limit;");
        w.Line("if (limit == 0)");
        using (w.Hanging()) w.Line("return Results.BadRequest(new { error = \"pagination.invalid_value\", param = \"limit\", value = \"0\", expected = $\"an integer from 1 to {maxRows}\" });");
        w.Line("if (limit > maxRows)");
        using (w.Hanging()) w.Line($"return {tooLarge};");
        WriteSkip(w);
        w.Line("q = q.Take((int)(limit ?? maxRows + 1L));");
        w.Blank();
        w.Line("var rows = await q.ToListAsync();");
        w.Line("if (limit is null && rows.Count > maxRows)");
        using (w.Hanging()) w.Line($"return {tooLarge};");
    }

    // A report-export download: the rows are fetched exactly as the list route fetches them, then
    // written as CSV or XML by the module the report-export generator emitted for this report. A JSON
    // export is the list route's own body, written by the withCount tail below.
    protected virtual void WriteReportExportBranch(CsWriter w, string cls, string route)
    {
        w.Blank();
        w.Line("// Export (report-export): the same rows as a download. withCount with csv or xml was refused above.");
        w.Line("if (format == \"csv\")");
        using (w.Hanging()) w.Line($"return ReportExportHttp.Csv(http, \"{route}\", w => {cls}Export.WriteCsv(w, rows));");
        w.Line("if (format == \"xml\")");
        using (w.Hanging()) w.Line($"return ReportExportHttp.Xml(http, \"{route}\", w => {cls}Export.WriteXml(w, rows));");
    }

    // Every type the route file names bare — the entity itself, its value objects (owned and map
    // values) and the targets and junctions of its M:N traversals — so a split-namespace model gets
    // a `using` for each package namespace the home-namespace file reaches into.
    protected static IEnumerable<MetaData> ReferencedTypes(IEnumerable<MetaObject> entities, MetaRoot root)
    {
        foreach (var entity in entities)
        {
            yield return entity;
            foreach (var f in entity.Fields())
                if ((f.SubType == FIELD_SUBTYPE_OBJECT || f.SubType == FIELD_SUBTYPE_MAP)
                    && ValueObjectNames.ResolveFieldRef(f, root) is { } target && target.IsValue())
                    yield return target;
            foreach (var nav in M2MNavigationBuilder.For(entity, root, _ => { }))
            {
                yield return nav.Target;
                yield return nav.Junction;
            }
        }
    }

    // The pieces of a routes file, one overridable method each (ADR-0063 item 7): a subclass changes
    // the piece it wants and keeps the rest. Not a stability contract.

    /// <summary>The writer a routes file is written on.</summary>
    protected virtual CsWriter NewWriter() => new();

    /// <summary>
    /// Everything a standard (non-TPH) routes file is written from, worked out once by
    /// <see cref="PlanStandardRoutes"/> so every piece reads the same answers.
    /// </summary>
    protected record StandardRoutesPlan(
        MetaObject Entity, GenContext Ctx, string Cls, string DbSet, string Route,
        IReadOnlyList<string> PkFields, string? PkType, string? PkProp,
        bool IsProjection, bool HasItem, bool Writable, bool WriteThrough, string ReadCls, string ReadDbSet,
        List<VoField> VoFields, List<MapVoField> MapVoFields, List<AutoSetField> AutoSetFields,
        List<string> FrozenNavs, List<MetaField> DeniedFields, List<string> Credentials,
        string TableRef, string PkColumnRef, bool IsReport, int? ExportMaxRows,
        List<MetaField> SortFieldNodes, List<string> SortFields, HashSet<string> DecimalSortFields, bool SqliteSort)
    {
        /// <summary>The generated DbContext's type, as the route handlers name it.</summary>
        public string ContextType => ValueObjectNames.ContextTypeRef(Ctx.Config);
    }

    /// <summary>Work out what the standard routes file for <paramref name="entity"/> serves.</summary>
    protected virtual StandardRoutesPlan PlanStandardRoutes(MetaObject entity, GenContext ctx)
    {
        var cls = CSharpNaming.Pascal(entity.Name);
        var dbSet = CSharpNaming.DbSetName(entity);
        var route = CSharpNaming.RoutePath(entity);

        var pkFields = entity.PrimaryIdentity()?.Fields ?? [];
        string? pkType = null;
        string? pkProp = null;
        if (pkFields.Count == 1)
        {
            var pkField = entity.Fields().FirstOrDefault(f => f.Name == pkFields[0]);
            if (pkField is not null)
            {
                pkType = CSharpNaming.ScalarFor(pkField.SubType);
                pkProp = CSharpNaming.PropertyName(pkField, ctx.Config);
            }
        }
        bool isProjection = entity.IsReadOnlyProjection();
        bool hasItem = pkType is not null;           // GET by id (readable by key)
        bool writable = hasItem && !isProjection;    // mutations only on writable sources
        // #214 (FR-024 §7) — a write-through entity: READS route to the replica view read
        // model (carrying the derived fields), WRITES to the table. readCls/readDbSet are the
        // view model + its DbSet; for a vanilla entity / projection they collapse to the entity
        // itself, so the emitted output is byte-identical.
        bool writeThrough = entity.IsWriteThrough();
        var readCls = writeThrough ? CSharpNaming.ViewModelClassName(entity) : cls;
        var readDbSet = writeThrough ? CSharpNaming.ViewDbSetName(entity) : dbSet;

        // Program D — value-object jsonb columns (field.object @storage:jsonb, single AND
        // @isArray). These are EF owned-nav properties (not scalar EntityType.Properties), so
        // the generic PATCH merge loop's FindProperty misses them; the create handler's
        // top-level TryValidateObject also does NOT recurse into them. The generator emits
        // typed per-field merge arms + per-field POST validation for each.
        var voFields = ValueObjectFields(entity, ctx.Root, ctx.Config.ColumnNamingStrategy, ctx.Config.IncludeNames, ctx.Config);
        // #362 — the map analog. Separate from voFields (see MapValueObjectFields): a map is a
        // plain jsonb-converted property, but its VALUES are value objects and need the same
        // graph validation on create and on a present PATCH key.
        var mapVoFields = MapValueObjectFields(entity, ctx.Root, ctx.Config);
        // Issue #203 — @autoSet timestamp columns the generated CRUD stamps with now()
        // (insert stamps all; update stamps onUpdate; the merge loop skips them; an
        // InsertPreserving escape hatch is emitted when any exist).
        var autoSetFields = AutoSetFields(entity, ctx.Config);
        // FR-037 R1 — readOnly / writeOnce are excluded from the PATCH merge.
        var frozenNavs = FrozenNavs(entity, ctx.Config);
        // #484 — write-denied (@formExclude or credential) keys are ignored on every write; credentials never leave.
        var deniedFields = WriteDeniedFields(entity);
        var credentials = CredentialNames(entity, ctx.Config);
        // Physical table + PK column for the post-save array-null clear (EF OwnsMany ToJson
        // writes [] for a null nav, so a nullable array column is NULLed via raw SQL). Both
        // are C# EXPRESSIONS — the <Entity>Names constant when the names artifact is in this
        // run, the quoted literal otherwise — spliced into that SQL by WriteArrayNullClears.
        var tableRef = CSharpNaming.NameRef(entity, ctx.Config.ColumnNamingStrategy, ctx.Config.IncludeNames, CSharpNaming.Table(entity), qualify: ctx.Config);
        var pkColumnRef = pkFields.Count == 1 && entity.Fields().FirstOrDefault(f => f.Name == pkFields[0]) is { } pkf
            ? CSharpNaming.ColumnRef(entity, pkf, ctx.Config.ColumnNamingStrategy, ctx.Config.IncludeNames, ctx.Config)
            : "\"id\"";
        // A report has no identity by definition, so "no primary key" is not a finding on one.
        bool isReport = entity.IsReport();
        // The wired report-export generator, if the run lists one: only then does a report list
        // route grow a `?format=` branch (and only a report's: an entity has no export in this version).
        var export = isReport ? ctx.ReportExportMaxRows : null;
        if (!hasItem && !isReport)
            ctx.Warn($"{Name}: \"{entity.Name}\" has no single-column primary key — emitting collection GET only.");

        // Sort allowlist: every scalar field on the entity is sortable. The
        // generated handler does case-insensitive lookup so the wire grammar
        // (?sort=createdAt:desc) matches the C# property name (CreatedAt).
        //
        // FR-044 — on a REPORT an enum dimension sorts too (contract Table C: every derived
        // field with a filter band is filterable and sortable). Report-only, so an entity's
        // or projection's allowlist keeps its bytes. The sort arm is the same
        // EF.Property<object>(x, "<Name>") as any other field; the row maps the enum with
        // HasConversion<string>() (or to its integer under @intValueMap), so the ORDER BY is
        // over the stored column.
        var sortFieldNodes = entity.Fields()
            .Where(f => (CSharpNaming.ScalarFor(f.SubType) is not null
                         || (isReport && f.SubType == FIELD_SUBTYPE_ENUM))
                        && !f.ResolvedIsArray()
                        && !IsCredentialField(f))   // a credential column would be a sort oracle (any entity, not only a report)
            .ToList();
        var sortFields = sortFieldNodes.Select(f => CSharpNaming.PropertyName(f, ctx.Config)).ToList();

        // ADR-0019 Amendment 1 (W4): SQLite refuses `ORDER BY` over a decimal expression, and its
        // NUMERIC column is a double anyway, so on SQLite a decimal sorts by its double. Every
        // other engine sorts the exact decimal.
        var decimalSortFields = entity.Fields()
            .Where(f => f.SubType == FIELD_SUBTYPE_DECIMAL && !f.ResolvedIsArray()
                        && CSharpNaming.DbColumnTypeClrOverride(f) is null)
            .Select(f => CSharpNaming.PropertyName(f, ctx.Config))
            .ToHashSet(StringComparer.Ordinal);
        bool sqliteSort = sortFields.Any(decimalSortFields.Contains);

        return new StandardRoutesPlan(
            entity, ctx, cls, dbSet, route, pkFields, pkType, pkProp,
            isProjection, hasItem, writable, writeThrough, readCls, readDbSet,
            voFields, mapVoFields, autoSetFields, frozenNavs, deniedFields, credentials,
            tableRef, pkColumnRef, isReport, export, sortFieldNodes, sortFields, decimalSortFields, sqliteSort);
    }

    protected virtual EmittedFile GenerateStandardRoutes(MetaObject entity, GenContext ctx)
    {
        var p = PlanStandardRoutes(entity, ctx);
        var w = NewWriter();
        WriteFileHeader(w, [entity], entity, ctx, tph: false);
        w.Line($"public static class {p.Cls}Routes");
        w.Open("{");
        // Static sort allowlist (case-insensitive) so the qs ?sort=field:dir
        // is gated against the entity's scalar fields.
        WriteSortRules(w, "SortRules", p.SortFieldNodes, ctx.Config);
        if (p.Writable) WriteKnownFields(w, [entity], ctx.Root);
        WriteUnauthenticatedRoutesDoc(w, p.Cls, p.IsProjection);
        w.Line($"public static IEndpointRouteBuilder Map{p.Cls}Routes(this IEndpointRouteBuilder app, string prefix = \"/api\")");
        w.Open("{");
        // Refuse to start when the host's serializer contract cannot be read to strip a credential.
        if (p.Credentials.Count > 0)
            w.Line($"SerializerKeys.EnsureContract(app.ServiceProvider, new System.Type[] {{ typeof({p.ReadCls}) }}, {NamesLiteral(p.Credentials)});");
        WriteDecimalRangeGroup(w);

        WriteListRoute(w, p);
        if (p.HasItem) WriteGetRoute(w, p);
        if (p.Writable)
        {
            WriteCreateRoute(w, p);
            WriteUpdateRoute(w, p);
            WriteDeleteRoute(w, p);
        }
        else if (p.IsProjection)
        {
            WriteProjectionRejects(w, p.Route, p.PkType, p.HasItem, p.IsReport ? "report" : "projection");
        }

        // FR-018 M:N traversal — GET /<source-plural>/{id}/<relationName> through the
        // junction. Only on a single-PK source (the route addresses the source by id).
        // Cross-port contract: source URL segment = pluralized ENTITY name, relation
        // segment = relationship name.
        if (p.HasItem)
            foreach (var nav in M2MNavigationBuilder.For(entity, ctx.Root, ctx.Warn))
                WriteM2mRoute(w, nav, p.Route, p.PkType!, ctx.Root, ctx.Config);

        w.Blank();
        w.Line("return mount;");
        w.Close("}");
        w.Blank();
        WriteApplySort(w, p);
        // Issue #203 — the verbatim-insert escape hatch, only for an entity with @autoSet
        // fields (writable entities only; a read-only projection has no insert path).
        if (p.Writable && p.AutoSetFields.Count > 0)
            WriteInsertPreserving(w, p.Cls, p.DbSet, p.ContextType);
        WriteOmitResultClass(w, p.Credentials.Count > 0 || (p.HasItem && M2mTargetHasCredentials([entity], ctx.Root, ctx.Config)));
        w.Close("}");

        return new EmittedFile(OutputPaths.Of(entity, ctx, $"{p.Cls}Routes.g.cs"), w.ToString()) { SourceNode = entity.ResolutionKey() };
    }

    /// <summary>
    /// The generated-file marker, the generator's name, the nullable context, the usings (one per
    /// package namespace the file reaches into, from <paramref name="referenced"/>) and the
    /// namespace of <paramref name="home"/>.
    /// </summary>
    protected virtual void WriteFileHeader(CsWriter w, IEnumerable<MetaObject> referenced, MetaObject home, GenContext ctx, bool tph)
    {
        w.Line("// <auto-generated/>");
        w.Line(tph
            ? "// Generated by MetaObjects routes-generator (TPH). Do not edit by hand."
            : "// Generated by MetaObjects routes-generator. Do not edit by hand.");
        w.Line("#nullable enable");
        w.Line("using System.Linq;");
        w.Line("using Microsoft.AspNetCore.Builder;");
        w.Line("using Microsoft.AspNetCore.Http;");
        w.Line("using Microsoft.AspNetCore.Routing;");
        w.Line("using Microsoft.EntityFrameworkCore;");
        w.Line($"using {HelperRuntimeNamespace};");
        if (!ctx.Config.PackageNamespacesFromMetadata)
            foreach (var u in PackageBindingResolver.HomeUsings(ctx.Config, ReferencedTypes(referenced, ctx.Root))) w.Line(u);
        w.Blank();
        w.Line($"namespace {ValueObjectNames.CompanionNamespace(home, ctx.Config)};");
        w.Blank();
    }

    /// <summary>The list route: <c>GET /&lt;route&gt;</c> with filter, sort, paging and <c>withCount</c> (and a report's export branch).</summary>
    protected virtual void WriteListRoute(CsWriter w, StandardRoutesPlan p)
    {
        var (cls, route, readCls, readDbSet, credentials, export) = (p.Cls, p.Route, p.ReadCls, p.ReadDbSet, p.Credentials, p.ExportMaxRows);
        // List — honours ?limit / ?offset / ?sort / ?withCount per api-contract.md.
        w.Line("app.MapGet(prefix + \"/" + route + "\", async (HttpContext http, " + p.ContextType + " db) =>");
        w.Open("{");
        w.Line("var qs = http.Request.Query;");
        if (export is not null)
        {
            w.Line("// Export (report-export): ?format=csv|json|xml. An unknown format, or withCount with csv or xml, is refused before any query runs.");
            w.Line("var format = ReportExportHttp.Requested(qs);");
            w.Line("if (ReportExportHttp.Refuse(format, qs) is { } exportRefusal) return exportRefusal;");
        }
        w.Line($"IQueryable<{readCls}> q = db." + readDbSet + ".AsNoTracking();");
        w.Blank();
        var fm = FilterMapArg($"{cls}FilterAllowlist", p.Entity, p.Ctx.Config);
        WriteListQuery(w, readCls, $"{cls}FilterAllowlist", fm, "SortRules",
            p.SqliteSort
                ? $"ApplySort{cls}(q, __sortProp, desc, db.Database.ProviderName?.Contains(\"Sqlite\", System.StringComparison.OrdinalIgnoreCase) == true)"
                : $"ApplySort{cls}(q, __sortProp, desc)");
        w.Blank();
        if (p.IsReport)
        {
            WriteReportPaging(w, export);
            if (export is not null) WriteReportExportBranch(w, cls, route);
        }
        else
        {
            WriteListPage(w, p.Ctx.Root.Api.Pagination);
            w.Blank();
            w.Line("var rows = await q.ToListAsync();");
        }
        w.Blank();
        w.Line("// withCount=1 → { rows, total } envelope; otherwise bare row array.");
        w.Line("var withCount = qs.TryGetValue(\"withCount\", out var wc) && (wc == \"1\" || string.Equals(wc, \"true\", System.StringComparison.OrdinalIgnoreCase));");
        if (export is null)
            w.Line($"if (!withCount) return {OkResult("rows", credentials)};");
        else
            w.Line($"if (!withCount) return format is null ? {OkResult("rows", credentials)} : ReportExportHttp.Json(http, \"{route}\", rows{ExportOmit(credentials, false)});");
        w.Line($"var totalQ = EfCoreFilterDispatch.Apply(db.{readDbSet}.AsNoTracking(), listQuery, {cls}FilterAllowlist.Rules{fm});");
        w.Line("var total = await totalQ.CountAsync();");
        if (export is null)
            w.Line($"return {OkResult("new { rows, total }", credentials, envelope: true)};");
        else
            w.Line($"return format is null ? {OkResult("new { rows, total }", credentials, envelope: true)} : ReportExportHttp.Json(http, \"{route}\", new {{ rows, total }}{ExportOmit(credentials, true)});");
        w.Close("});");
    }

    /// <summary>The item route: <c>GET /&lt;route&gt;/{id}</c>, 404 <c>not_found</c> when absent.</summary>
    protected virtual void WriteGetRoute(CsWriter w, StandardRoutesPlan p)
    {
        w.Blank();
        w.Line("app.MapGet(prefix + \"/" + p.Route + "/{id}\", async (HttpContext http, " + p.ContextType + " db) =>");
        w.Open("{");
        WriteReadId(w, p.PkType!);
        w.Line("return await db." + p.ReadDbSet + ".FindAsync(id) is { } found");
        using (w.Hanging()) w.Line("? " + OkResult("found", p.Credentials));
        using (w.Hanging()) w.Line(": Results.NotFound(new { error = \"not_found\" });");
        w.Close("});");
    }

    /// <summary>The create route: <c>POST /&lt;route&gt;</c> (see <see cref="WriteCreateHandler"/>).</summary>
    protected virtual void WriteCreateRoute(CsWriter w, StandardRoutesPlan p)
    {
        var (entity, ctx) = (p.Entity, p.Ctx);
        // FR-036 #4 — @required-key presence set (the non-PK @required fields whose keys
        // must be PRESENT + non-null on a create body). A @required VALUE-TYPE field (e.g.
        // field.timestamp → non-nullable DateTimeOffset) binds to a CLR default when
        // omitted, invisible to [Required], so the create handler checks raw-JSON presence.
        var requiredKeys = RequiredCreateKeys(entity, f => p.PkFields.Contains(f.Name));
        w.Blank();
        // #214 — a write-through create binds the derived-FREE WRITE entity, persists to
        // the table, then RE-READS the row through the replica view by PK so the returned
        // body carries the derived (view-computed) fields (read-your-writes).
        WriteCreateHandler(w, "/" + p.Route, p.Cls, p.ContextType, p.DbSet, requiredKeys,
            CreatedResult("prefix + \"/" + p.Route + "\"", "input", p.Credentials), p.VoFields, p.MapVoFields, p.AutoSetFields,
            p.WriteThrough ? (p.ReadDbSet, p.PkProp!, p.Route) : null,
            p.DeniedFields.Select(f => CSharpNaming.PropertyName(f, ctx.Config)).ToList(), p.Credentials,
            ServerOwnedCreateResets(entity, ctx.Root, ctx.Config), ctx.Root, RequiredReadOnlyProps(entity, ctx.Config));
    }

    /// <summary>
    /// The update handler and its two mounts, <c>PATCH</c> and <c>PUT /&lt;route&gt;/{id}</c>: a
    /// partial merge of the JSON body.
    /// </summary>
    protected virtual void WriteUpdateRoute(CsWriter w, StandardRoutesPlan p)
    {
        var (entity, ctx, cls, dbSet, credentials) = (p.Entity, p.Ctx, p.Cls, p.DbSet, p.Credentials);
        // PATCH + PUT share the same handler — TS reference exposes both verbs, and both
        // return the updated row (HTTP 200), matching the cross-port api-contract.
        //
        // A PARTIAL merge of the JSON body, NOT a full-row overwrite. The previous
        // implementation bound the body into a `cls input` and called
        // `CurrentValues.SetValues(input)` — but a field ABSENT from a PATCH body
        // deserializes to its CLR default (0 / null / false / DateTime.MinValue), and
        // SetValues then wrote those defaults over the live row. A `PATCH {"name":"x"}`
        // on a wide entity silently DESTROYED every other column. So enumerate the JSON
        // that was actually sent and set only those properties — the same present-field
        // merge the TPH per-subtype handler already uses. The PK stays route-authoritative.
        //
        // FR-035 PATCH-2 tristate: an OMITTED field is untouched; an explicit null
        // CLEARS a nullable column; an explicit null on a NOT-NULL (@required) column
        // is a 400. The per-key merge (shared with the TPH per-subtype handler) is
        // emitted by WritePartialMergeLoop.
        w.Blank();
        w.Line("async System.Threading.Tasks.Task<IResult> Update" + cls + "(HttpContext http, " + p.ContextType + " db)");
        w.Open("{");
        WriteReadId(w, p.PkType!);
        w.Line("var existing = await db." + dbSet + ".FindAsync(id);");
        w.Line("if (existing is null) return Results.NotFound(new { error = \"not_found\" });");
        w.Line("System.Text.Json.JsonDocument body;");
        w.Line("try { body = await System.Text.Json.JsonDocument.ParseAsync(http.Request.Body); }");
        w.Line("catch (System.Text.Json.JsonException) { return RouteErrors.InvalidJson(); }");
        w.Line("using var bodyScope = body;");
        w.Line("if (body.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object) return ValidationIssues.Unreadable();");
        WriteUnknownFieldsCheck(w, ctx.Root, "body");
        w.Line("// Deserialize each value with the app's CONFIGURED JSON options, not defaults —");
        w.Line("// a field.timestamp binds to DateTimeOffset via a custom converter registered on");
        w.Line("// ConfigureHttpJsonOptions, and default options cannot read the wire format, throwing 500.");
        w.Line("var jsonOpts = ((Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>)");
        using (w.Hanging()) w.Line("http.RequestServices.GetService(typeof(Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>))!)");
        using (w.Hanging()) w.Line(".Value.SerializerOptions;");
        w.Line("var entry = db.Entry(existing);");
        WriteUpdateAutoSet(w, p.AutoSetFields);
        WritePartialMergeLoop(w, null, p.VoFields, p.MapVoFields, p.AutoSetFields.Select(a => a.Nav).ToList(), p.FrozenNavs, HasDecimalField(entity),
            p.DeniedFields.SelectMany(f => WireKeys(f, ctx.Config)).ToList(), p.DeniedFields.Select(f => CSharpNaming.PropertyName(f, ctx.Config)).ToList(), HasIsoDurationField(entity, ctx.Root));
        WriteSaveChanges(w);
        WriteArrayNullClears(w, p.VoFields, p.TableRef, p.PkColumnRef);
        // #214 — writes target the table; for a write-through entity re-read the row
        // through the replica view by PK so the returned body carries the derived fields.
        if (p.WriteThrough)
        {
            w.Line($"var __view = await db.{p.ReadDbSet}.FindAsync(id);");
            // #214 [2] — a @kind:materializedView (unrefreshed) or filtered replica view may
            // not surface the just-written row; fall back to the write entity so the body is
            // never null (degraded — missing only the derived fields; matches the Python port).
            w.Line($"return {OkResult("(object?)__view ?? existing", credentials)};");
        }
        else
        {
            w.Line($"return {OkResult("existing", credentials)};");
        }
        w.Close("}");
        w.Line("app.MapPatch(prefix + \"/" + p.Route + "/{id}\", Update" + cls + ");");
        w.Line("app.MapPut(prefix + \"/" + p.Route + "/{id}\", Update" + cls + ");");
    }

    /// <summary>The delete route: <c>DELETE /&lt;route&gt;/{id}</c>, 204 on success, 404 <c>not_found</c> when absent.</summary>
    protected virtual void WriteDeleteRoute(CsWriter w, StandardRoutesPlan p)
    {
        w.Blank();
        w.Line("app.MapDelete(prefix + \"/" + p.Route + "/{id}\", async (HttpContext http, " + p.ContextType + " db) =>");
        w.Open("{");
        WriteReadId(w, p.PkType!);
        w.Line("var existing = await db." + p.DbSet + ".FindAsync(id);");
        w.Line("if (existing is null) return Results.NotFound(new { error = \"not_found\" });");
        w.Line("db." + p.DbSet + ".Remove(existing);");
        WriteSaveChanges(w);
        w.Line("return Results.NoContent();");
        w.Close("});");
    }

    /// <summary>
    /// The sort dispatch, <c>ApplySort&lt;Cls&gt;</c>: each allowlisted property name to an
    /// <c>IOrderedQueryable</c> through <c>EF.Property</c>.
    /// </summary>
    protected virtual void WriteApplySort(CsWriter w, StandardRoutesPlan p)
    {
        var readCls = p.ReadCls;
        // Allowlisted property name → IOrderedQueryable dispatch via EF.Property.
        // Reflection-free at runtime; EF Core translates EF.Property(x, "<Name>")
        // into the column reference at SQL generation.
        w.Line($"private static IOrderedQueryable<{readCls}> ApplySort{p.Cls}(IQueryable<{readCls}> q, string field, bool desc{(p.SqliteSort ? ", bool sqlite" : "")})");
        w.Open("{");
        w.Line("return field switch");
        w.Open("{");
        foreach (var name in p.SortFields)
        {
            var exact = NullsLargestSort("q", $"EF.Property<object>(x!, \"{name}\")");
            if (p.DecimalSortFields.Contains(name))
                w.Line($"\"{name}\" => sqlite ? ({NullsLargestSort("q", $"(double?)EF.Property<decimal?>(x!, \"{name}\")")}) : ({exact}),");
            else
                w.Line($"\"{name}\" => {exact},");
        }
        w.Line("_ => (IOrderedQueryable<" + readCls + ">)q.OrderBy(x => 0),");
        w.Close("};");
        w.Close("}");
    }

    // F22 — the write verbs on a read-only projection, each answering the cross-port
    // 405 envelope { "error": "method_not_allowed" }.
    //
    // 405 and not 404: the resource plainly exists — the same path answers GET — and a
    // 404 would tell a caller the collection is absent when it is merely not writable.
    // Mounted EXPLICITLY rather than left to ASP.NET, which answers an unmatched method
    // on a matched path with its own EMPTY-bodied 405 and so puts a body shape on the
    // wire that no other port spells. PUT is among them because the writable mount
    // serves it; the verb a projection forgets to refuse is the one that falls through
    // to a 404 — which is exactly what TypeScript did until this corpus caught it.
    //
    // The item verbs follow the item GET: a keyless projection mounts no /{id} route at
    // all, so refusing a PATCH there would claim an address the port does not serve.
    // `message` is free prose and is deliberately not part of the asserted contract.
    //
    // A view-backed report (FR-044) takes the keyless arm: POST only. `noun` is what the
    // free-prose message calls the resource ("projection" or "report").
    protected virtual void WriteProjectionRejects(CsWriter w, string route, string? pkType, bool hasItem, string noun)
    {
        w.Blank();
        WriteReject(w, "MapPost", "/" + route, "POST", null, noun);
        if (!hasItem) return;
        WriteReject(w, "MapPatch", "/" + route + "/{id}", "PATCH", pkType, noun);
        WriteReject(w, "MapPut", "/" + route + "/{id}", "PUT", pkType, noun);
        WriteReject(w, "MapDelete", "/" + route + "/{id}", "DELETE", pkType, noun);
    }

    // The item handlers take the route's `id` even though they ignore it: a typed
    // parameter makes an unparsable id a 404 from routing rather than a 405 claiming
    // the write was refused on a row that could never have been addressed.
    protected virtual void WriteReject(CsWriter w, string map, string path, string verb, string? pkType, string noun)
    {
        var parms = pkType is null ? "()" : "(" + pkType + " id)";
        w.Line("app." + map + "(prefix + \"" + path + "\", " + parms + " =>");
        using (w.Hanging()) w.Line("Results.Json(new { error = \"method_not_allowed\", message = \"" + verb
            + " is not supported on a " + noun + " (read-only).\" }, statusCode: 405));");
    }

    // FR-017 TPH routes for a discriminator base. Mirrors the TS routes-file TPH branch:
    //   - polymorphic list/get at the base path (GET /auths, /auths/{id}); NO base POST.
    //   - a full per-subtype CRUD set at /auths/<discriminatorValue lowercased>, scoped
    //     to that subtype via DbSet.OfType<Sub>():
    //       * create constructs `new Sub` (discriminator injected by EF via the CLR type;
    //         the POST body OMITS the discriminator),
    //       * get/update/delete are scoped — a cross-subtype id is invisible (404),
    //       * update is a partial merge that NEVER touches the discriminator or PK.
    //
    // The base path (auths) is the pluralized base ENTITY name lowercased. ASP.NET routes
    // the static /auths/<segment> ahead of the parametric /auths/{id}, so they coexist.
    /// <summary>
    /// Everything a TPH base's routes file is written from, worked out once by
    /// <see cref="PlanTphRoutes"/> so every piece reads the same answers.
    /// </summary>
    protected record TphRoutesPlan(
        MetaObject BaseEntity, TphPlan Tph, GenContext Ctx, string BaseCls, string DbSet, string BaseRoute,
        string? PkType, string? PkProp, bool HasItem, string DiscProp, MetaField? DiscField,
        List<string> BaseCredentials, HashSet<string> HierarchyCredentials,
        List<MetaField> SortFieldNodes, List<string> SortFields)
    {
        /// <summary>The generated DbContext's type, as the route handlers name it.</summary>
        public string ContextType => ValueObjectNames.ContextTypeRef(Ctx.Config);

        /// <summary>The base followed by every concrete subtype.</summary>
        public List<MetaObject> Hierarchy => Tph.Subtypes.Select(st => st.Entity).Prepend(BaseEntity).ToList();
    }

    /// <summary>Work out what the routes file for the TPH base <paramref name="baseEntity"/> serves.</summary>
    protected virtual TphRoutesPlan PlanTphRoutes(MetaObject baseEntity, TphPlan tph, GenContext ctx)
    {
        var baseCls = CSharpNaming.Pascal(baseEntity.Name);
        var dbSet = CSharpNaming.DbSetName(baseEntity);
        var baseRoute = CSharpNaming.RoutePath(baseEntity);

        var pkFields = baseEntity.PrimaryIdentity()?.Fields ?? [];
        if (pkFields.Count != 1)
        {
            ctx.Warn($"{Name}: TPH base \"{baseEntity.Name}\" has no single-column primary key — " +
                     "emitting polymorphic collection GET only.");
        }
        var pkField = pkFields.Count == 1 ? baseEntity.Fields().FirstOrDefault(f => f.Name == pkFields[0]) : null;
        var pkType = pkField is not null ? CSharpNaming.ScalarFor(pkField.SubType) : null;
        var pkProp = pkField is not null ? CSharpNaming.PropertyName(pkField, ctx.Config) : null;
        bool hasItem = pkType is not null;

        var discProp = baseEntity.FindField(tph.DiscriminatorField) is { } dField ? CSharpNaming.PropertyName(dField, ctx.Config) : CSharpNaming.Pascal(tph.DiscriminatorField);
        var discField = baseEntity.FindField(tph.DiscriminatorField);
        // #484 — the polymorphic base rows carry every subtype's columns, so a credential declared
        // on the base OR on any subtype is omitted from them.
        var baseCredentials = CredentialNames(baseEntity, ctx.Config)
            .Concat(tph.Subtypes.SelectMany(st => CredentialNames(st.Entity, ctx.Config)))
            .Distinct(StringComparer.Ordinal).ToList();

        // Sortable base scalar fields (the polymorphic list sorts on base columns).
        var hierarchyCredentials = TphPlanBuilder.HierarchyCredentialNames(baseEntity, ctx.Root);
        var sortFieldNodes = baseEntity.Fields()
            .Where(f => CSharpNaming.ScalarFor(f.SubType) is not null && !f.ResolvedIsArray() && !hierarchyCredentials.Contains(f.Name))
            .ToList();
        var sortFields = sortFieldNodes.Select(f => CSharpNaming.PropertyName(f, ctx.Config)).ToList();

        return new TphRoutesPlan(baseEntity, tph, ctx, baseCls, dbSet, baseRoute, pkType, pkProp, hasItem,
            discProp, discField, baseCredentials, hierarchyCredentials, sortFieldNodes, sortFields);
    }

    protected virtual EmittedFile GenerateTphRoutes(MetaObject baseEntity, TphPlan tph, GenContext ctx)
    {
        var p = PlanTphRoutes(baseEntity, tph, ctx);
        var baseCls = p.BaseCls;

        var w = NewWriter();
        WriteFileHeader(w, p.Hierarchy, baseEntity, ctx, tph: true);
        w.Line($"public static class {baseCls}Routes");
        w.Open("{");

        // Polymorphic sort allowlist over the base scalar columns.
        WriteSortRules(w, "SortRules", p.SortFieldNodes, ctx.Config);
        // One known set for the whole hierarchy: a sibling subtype's column is declared, so it is not unknown.
        WriteKnownFields(w, p.Hierarchy, ctx.Root);

        // Per-subtype sort allowlists (case-insensitive) over each subtype's EFFECTIVE
        // scalar fields (inherited base + own). The per-subtype list resolves the qs
        // ?sort=<field> through this to the CLR property name before EF.Property — a raw
        // lowercase field (e.g. "id") would otherwise fail EF translation (no "id"
        // property; it's "Id") and 500.
        foreach (var st in tph.Subtypes)
        {
            var subClsName = CSharpNaming.Pascal(st.Entity.Name);
            var subSortFields = st.Entity.Fields()
                .Where(f => CSharpNaming.ScalarFor(f.SubType) is not null && !f.ResolvedIsArray() && !p.HierarchyCredentials.Contains(f.Name))
                .ToList();
            WriteSortRules(w, $"{subClsName}SortRules", subSortFields, ctx.Config);
        }

        WriteUnauthenticatedRoutesDoc(w, baseCls, readOnly: false);
        w.Line($"public static IEndpointRouteBuilder Map{baseCls}Routes(this IEndpointRouteBuilder app, string prefix = \"/api\")");
        w.Open("{");
        if (p.BaseCredentials.Count > 0)
        {
            var credTypes = new[] { baseCls }.Concat(tph.Subtypes.Select(st => ValueObjectNames.TypeRef(st.Entity, ctx.Root, ctx.Config, ValueObjectNames.Namespace(baseEntity, ctx.Config))));
            w.Line($"SerializerKeys.EnsureContract(app.ServiceProvider, new System.Type[] {{ {string.Join(", ", credTypes.Select(t => $"typeof({t})"))} }}, {NamesLiteral(p.BaseCredentials)});");
        }
        WriteDecimalRangeGroup(w);

        WriteTphListRoute(w, p);

        if (p.HasItem)
        {
            WriteTphGetRoute(w, p);

            // FW-8 — M:N traversal declared on the BASE: every row of the shared table
            // is a legitimate source (rule a in the cross-port contract — the independent
            // oracle's expectedRoutes walks every SERVED object's RESOLVED relationships,
            // and the base is itself a served object), so the mount is byte-identical to
            // a vanilla entity's traversal at the base route. Mirrors TS
            // renderTphRoutesFile's baseM2mMounts.
            foreach (var nav in M2MNavigationBuilder.For(baseEntity, ctx.Root, ctx.Warn))
                WriteM2mRoute(w, nav, p.BaseRoute, p.PkType!, ctx.Root, ctx.Config);

            // --- Per-subtype CRUD sets ---
            var hierarchy = p.Hierarchy;
            foreach (var st in tph.Subtypes)
                WriteTphSubtypeRoutes(w, st, hierarchy, ctx.Root, ctx.Config, p.BaseRoute, baseCls, p.DbSet, p.PkType!, p.PkProp!, p.DiscProp, p.DiscField, ctx.Warn);
        }

        w.Blank();
        w.Line("return mount;");
        w.Close("}");
        w.Blank();

        WriteTphApplySort(w, p);
        // Issue #203 — a verbatim-insert escape hatch per subtype that declares @autoSet
        // fields (overloaded by the subtype parameter type; the discriminator is injected by
        // EF via the subtype CLR type on Add). Only when the subtype has @autoSet columns.
        if (p.HasItem)
            foreach (var st in tph.Subtypes)
                if (AutoSetFields(st.Entity, ctx.Config).Count > 0)
                    WriteInsertPreserving(w, ValueObjectNames.TypeRef(st.Entity, ctx.Root, ctx.Config, ValueObjectNames.Namespace(baseEntity, ctx.Config)), p.DbSet, p.ContextType);
        WriteOmitResultClass(w, p.BaseCredentials.Count > 0 || (p.HasItem && M2mTargetHasCredentials(p.Hierarchy, ctx.Root, ctx.Config)));
        w.Close("}");

        return new EmittedFile(OutputPaths.Of(baseEntity, ctx, $"{baseCls}Routes.g.cs"), w.ToString()) { SourceNode = baseEntity.ResolutionKey() };
    }

    /// <summary>The polymorphic list, <c>GET /&lt;base&gt;</c>: the union of all subtypes, each row carrying its discriminator.</summary>
    protected virtual void WriteTphListRoute(CsWriter w, TphRoutesPlan p)
    {
        var (baseCls, dbSet, ctx) = (p.BaseCls, p.DbSet, p.Ctx);
        w.Line("app.MapGet(prefix + \"/" + p.BaseRoute + "\", async (HttpContext http, " + p.ContextType + " db) =>");
        w.Open("{");
        w.Line("var qs = http.Request.Query;");
        w.Line($"IQueryable<{baseCls}> q = db.{dbSet}.AsNoTracking();");
        var fmB = FilterMapArg($"{baseCls}FilterAllowlist", p.BaseEntity, ctx.Config);
        WriteListQuery(w, baseCls, $"{baseCls}FilterAllowlist", fmB, "SortRules", "ApplySort(q, __sortProp, desc)");
        WriteListPage(w, ctx.Root.Api.Pagination);
        w.Line("var rows = await q.ToListAsync();");
        w.Line("var withCount = qs.TryGetValue(\"withCount\", out var wc) && (wc == \"1\" || string.Equals(wc, \"true\", System.StringComparison.OrdinalIgnoreCase));");
        w.Line($"if (!withCount) return {OkResult("rows", p.BaseCredentials)};");
        w.Line($"var total = await EfCoreFilterDispatch.Apply(db.{dbSet}.AsNoTracking(), listQuery, {baseCls}FilterAllowlist.Rules{fmB}).CountAsync();");
        w.Line($"return {OkResult("new { rows, total }", p.BaseCredentials, envelope: true)};");
        w.Close("});");
    }

    /// <summary>The polymorphic item route, <c>GET /&lt;base&gt;/{id}</c>: one row of whatever subtype.</summary>
    protected virtual void WriteTphGetRoute(CsWriter w, TphRoutesPlan p)
    {
        w.Blank();
        w.Line("app.MapGet(prefix + \"/" + p.BaseRoute + "/{id}\", async (HttpContext http, " + p.ContextType + " db) =>");
        w.Open("{");
        WriteReadId(w, p.PkType!);
        w.Line($"return await db.{p.DbSet}.AsNoTracking().FirstOrDefaultAsync(x => x.{p.PkProp} == id) is {{ }} found");
        using (w.Hanging()) w.Line("? " + OkResult("found", p.BaseCredentials));
        using (w.Hanging()) w.Line(": Results.NotFound(new { error = \"not_found\" });");
        w.Close("});");
    }

    /// <summary>The polymorphic sort dispatch over the base's scalar columns (reflection-free, through <c>EF.Property</c>).</summary>
    protected virtual void WriteTphApplySort(CsWriter w, TphRoutesPlan p)
    {
        w.Line($"private static IOrderedQueryable<{p.BaseCls}> ApplySort(IQueryable<{p.BaseCls}> q, string field, bool desc)");
        w.Open("{");
        w.Line("return field switch");
        w.Open("{");
        foreach (var name in p.SortFields)
            w.Line($"\"{name}\" => {NullsLargestSort("q", $"EF.Property<object>(x!, \"{name}\")")},");
        w.Line("_ => (IOrderedQueryable<" + p.BaseCls + ">)q.OrderBy(x => 0),");
        w.Close("};");
        w.Close("}");
    }

    // FR-036 #4 — the wire keys of the @required fields whose keys must be PRESENT (and
    // non-null) on a create body. Uses the SAME required-predicate as the DTO's [Required]
    // (MetaField.IsRequired = own @required OR a validator.required child), matching the
    // cross-port contract (Java's @NotNull set / Python-Pydantic required set). The caller
    // supplies the exclusion for the PK (server-/route-assigned) and, for a TPH subtype, the
    // (EF-injected) discriminator. Returns the camelCase field names — matched case-insensitively
    // against the raw JSON keys, so a camelCase wire key resolves to its PascalCase property.
    protected static List<string> RequiredCreateKeys(MetaObject obj, Func<MetaField, bool> isPkOrDisc) =>
        obj.Fields()
            // Issue #203 — an @autoSet field is server-filled (the CRUD stamps now() on
            // insert), so it is OPTIONAL on the create body even when @required. Matching
            // the cross-port contract ("a server-defaulted/@autoSet @required field is
            // correctly optional on POST") + the TS InsertSchema (autoSet fields are
            // present-but-optional). Excluded here so an omitted createdAt/updatedAt is
            // not a 400.
            // #214 — a derived (origin.*) field is view-computed and absent from the WRITE
            // entity, so it is never on the create body: exclude it from the required-key set
            // (else an omitted derived @required field would wrongly 400). Vanilla entities have
            // no derived fields → byte-identical.
            // 1.2.x security — a readOnly field is never bound from the body (private setter),
            // so demanding its key would make a @required readOnly entity uncreatable.
            .Where(f => f.IsRequired && f.AutoSet is null && !f.IsDerived() && !f.IsReadOnlyMutability
                        && !isPkOrDisc(f))
            .Select(f => f.Name)
            .ToList();

    // 1.2.x security — the CLR properties of the @required readOnly fields. The client cannot
    // set them (private setter), so their [Required] describes the stored row, not the create
    // body: the create validation ignores a violation that names only these members, as Java's
    // SERVER_OWNED_ON_CREATE filter does. Empty for nearly every model → byte-identical output.
    protected static List<string> RequiredReadOnlyProps(MetaObject obj, GenConfig config) =>
        obj.Fields()
            .Where(f => f.IsRequired && f.IsReadOnlyMutability && !f.IsDerived())
            .Select(f => CSharpNaming.PropertyName(f, config))
            .ToList();

    // Issue #203 — one @autoSet timestamp column the generated CRUD stamps with now().
    // Nav is the PascalCase CLR property; NowExpr is the now() literal keyed off the
    // COLUMN's temporal CLR type (generalizes beyond DateTimeOffset). OnUpdate columns
    // are stamped on both insert and update; onCreate columns are stamped on insert only
    // (never rewritten on update — the write-once created-at contract).
    protected record AutoSetField(string Nav, string NowExpr, bool OnUpdate);

    // The @autoSet fields (effective — inherited @autoSet resolves) whose CLR type is a
    // temporal that has a now() form. A non-temporal @autoSet field (not expected per the
    // spec) is skipped rather than emitting an ill-typed assignment.
    /// <summary>
    /// FR-037 R1 — the CLR property names a PATCH must never write: <c>@mutability</c>
    /// <c>readOnly</c> (nobody writes it) and <c>writeOnce</c> (frozen after create).
    ///
    /// <para>ADR-0045: the OUTERMOST generated write artifact enforces the mode, and for
    /// ASP.NET that is the ROUTE. <c>SetAfterSaveBehavior(Ignore)</c> is not sufficient on
    /// its own: the merge loop assigns <c>entry.CurrentValues[target]</c> and the handler
    /// returns the in-memory <c>existing</c> entity, so a caller-supplied value would be
    /// echoed in the RESPONSE even where EF omitted the column from the UPDATE. Skipping
    /// the key here is what makes the response and the row agree.</para>
    /// </summary>
    protected static List<string> FrozenNavs(MetaObject entity, GenConfig config) =>
        entity.Fields()
            .Where(f => f.Mutability != MetaObjects.Core.Field.FieldConstants.MUTABILITY_READ_WRITE)
            .Select(f => CSharpNaming.PropertyName(f, config))
            .ToList();

    // #484 — a credential is a field that declares (or inherits, ADR-0039) a view.password child.
    // A credential is never returned by a generated route; it is also never written by one.
    public static bool IsCredentialField(MetaField f) => InstanceArtifacts.IsCredentialField(f);

    // #484 — write-denied: the generated create / PATCH / PUT IGNORE the key (never a 400): the
    // effective @formExclude (resolving) or a credential.
    protected static bool IsApiWriteDenied(MetaField f) =>
        f.Attr(FIELD_ATTR_FORM_EXCLUDE) is true || IsCredentialField(f);

    protected static List<MetaField> WriteDeniedFields(MetaObject entity) =>
        entity.Fields().Where(IsApiWriteDenied).ToList();

    /// <summary>
    /// An entity's credential names plus, for a TPH base, those of every subtype: its rows are
    /// shared-table rows of every subtype (#484).
    /// </summary>
    protected static List<string> TphUnionCredentialNames(MetaObject entity, MetaRoot root, GenConfig config) =>
        CredentialNames(entity, config)
            .Concat(TphPlanBuilder.For(entity, root) is { } tph
                ? tph.Subtypes.SelectMany(st => CredentialNames(st.Entity, config))
                : Enumerable.Empty<string>())
            .Distinct(StringComparer.Ordinal).ToList();

    /// <summary>
    /// The fields of a TPH subtype that <paramref name="isMarked"/> holds for on ANY declaration in
    /// its <paramref name="hierarchy"/> (the base and every subtype): a single-table column declared
    /// by several subtypes is one column (#484).
    /// </summary>
    protected static List<MetaField> HierarchyMarkedFields(
        MetaObject subtype, IEnumerable<MetaObject> hierarchy, Func<MetaField, bool> isMarked)
    {
        var marked = hierarchy.SelectMany(o => o.Fields()).Where(isMarked)
            .Select(f => f.Name).ToHashSet(StringComparer.Ordinal);
        return subtype.Fields().Where(f => marked.Contains(f.Name)).ToList();
    }

    // The keys a body can carry a field under: its metadata name and, when a resolver renames the
    // property beyond case, the resolved property name (an entity property serializes under the
    // host's naming policy applied to the resolved name). Credential stripping and the PATCH
    // deny and value-object arms match on both, so a renamed property cannot escape them. Without
    // a rename the two differ at most by case and the list is the field name alone.
    protected static List<string> WireKeys(MetaField f, GenConfig config) =>
        new[] { f.Name, CSharpNaming.PropertyName(f, config) }
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    // The CLR property names of an entity's credentials. The JSON key each is written under is not
    // derived here: the generated result asks the host's serializer (SerializerKeys.StripBody).
    protected static List<string> CredentialNames(MetaObject entity, GenConfig config) =>
        entity.Fields().Where(IsCredentialField).SelectMany(f => CredentialSpellings(f, config)).ToList();

    // The CLR property first (what the serializer's contract is matched on), then the field name: the
    // normalized-spelling backstop in SerializerKeys.Strip also removes a key that spells it. Equal
    // ignoring case when no resolver renames, so the list is then the one CLR name.
    protected static IEnumerable<string> CredentialSpellings(MetaField f, GenConfig config) =>
        new[] { CSharpNaming.PropertyName(f, config), f.Name }.Distinct(StringComparer.OrdinalIgnoreCase);

    // `string.Equals(prop.Name, "a", ...) || string.Equals(prop.Name, "b", ...)` over the keys.
    protected static string KeyMatch(IEnumerable<string> keys) =>
        string.Join(" || ", keys.Select(k => $"string.Equals(prop.Name, \"{k}\", System.StringComparison.OrdinalIgnoreCase)"));

    // The sort rules (case-insensitive) a list route hands ListQueryParser: each key gives the CLR property to
    // sort on and the field's DECLARED @sortableDefaultOrder. The keys are the property names (the field name
    // matches one ignoring case); when a resolver renamed a property beyond case the field name is a key too,
    // so `?sort=` takes the same key as `?filter[...]` (which keys on the field name) and the property name a
    // client may have read from a response.
    protected virtual void WriteSortRules(CsWriter w, string name, IReadOnlyList<MetaField> fields, GenConfig config)
    {
        var pairs = fields.Select(f => (Field: f.Name, Prop: CSharpNaming.PropertyName(f, config), Order: f.Attr(FIELD_ATTR_SORTABLE_DEFAULT_ORDER) as string)).ToList();
        w.Line($"private static readonly System.Collections.Generic.Dictionary<string, SortFieldRule> {name} = new(System.StringComparer.OrdinalIgnoreCase)");
        w.Open("{");
        // Property names first, so a field name that spells another field's property never shadows it.
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        static string Rule((string Field, string Prop, string? Order) p) =>
            p.Order is "asc" or "desc" ? $"new SortFieldRule(\"{p.Order}\", \"{p.Prop}\")" : $"new SortFieldRule(property: \"{p.Prop}\")";
        foreach (var p in pairs) if (keys.Add(p.Prop)) w.Line($"[\"{p.Prop}\"] = {Rule(p)},");
        foreach (var p in pairs) if (keys.Add(p.Field)) w.Line($"[\"{p.Field}\"] = {Rule(p)},");
        w.Close("};");
        w.Blank();
    }

    // The extra argument that hands the filter dispatch the allowlist's field-to-property map: only
    // when a resolver renamed a property beyond case (the allowlist emits the map on the same test).
    protected static string FilterMapArg(string allowlistRef, MetaObject entity, GenConfig config) =>
        CSharpNaming.RenamedProperties(entity, config).Count > 0 ? $", {allowlistRef}.PropertyByField" : "";

    // A C# string[] expression of the names, spliced into the credential-omitting result.
    protected static string NamesLiteral(IEnumerable<string> names) =>
        "new string[] { " + string.Join(", ", names.Select(n => "\"" + n + "\"")) + " }";

    // The ok / created result for a body that may carry credentials: byte-identical `Results.*`
    // when there are none, else the nested CredentialOmittingResult (emitted by WriteOmitResultClass).
    protected static string OkResult(string value, IReadOnlyList<string> credentials, bool envelope = false) =>
        credentials.Count == 0
            ? $"Results.Ok({value})"
            : $"(IResult)new CredentialOmittingResult({value}, {NamesLiteral(credentials)}{(envelope ? ", envelope: true" : "")})";

    // The credential arguments of a JSON report export (ReportExportHttp.Json), "" without a credential.
    protected static string ExportOmit(IReadOnlyList<string> credentials, bool envelope) =>
        credentials.Count == 0 ? "" : $", {NamesLiteral(credentials)}{(envelope ? ", envelope: true" : "")}";

    protected static string CreatedResult(string location, string value, IReadOnlyList<string> credentials) =>
        credentials.Count == 0
            ? $"Results.Created({location}, {value})"
            : $"(IResult)new CredentialOmittingResult({value}, {NamesLiteral(credentials)}, status: 201, location: {location})";

    // True when any M:N traversal mounted for these sources returns rows of a target that carries a credential.
    protected static bool M2mTargetHasCredentials(IEnumerable<MetaObject> sources, MetaRoot root, GenConfig config) =>
        sources.Any(src => M2MNavigationBuilder.For(src, root).Any(nav => TphUnionCredentialNames(nav.Target, root, config).Count > 0));

    // Emitted only into a routes class that uses it (never for a model without a credential).
    protected virtual void WriteOmitResultClass(CsWriter w, bool used)
    {
        if (!used) return;
        w.Blank();
        w.Line("// #484 — a credential (view.password) is never sent: the key is OMITTED from the body, not nulled.");
        w.Line("// Serializes with the app's configured JSON options, then removes the named keys from each row.");
        w.Line("private sealed class CredentialOmittingResult : IResult");
        w.Open("{");
        w.Line("private readonly object _value;");
        w.Line("private readonly string[] _names;");
        w.Line("private readonly bool _envelope;");
        w.Line("private readonly int _status;");
        w.Line("private readonly string? _location;");
        w.Line("public CredentialOmittingResult(object value, string[] names, bool envelope = false, int status = 200, string? location = null)");
        w.Line("{ _value = value; _names = names; _envelope = envelope; _status = status; _location = location; }");
        w.Line("public async System.Threading.Tasks.Task ExecuteAsync(HttpContext http)");
        w.Open("{");
        w.Line("var opts = ((Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>)");
        using (w.Hanging()) w.Line("http.RequestServices.GetService(typeof(Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>))!)");
        using (w.Hanging()) w.Line(".Value.SerializerOptions;");
        w.Line("var node = System.Text.Json.JsonSerializer.SerializeToNode(_value, _value.GetType(), opts);");
        w.Line("// The keys are the serializer's own for these properties and the envelope's rows (naming policy, rename, attribute), never guessed from names.");
        w.Line("SerializerKeys.StripBody(node, _value, _envelope, opts, _names);");
        w.Line("http.Response.StatusCode = _status;");
        w.Line("if (_location is not null) http.Response.Headers.Location = _location;");
        w.Line("await http.Response.WriteAsJsonAsync(node, opts);");
        w.Close("}");
        w.Close("}");
    }

    protected static List<AutoSetField> AutoSetFields(MetaObject entity, GenConfig config)
    {
        var list = new List<AutoSetField>();
        foreach (var f in entity.Fields())
        {
            if (f.AutoSet is not (AUTO_SET_ON_CREATE or AUTO_SET_ON_UPDATE)) continue;
            if (NowExprFor(f) is not { } now) continue;   // non-temporal @autoSet — skip
            list.Add(new AutoSetField(
                Nav: CSharpNaming.PropertyName(f, config),
                NowExpr: now,
                OnUpdate: f.AutoSet == AUTO_SET_ON_UPDATE));
        }
        return list;
    }

    // The now() expression for a field, keyed off its COLUMN's temporal CLR type
    // (ADR-0036 Wave 2: field.timestamp is DateTimeOffset, or DateTime under @localTime;
    // field.date → DateOnly; field.time → TimeOnly). Fully qualified so no extra using is
    // needed. Returns null for a non-temporal field.
    protected static string? NowExprFor(MetaField field) =>
        CSharpNaming.ScalarForField(field) switch
        {
            "DateTimeOffset" => "System.DateTimeOffset.UtcNow",
            "DateTime"       => "System.DateTime.Now",           // @localTime: naive wall-clock
            "DateOnly"       => "System.DateOnly.FromDateTime(System.DateTime.UtcNow)",
            "TimeOnly"       => "System.TimeOnly.FromDateTime(System.DateTime.UtcNow)",
            _                => null,
        };

    // Program D — a value-object column the entity carries: a field.object whose @objectRef
    // resolves to an object.value (single or @isArray). The generated create + PATCH handlers
    // deserialize, validate, and assign these as CLR owned-nav properties. WireKeys are the
    // metadata (camelCase) field name; Nav is the PascalCase property; DeserType is the VO
    // POCO type (or List<VO> for an array); JsonColumnRef is the physical jsonb column (the
    // .ToJson name) as a C# EXPRESSION — `<Entity>Names.<Field>Column` when the names artifact
    // is in the run, the quoted literal otherwise (CSharpNaming.ColumnRef's contract) — for
    // splicing into the post-save null-clear SQL; IsArray / Required drive the merge semantics
    // (present-null: a nullable single/array clears, a @required column 400s).
    protected record VoField(
        IReadOnlyList<string> WireKeys, string WireName, string Nav, string DeserType, string JsonColumnRef, bool IsArray, bool Required);

    // #362 — the `field.map @objectRef` columns, deliberately NOT folded into VoField.
    // A VoField drives the owned-nav machinery (EF OwnsMany/.ToJson, deserialization as an
    // owned navigation, the post-save array null-clears); a map is a plain mapped property
    // with a jsonb converter and none of that applies. What it DOES share is the nested
    // value-object graph, which the create and PATCH paths must validate — before this the
    // map reached neither, so its values were written unchecked on every write path.
    protected record MapVoField(IReadOnlyList<string> WireKeys, string WireName, string Nav, string DeserType);

    // A value object named from the routes file: bare in the earlier layout, global::-qualified
    // when package namespaces are on.
    protected static string VoTypeRef(MetaData target, MetaRoot root, GenConfig config) =>
        config.PackageNamespacesFromMetadata ? ValueObjectNames.GlobalRef(target, config) : ValueObjectNames.TypeName(target, root);

    protected static List<MapVoField> MapValueObjectFields(MetaObject entity, MetaRoot root, GenConfig config)
    {
        var list = new List<MapVoField>();
        foreach (var f in entity.Fields())
        {
            if (f.SubType != FIELD_SUBTYPE_MAP || f.ObjectRef is not { } oref) continue;
            if (f.IsDerived()) continue;   // #214 — derived columns are view-only, not writable
            var target = ValueObjectNames.ResolveFieldRef(f, root);
            if (target is null || !target.IsValue()) continue;   // scalar-valued maps have no bean
            list.Add(new MapVoField(
                WireKeys: WireKeys(f, config), WireName: f.Name,
                Nav: CSharpNaming.PropertyName(f, config),
                DeserType: $"System.Collections.Generic.Dictionary<string, {VoTypeRef(target, root, config)}>"));
        }
        return list;
    }

    protected static List<VoField> ValueObjectFields(MetaObject entity, MetaRoot root, ColumnNamingStrategy strategy, bool includeNames, GenConfig config)
    {
        var list = new List<VoField>();
        foreach (var f in entity.Fields())
        {
            if (f.SubType != FIELD_SUBTYPE_OBJECT || f.ObjectRef is not { } oref) continue;
            if (f.IsDerived()) continue;   // #214 — derived VO fields are view-only, not writable
            var target = ValueObjectNames.ResolveFieldRef(f, root);
            if (target is null || !target.IsValue()) continue;   // value objects only (jsonb-stored)
            var voType = VoTypeRef(target, root, config);
            var isArray = f.ResolvedIsArray();                    // ADR-0039: resolving array-ness
            list.Add(new VoField(
                WireKeys: WireKeys(f, config), WireName: f.Name,
                Nav: CSharpNaming.PropertyName(f, config),
                DeserType: isArray ? $"System.Collections.Generic.List<{voType}>" : voType,
                JsonColumnRef: CSharpNaming.ColumnRef(entity, f, strategy, includeNames, config),
                IsArray: isArray,
                Required: f.IsRequired));
        }
        return list;
    }

    // FR-036 A2 / #4 — emit a create (POST) handler. When the entity carries at least one
    // @required (non-PK/non-discriminator) field, FIRST enforce those keys are PRESENT and
    // non-null on the raw JSON body (a @required value-type field binds to a CLR default when
    // omitted, which [Required] cannot detect as "missing"), THEN deserialize + run the model's
    // DataAnnotations. When there is no such field, fall back to the plain model-bound handler
    // (minimal-API binding + DataAnnotations) — byte-identical to the pre-FR-036 output.
    // A missing key, an explicit null on a @required key, or a DataAnnotations violation all
    // return the cross-port {error:"validation"} envelope BEFORE the row is persisted.
    // `api.unknownFields` — the declared wire names a body key is checked against, as a static set in the
    // routes class. Null under `drop` (nothing is emitted and no handler checks): the constant's name otherwise.
    private const string KnownFieldsConst = "KnownFields";

    protected virtual void WriteKnownFields(CsWriter w, IEnumerable<MetaObject> objects, MetaRoot root)
    {
        if (root.Api.UnknownFields != UnknownFieldsMode.Reject) return;
        var names = objects.SelectMany(o => o.Fields()).Select(f => f.Name)
            .Distinct(StringComparer.Ordinal).OrderBy(n => n, StringComparer.Ordinal).ToList();
        w.Line("// api.unknownFields: reject — the declared field names (wire spelling); any other body key is a 400.");
        w.Line("private static readonly System.Collections.Generic.HashSet<string> " + KnownFieldsConst + " = new(System.StringComparer.Ordinal)");
        w.Open("{");
        foreach (var n in names) w.Line($"\"{n}\",");
        w.Close("};");
        w.Blank();
    }

    // The unknown-field refusal, before any validation of the body. `bodyVar` is the parsed JsonDocument.
    protected virtual void WriteUnknownFieldsCheck(CsWriter w, MetaRoot root, string bodyVar)
    {
        if (root.Api.UnknownFields != UnknownFieldsMode.Reject) return;
        // `http` carries the app's JSON options: a key the binder matches case-insensitively is declared.
        w.Line($"if (UnknownFieldCheck.Reject({bodyVar}.RootElement, {KnownFieldsConst}, http) is {{ }} __unknown) return __unknown;");
    }

    // The first line of an item handler: the `{id}` route value read as the key's type, or 400 invalid_id
    // (RouteErrors). The handler binds no typed id itself, because ASP.NET Core's binding answers an
    // unparsable one with an empty 400.
    protected virtual void WriteReadId(CsWriter w, string pkType) =>
        w.Line($"if (!RouteErrors.TryReadId<{pkType}>(http, out var id)) return RouteErrors.InvalidId();");

    // The offset + limit lines of a list route, over the bounds ListQueryParser already read (a bound that is
    // present but not a non-negative integer was refused there, pagination.invalid_value). No limit takes
    // `api.pagination`'s defaultLimit, or ApiSettings.DefaultPageLimit (50, as in every port) when the project
    // sets no block; with the block, a limit above maxLimit is 400 limit_too_large, and without it there is no
    // maximum. `limit=0` is a page of zero rows, as every other port serves it, not "no limit".
    // The parsed ?offset, skipped (an offset is at most 2^53 - 1; EF's Skip takes an int).
    private static void WriteSkip(CsWriter w)
    {
        w.Line("if (listQuery.Offset is { } __offset && __offset > 0)");
        using (w.Hanging()) w.Line("q = q.Skip((int)System.Math.Min(__offset, int.MaxValue));");
    }

    protected virtual void WriteListPage(CsWriter w, ApiPagination? page)
    {
        w.Line("// Pagination: ?offset=N first (skip), then ?limit=N (take).");
        WriteSkip(w);
        if (page is not null)
            w.Line("// api.pagination: no limit takes defaultLimit; a limit above maxLimit is refused.");
        else
            w.Line("// No api.pagination: no limit takes the default page of 50; an explicit limit is served as asked.");
        w.Line($"var __take = {page?.DefaultLimit ?? ApiSettings.DefaultPageLimit};");
        w.Line("if (listQuery.Limit is { } __limit)");
        w.Open("{");
        if (page is not null)
            w.Line($"if (__limit > {page.MaxLimit}) return Results.BadRequest(new {{ error = \"limit_too_large\", maxLimit = {page.MaxLimit} }});");
        w.Line("__take = (int)System.Math.Min(__limit, int.MaxValue);");
        w.Close("}");
        w.Line("q = q.Take(__take);");
    }

    // The REST standard's list handling (ListQueryParser): the filter tree with or/and groups, ?search, the
    // sort, and the named refusals (filter.bare_field, filter.leading_wildcard_disallowed,
    // filter.nesting_too_deep, invalid_filter_value, invalid_sort, pagination.invalid_value), then the parsed
    // filter and search applied to `q` and the sort through `sortExpr` (which reads `__sortProp`, the CLR
    // property, and `desc`). Leaves `listQuery` in scope for the page bounds and the withCount total.
    protected virtual void WriteListQuery(CsWriter w, string entityType, string allowlist, string fm, string sortRules, string sortExpr)
    {
        w.Line("// ?filter[...] (or/and groups), ?search, ?sort and the page bounds, against the allowlist.");
        w.Line($"var __parsed = ListQueryParser.Parse(http.Request.QueryString.Value, {allowlist}.Rules, {sortRules}, {allowlist}.FieldNames);");
        w.Line("if (__parsed.Error is { } __refused) return Results.BadRequest(__refused.Body());");
        w.Line("var listQuery = __parsed.Query!;");
        w.Line($"if (EfCoreFilterDispatch.Validate<{entityType}>(listQuery{fm}) is {{ }} __invalid) return Results.BadRequest(__invalid.Body());");
        w.Line($"q = EfCoreFilterDispatch.Apply(q, listQuery, {allowlist}.Rules{fm});");
        w.Line($"if (listQuery.Sort is {{ }} __sort && {sortRules}[__sort.Field].Property is {{ }} __sortProp)");
        w.Open("{");
        w.Line("var desc = __sort.Descending;");
        w.Line($"q = {sortExpr};");
        w.Close("}");
    }

    protected virtual void WriteCreateHandler(
        CsWriter w, string mapPath, string cls, string ctxType, string dbSet,
        IReadOnlyList<string> requiredKeys, string createdExpr, IReadOnlyList<VoField> voFields,
        IReadOnlyList<MapVoField> mapVoFields,
        IReadOnlyList<AutoSetField> autoSetFields,
        (string ReadDbSet, string PkProp, string Route)? reRead = null,
        IReadOnlyList<string>? deniedNavs = null,
        IReadOnlyList<string>? credentials = null,
        IReadOnlyList<string>? serverOwned = null,
        MetaRoot? root = null,
        IReadOnlyList<string>? readOnlyRequired = null)
    {
        // The body is always read here, not model-bound: the framework answers a body it cannot bind with a
        // bare 400 and no body, while every validation failure must list its issues (the cross-port
        // {error:"validation", issues:[...]} envelope), so the handler reads the body itself and collects them.
        w.Line($"app.MapPost(prefix + \"{mapPath}\", async (HttpContext http, {ctxType} db) =>");
        w.Open("{");
        WriteJsonOptsLocal(w);
        w.Line("System.Text.Json.JsonDocument __body;");
        w.Line("try { __body = await System.Text.Json.JsonDocument.ParseAsync(http.Request.Body); }");
        w.Line("catch (System.Text.Json.JsonException) { return RouteErrors.InvalidJson(); }");
        w.Line("using var __bodyScope = __body;");
        w.Line("if (__body.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object)");
        using (w.Hanging()) w.Line("return ValidationIssues.Unreadable();");
        if (root is not null) WriteUnknownFieldsCheck(w, root, "__body");
        w.Line("var __issues = new ValidationIssues();");
        // FR-036 #4 — @required-key presence: an omitted key OR an explicit null on a @required
        // field → 400, matching the JVM/Python "missing @required → 400" contract. Case-insensitive
        // so a camelCase wire key ("createdAt") matches its PascalCase property ("CreatedAt").
        if (requiredKeys.Count > 0)
        {
            w.Line("var __present = new System.Collections.Generic.HashSet<string>(System.StringComparer.OrdinalIgnoreCase);");
            w.Line("foreach (var __p in __body.RootElement.EnumerateObject())");
            using (w.Hanging()) w.Line("if (__p.Value.ValueKind != System.Text.Json.JsonValueKind.Null) __present.Add(__p.Name);");
            w.Line("foreach (var __req in new[] { " + string.Join(", ", requiredKeys.Select(k => "\"" + k + "\"")) + " })");
            using (w.Hanging()) w.Line("if (!__present.Contains(__req)) __issues.AddRequired(__req);");
        }
        // A value that cannot be read (a wrong-shaped VO, a decimal out of range, a malformed date) throws
        // JsonException: it is listed at its path, and the body cannot be checked further.
        w.Line($"{cls}? input = null;");
        w.Line("try { input = System.Text.Json.JsonSerializer.Deserialize<" + cls + ">(__body.RootElement.GetRawText(), jsonOpts); }");
        w.Line("catch (System.Exception __e) { __issues.AddReadFailure(__e, typeof(" + cls + ")); }");
        w.Line("if (input is null) return __issues.Any ? __issues.ToResult() : ValidationIssues.Unreadable();");
        WriteCreateServerOwned(w, serverOwned);
        WriteCreateIgnoreDenied(w, deniedNavs);
        WriteCreateValidation(w, readOnlyRequired);
        WriteCreateVoValidation(w, voFields, mapVoFields);
        w.Line("if (__issues.Any) return __issues.ToResult();");
        WriteCreateAutoSet(w, autoSetFields);
        WriteCreatePersist(w, dbSet, createdExpr, reRead, credentials ?? []);
        w.Close("});");
    }

    // The persist tail of a generated POST handler: add the bound `input` to the WRITE
    // DbSet, save, and return. For a plain entity that returns the bound row via
    // <paramref name="createdExpr"/>. For a write-through entity (#214) <paramref name="reRead"/>
    // is set: the row is read back THROUGH the replica view by PK so the returned body
    // carries the derived (view-computed) fields. Assumes `input` + `db` are in scope.
    protected virtual void WriteCreatePersist(
        CsWriter w, string dbSet, string createdExpr,
        (string ReadDbSet, string PkProp, string Route)? reRead,
        IReadOnlyList<string> credentials)
    {
        w.Line($"db.{dbSet}.Add(input);");
        WriteSaveChanges(w);
        if (reRead is { } rr)
        {
            w.Line($"var __created = await db.{rr.ReadDbSet}.FindAsync(input.{rr.PkProp});");
            // #214 [2] — a @kind:materializedView (unrefreshed) or filtered replica view may not
            // surface the just-inserted row; fall back to the bound write `input` so the 201 body
            // is never null (degraded — missing only the derived fields; matches the Python port).
            w.Line($"return {CreatedResult($"prefix + \"/{rr.Route}/\" + input.{rr.PkProp}", "(object?)__created ?? input", credentials)};");
        }
        else
        {
            w.Line($"return {createdExpr};");
        }
    }

    // SECURITY (1.2.x) — a generated create hands storage ONLY what the client may set. The body is
    // bound straight onto the EF entity, so every member the server owns is reset before validation
    // and `Add`, and the request answers as if the key were absent (never a 400):
    //   - a server-generated primary key (@generation increment|uuid): default, so EF generates it;
    //   - the TPH discriminator on a per-subtype route: default, so EF's discriminator value
    //     generator stamps the route subtype's own @discriminatorValue (the route is its only source);
    //   - M:N navigation collections: emptied, else `Add` would insert a client-sent related graph.
    // A readOnly field needs no line here: the entity declares it with a private setter, which
    // System.Text.Json never binds (EntityGenerator.SetterFor).
    protected virtual void WriteCreateServerOwned(CsWriter w, IReadOnlyList<string>? statements)
    {
        if (statements is null || statements.Count == 0) return;
        w.Line("// Server-owned: a generated key, the TPH discriminator and M:N navigations are not settable by the client; the value is ignored.");
        foreach (var st in statements) w.Line("" + st);
    }

    // The reset statements WriteCreateServerOwned emits for one entity (empty when it has none, so an
    // entity with an assigned key, no navigation and no discriminator keeps its output byte-identical).
    // A TPH subtype class declares no M:N property of its own — the navigations it carries are its
    // discriminator base class's — so a subtype route passes that base as navOwner. The key and
    // discriminator resets are SKIPPED when that field is itself @mutability: readOnly: the entity
    // declares it with a private setter (EntityGenerator.SetterFor), so the assignment would be
    // CS0122 — and it is redundant, because System.Text.Json never binds a private setter.
    // The M:N element type is spelled through ValueObjectNames.TypeRef from the routes file's own
    // namespace (a generated type's namespace is its metadata package), and the List is
    // global::-qualified, as every other emitted System reference here is.
    protected static List<string> ServerOwnedCreateResets(
        MetaObject entity, MetaRoot root, GenConfig config, MetaField? discField = null, MetaObject? navOwner = null)
    {
        var list = new List<string>();
        if (entity.PrimaryIdentity() is MetaPrimaryIdentity pk
            && pk.Generation is MetaObjects.Core.Identity.IdentityConstants.GENERATION_INCREMENT
                or MetaObjects.Core.Identity.IdentityConstants.GENERATION_UUID
            && pk.Fields is [var keyName]
            && entity.Fields().FirstOrDefault(f => f.Name == keyName) is { } keyField
            && !keyField.IsReadOnlyMutability)
            list.Add($"input.{CSharpNaming.PropertyName(keyField, config)} = default!;");
        if (discField is not null && !discField.IsReadOnlyMutability)
            list.Add($"input.{CSharpNaming.PropertyName(discField, config)} = default!;");
        foreach (var nav in M2MNavigationBuilder.For(navOwner ?? entity, root, _ => { }))
        {
            var target = ValueObjectNames.Ref(nav.Target, config);
            list.Add($"input.{CSharpNaming.Pascal(nav.Name)} = new System.Collections.Generic.List<{target}>();");
        }
        return list;
    }

    // #484 — a write-denied key (@formExclude or credential) on a create body is IGNORED, never
    // rejected: the bound value is reset to the CLR default (unset / null) before validation.
    protected virtual void WriteCreateIgnoreDenied(CsWriter w, IReadOnlyList<string>? deniedNavs)
    {
        if (deniedNavs is null || deniedNavs.Count == 0) return;
        w.Line("// @formExclude / credential: not settable through the generated create; the value is ignored.");
        foreach (var nav in deniedNavs)
            w.Line($"input.{nav} = default!;");
    }

    // Issue #203 — stamp EVERY @autoSet column (onCreate AND onUpdate) with now() on
    // insert, overriding whatever the client sent (the model's value is ignored, so a
    // fresh row's updated-at equals its created-at). Emits nothing when the entity has no
    // @autoSet field. Assumes the bound local `input` is in scope.
    protected virtual void WriteCreateAutoSet(CsWriter w, IReadOnlyList<AutoSetField> autoSetFields)
    {
        foreach (var a in autoSetFields)
            w.Line($"input.{a.Nav} = {a.NowExpr};");
    }

    // Issue #203 — stamp each onUpdate @autoSet column with now() on update, BEFORE the
    // caller's partial merge (so a partial PATCH still bumps updated-at). onCreate columns
    // are NOT stamped — they are never rewritten (the write-once created-at contract). The
    // merge loop skips every @autoSet column, so this assignment is authoritative. Assumes
    // the tracked entity local `existing` is in scope.
    protected virtual void WriteUpdateAutoSet(CsWriter w, IReadOnlyList<AutoSetField> autoSetFields)
    {
        foreach (var a in autoSetFields)
            if (a.OnUpdate)
                w.Line($"existing.{a.Nav} = {a.NowExpr};");
    }

    // Issue #203 — the InsertPreserving escape hatch for one entity: a public static helper
    // that persists `input` WITHOUT @autoSet stamping (the onCreate/onUpdate columns are
    // written verbatim), for import / restore / replication paths that must keep the
    // original timestamps. Emitted only for an entity that declares @autoSet fields (else
    // there is nothing to preserve — the normal POST already writes every column verbatim).
    protected virtual void WriteInsertPreserving(CsWriter w, string cls, string dbSet, string ctxType)
    {
        w.Blank();
        w.Line("/// <summary>Escape hatch: insert without @autoSet stamping (created-at/updated-at");
        w.Line("/// written verbatim from <paramref name=\"input\"/>) for import / restore / replication.</summary>");
        w.Line($"public static async System.Threading.Tasks.Task<{cls}> InsertPreserving({ctxType} db, {cls} input)");
        w.Open("{");
        w.Line($"db.{dbSet}.Add(input);");
        w.Line("await db.SaveChangesAsync();");
        w.Line("return input;");
        w.Close("}");
    }

    // Program D — post-save raw NULL for each nullable array-of-VO column a request cleared
    // to present-null. EF Core 8 OwnsMany(...).ToJson persists a null collection nav as `[]`
    // (never SQL NULL), so the merge loop sets the CLR nav to null (for the returned row) AND
    // flags the column; here we run a targeted UPDATE to actually NULL the jsonb column AFTER
    // SaveChanges. Only the PK VALUE is a parameter ({0}). The table, json-column and PK-column
    // IDENTIFIERS cannot be parameters, so they are spliced into the SQL text as C# expressions
    // — `tableRef` / `pkColumnRef` / VoField.JsonColumnRef: the <Entity>Names constants when the
    // names artifact is in this run (the string stays a compile-time constant, concatenated),
    // the bare literals otherwise (ADR-0034's documented fallback, byte-identical to before).
    // Emits nothing when the entity has no nullable array-of-VO column.
    protected virtual void WriteArrayNullClears(
        CsWriter w, IReadOnlyList<VoField> voFields, string tableRef, string pkColumnRef)
    {
        for (int i = 0; i < voFields.Count; i++)
        {
            var vf = voFields[i];
            if (!vf.IsArray || vf.Required) continue;
            w.Line($"if (__clearVo{i}) await db.Database.ExecuteSqlRawAsync(" +
                $"\"UPDATE \\\"{SqlSplice(tableRef)}\\\" SET \\\"{SqlSplice(vf.JsonColumnRef)}\\\" = NULL WHERE \\\"{SqlSplice(pkColumnRef)}\\\" = {{0}}\", id);");
        }
    }

    // A physical-name expression (NameRef / ColumnRef's contract: `<Cls>.<Member>` or a quoted
    // literal) placed INSIDE an emitted C# string literal. A quoted literal is folded into the
    // surrounding text, so the literal arm emits the single string it always did; a constant
    // reference closes the literal, concatenates, and reopens it — every piece is a compile-time
    // constant, so the whole expression still is one.
    protected static string SqlSplice(string nameExpr) =>
        nameExpr.StartsWith('"') ? nameExpr[1..^1] : $"\" + {nameExpr} + \"";

    // Program D — validate each present value-object column on CREATE. The top-level
    // TryValidateObject (WriteCreateValidation) does NOT recurse into an owned-nav VO, so a
    // nested-constraint violation (e.g. a VO string member over @maxLength) would slip through.
    // ValueObjectValidator.Validate runs the VO's own DataAnnotations per element + recurses
    // into nested VO members; a null nav is vacuously valid (a missing required VO column is
    // already caught by the @required-key presence check). Assumes `input` is in scope.
    protected virtual void WriteCreateVoValidation(
        CsWriter w, IReadOnlyList<VoField> voFields, IReadOnlyList<MapVoField> mapVoFields)
    {
        foreach (var vf in voFields)
            w.Line($"ValueObjectValidator.Collect(input.{vf.Nav}, __issues, jsonOpts, \"{vf.WireName}\");");
        // #362 — a field.map @objectRef's values are value objects and get the same graph
        // validation. ValueObjectValidator unwraps an IDictionary to its Values; before that
        // arm existed a Dictionary hit the IEnumerable arm, yielded KeyValuePair structs, and
        // validated vacuously — so this line and that arm are one fix, not two.
        foreach (var mf in mapVoFields)
            w.Line($"ValueObjectValidator.Collect(input.{mf.Nav}, __issues, jsonOpts, \"{mf.WireName}\");");
    }

    // The configured System.Text.Json options local (`jsonOpts`) — the app's
    // ConfigureHttpJsonOptions serializer options, NOT defaults, so a custom converter (e.g.
    // the field.timestamp DateTimeOffset converter) is honored; default options 500 on it.
    // Assumes `HttpContext http` is in scope.
    // ADR-0019 Amendment 1 (W3): every route of the entity is mounted on a group carrying the
    // decimal-range filter, so a stored value past C# decimal's range is a named error on read
    // rather than an unhandled 500. `mount` is what the caller passed; `app` is the filtered group,
    // so every `app.MapGet(...)` below is unchanged and the method still returns what it was given
    // (`mount`). The parameter keeps its name `app`, so a caller passing `app:` by name still compiles.
    // true iff the entity has a field that surfaces as a CLR decimal (and so a DecimalWire copy
    // is emitted into its namespace).
    // A decimal reached through a value-object column counts too: its member is bound from the body
    // with the same exact-read rule, so the same {error:"validation"} envelope must answer a refusal.
    protected static bool HasDecimalField(MetaObject entity, HashSet<MetaObject>? seen = null)
    {
        seen ??= [];
        if (!seen.Add(entity)) return false;
        foreach (var f in entity.Fields())
        {
            if (f.SubType == FIELD_SUBTYPE_DECIMAL && CSharpNaming.DbColumnTypeClrOverride(f) is null) return true;
            if (f.SubType == FIELD_SUBTYPE_OBJECT && ValueObjectNames.ResolveFieldRef(f, entity) is { } vo
                && HasDecimalField(vo, seen)) return true;
        }
        return false;
    }

    // true iff the entity has a field.duration column of its own (a TimeSpan property, so a
    // DurationWire copy is emitted into its namespace). Its converter refuses a bad value while the
    // body is bound, so, like a decimal, the create route parses the body itself to answer with the
    // {error:"validation"} envelope, and the PATCH merge reads the wire form explicitly.
    // Only under `wire.durations: iso`: the native form is System.Text.Json's own, so the default
    // binder and PATCH deserialization already read it and no duration arm is emitted.
    protected static bool HasIsoDurationField(MetaObject entity, MetaRoot root) =>
        WireFormat.Of(root).Durations == DurationWireForm.Iso && entity.Fields().Any(f => f.SubType == FIELD_SUBTYPE_DURATION && CSharpNaming.DbColumnTypeClrOverride(f) is null);

    protected virtual void WriteDecimalRangeGroup(CsWriter w)
        {
            w.Line("IEndpointRouteBuilder mount = app;");
            w.Line("app = app.MapGroup(string.Empty).AddEndpointFilter(new DecimalRangeEndpointFilter());");
        }

    protected virtual void WriteJsonOptsLocal(CsWriter w)
    {
        w.Line("var jsonOpts = ((Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>)");
        using (w.Hanging()) w.Line("http.RequestServices.GetService(typeof(Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>))!)");
        using (w.Hanging()) w.Line(".Value.SerializerOptions;");
    }

    // FR-036 A2 — the shared create-validation preamble for a generated POST handler
    // (vanilla entity + each TPH per-subtype create). Runs the model's DataAnnotations
    // (the emitted [Required]/[MaxLength]/[MinLength]/[Range]/[RegularExpression]) over the
    // bound `input` and rejects a violating body with the cross-port {error:"validation"}
    // envelope BEFORE the row is persisted (ASP.NET minimal-API model binding never runs
    // DataAnnotations on its own). Assumes the bound local `input` is in scope.
    // A violation naming only a @required readOnly member (<paramref name="readOnlyRequired"/>)
    // is ignored: the client cannot set that member, so it cannot satisfy the rule.
    protected virtual void WriteCreateValidation(CsWriter w, IReadOnlyList<string>? readOnlyRequired = null)
    {
        if (readOnlyRequired is null || readOnlyRequired.Count == 0)
        {
            w.Line("__issues.ValidateObject(input, jsonOpts);");
            return;
        }
        var names = string.Join(", ", readOnlyRequired.Select(n => "\"" + n + "\""));
        w.Line($"__issues.ValidateObjectExcept(input, jsonOpts, new[] {{ {names} }});");
    }

    // FR-035 PATCH-2 — the shared present-key merge loop for the generated update
    // handler (vanilla entity + each TPH subtype). Enumerates the JSON body and writes
    // ONLY the present keys: an explicit null CLEARS a nullable column, an explicit null
    // on a NOT-NULL (@required) column is a 400 {error:"validation"}, and the PK — plus
    // the TPH discriminator when `discProp` is non-null — is never written. Assumes the
    // locals `body` (JsonDocument), `existing` (the entity instance), `entry` (EntityEntry)
    // and `jsonOpts` are in scope.
    protected virtual void WritePartialMergeLoop(
        CsWriter w, string? discProp, IReadOnlyList<VoField> voFields,
        IReadOnlyList<MapVoField> mapVoFields,
        IReadOnlyList<string> autoSetNavs, IReadOnlyList<string> frozenNavs, bool hasDecimal,
        IReadOnlyList<string> deniedKeys, IReadOnlyList<string> deniedClr, bool hasDuration = false)
    {
        // A nullable array-of-VO column that a request clears to null (present-null) can NOT be
        // NULLed by an owned-nav assignment — EF OwnsMany(...).ToJson writes `[]` for a null
        // collection nav, not SQL NULL. Track it via a flag + a post-save raw UPDATE
        // (WriteArrayNullClears). Declared before the loop so the post-save clears see it.
        for (int i = 0; i < voFields.Count; i++)
            if (voFields[i].IsArray && !voFields[i].Required)
                w.Line($"var __clearVo{i} = false;");

        // The body key -> CLR property map comes from the host serializer's own contract (a naming policy
        // such as SnakeCaseLower, a rename, an attribute), never from a guess at the name: the keys a
        // client echoes from a response are the keys this resolves.
        w.Line($"var __keys = SerializerKeys.PropertyByKey(existing.GetType(), jsonOpts);");
        // Every violation is collected (never the first alone) and answered together after the loop.
        w.Line("var __issues = new ValidationIssues();");
        w.Line("foreach (var prop in body.RootElement.EnumerateObject())");
        w.Open("{");
        w.Line("var __clr = __keys.TryGetValue(prop.Name, out var __mapped) ? __mapped : null;");
        // #484 — @formExclude / credential keys are IGNORED (never a 400), ahead of every arm below
        // (a present null is a write too). Denied by the serializer-resolved property AND by the field-name spellings.
        if (deniedClr.Count > 0)
            w.Line($"if (__clr is {string.Join(" or ", deniedClr.Select(n => "\"" + n + "\""))}) continue; // @formExclude / credential: not writable");
        foreach (var key in deniedKeys)
            w.Line($"if (string.Equals(prop.Name, \"{key}\", System.StringComparison.OrdinalIgnoreCase)) continue; // @formExclude / credential: not writable");
        // Program D — typed value-object arms FIRST (owned-nav columns are invisible to
        // EF's FindProperty below, so the generic scalar path would silently drop them).
        // Present value → deserialize + recursive VO validation + assign the CLR nav
        // property (EF .ToJson persists via full-document replacement on DetectChanges);
        // present-null clears a NULLABLE VO column, or 400s a @required one; absent →
        // untouched (not enumerated). Keyed on the wire (metadata) field name.
        for (int i = 0; i < voFields.Count; i++)
        {
            var vf = voFields[i];
            var v = "__vo" + i;
            w.Line($"if ({KeyMatch(vf.WireKeys)} || __clr == \"{vf.Nav}\")");
            w.Open("{");
            w.Line("if (prop.Value.ValueKind == System.Text.Json.JsonValueKind.Null)");
            w.Open("{");
            if (vf.Required)
            {
                w.Line($"__issues.AddRequired(\"{vf.WireName}\"); // @required VO column: present-null is a 400");
                w.Line("continue;");
            }
            else
            {
                w.Line($"existing.{vf.Nav} = null;");
                if (vf.IsArray)
                    w.Line($"__clearVo{i} = true; // NULL the jsonb column post-save (EF writes [] for a null OwnsMany nav)");
                w.Line("continue;");
            }
            w.Close("}");
            // A wrong-shaped VO value (e.g. a JSON array for a single-VO column, an object for an
            // array column) throws JsonException — return the cross-port 400 rather than an
            // unhandled 500 (matches every other port + this port's own reference lane).
            w.Line($"{vf.DeserType} {v};");
            w.Line($"try {{ {v} = System.Text.Json.JsonSerializer.Deserialize<{vf.DeserType}>(prop.Value.GetRawText(), jsonOpts); }}");
            w.Line($"catch (System.Text.Json.JsonException __e) {{ __issues.AddJson(__e, null, \"{vf.WireName}\"); continue; }}");
            w.Line($"if (!ValueObjectValidator.Collect({v}, __issues, jsonOpts, \"{vf.WireName}\")) continue;");
            w.Line($"existing.{vf.Nav} = {v}{(vf.Required ? "!" : "")};");
            w.Line("continue;");
            w.Close("}");
        }
        // #362 — a present field.map @objectRef key, handled BEFORE the generic property path.
        // The generic path deserializes and assigns without ever running the value-object graph
        // validation, so a map of invalid VOs was written on PATCH exactly as it was on create.
        // Mirrors the VO arm above (deserialize -> validate -> assign -> continue); a map needs
        // none of the owned-nav apparatus, so this arm is deliberately the short version.
        for (int i = 0; i < mapVoFields.Count; i++)
        {
            var mf = mapVoFields[i];
            var mv = "__map" + i;
            w.Line($"if ({KeyMatch(mf.WireKeys)} || __clr == \"{mf.Nav}\")");
            w.Open("{");
            w.Line("if (prop.Value.ValueKind == System.Text.Json.JsonValueKind.Null)");
            w.Line($"{{ existing.{mf.Nav} = null; continue; }}");
            w.Line($"{mf.DeserType}? {mv};");
            w.Line($"try {{ {mv} = System.Text.Json.JsonSerializer.Deserialize<{mf.DeserType}>(prop.Value.GetRawText(), jsonOpts); }}");
            w.Line($"catch (System.Text.Json.JsonException __e) {{ __issues.AddJson(__e, null, \"{mf.WireName}\"); continue; }}");
            w.Line($"if (!ValueObjectValidator.Collect({mv}, __issues, jsonOpts, \"{mf.WireName}\")) continue;");
            w.Line($"existing.{mf.Nav} = {mv};");
            w.Line("continue;");
            w.Close("}");
        }
        w.Line("var target = (__clr is null ? null : entry.Metadata.FindProperty(__clr))");
        using (w.Hanging()) w.Line("?? entry.Metadata.FindProperty(prop.Name)");
        using (w.Hanging()) w.Line("?? entry.Metadata.GetProperties().FirstOrDefault(p => string.Equals(p.Name, prop.Name, System.StringComparison.OrdinalIgnoreCase));");
        w.Line("if (target is null) continue;");
        w.Line("var __wire = ValidationIssues.WireName(existing.GetType(), target.Name, jsonOpts);");
        w.Line("if (target.IsPrimaryKey()) continue;                        // PK is route-authoritative");
        if (discProp is not null)
        {
            w.Line($"if (string.Equals(target.Name, \"{discProp}\", System.StringComparison.Ordinal)) continue; // discriminator is immutable");
        }
        // Issue #203 — @autoSet columns are server-owned: an onUpdate column is stamped to
        // now() (below), an onCreate column is never rewritten. Either way the caller can
        // never set them via the PATCH/PUT body, so skip any present key.
        foreach (var nav in autoSetNavs)
            w.Line($"if (string.Equals(target.Name, \"{nav}\", System.StringComparison.Ordinal)) continue; // @autoSet: server-owned");
        // FR-037 R1 — @mutability readOnly / writeOnce are not PATCH-settable. STRIPPED,
        // never 400'd: the uniform behaviour of every excluded key on this path. Skipping
        // BEFORE the null branch also covers the FR-035 present-null arm, since clearing a
        // column is itself a write.
        foreach (var nav in frozenNavs)
            w.Line($"if (string.Equals(target.Name, \"{nav}\", System.StringComparison.Ordinal)) continue; // @mutability: not patch-settable");
        w.Line("if (prop.Value.ValueKind == System.Text.Json.JsonValueKind.Null)");
        w.Open("{");
        w.Line("// FR-035 PATCH-2: explicit null clears a nullable column; on a");
        w.Line("// NOT-NULL (@required) column it is a 400 (matching the cross-port contract).");
        w.Line("if (!target.IsNullable) { __issues.AddRequired(__wire); continue; }");
        w.Line("entry.CurrentValues[target] = null;");
        w.Line("continue;");
        w.Close("}");
        w.Line("var clr = System.Nullable.GetUnderlyingType(target.ClrType) ?? target.ClrType;");
        // ADR-0019 Amendment 1 (W2): a decimal is read from a JSON-number string or a JSON number,
        // exactly; anything else, or a value decimal cannot hold, is the 400 validation envelope.
        // `DecimalWire` resolves to the copy the entity generator emits into this namespace (the
        // routes and the entities share it), so the output differs between a packaged and an
        // ejected generator only in the helper-runtime `using`, as before.
        if (hasDecimal || hasDuration)
        {
            w.Line("object? __val;");
            var arm = "if";
            if (hasDecimal)
            {
                w.Line("if (clr == typeof(decimal))");
                w.Open("{");
                w.Line("if (!DecimalWire.TryParseElement(prop.Value, out var __dec)) { __issues.Add(\"invalid_type\", __wire + \" is not a decimal\", __wire); continue; }");
                w.Line("if (!DecimalWire.FitsDeclared(existing.GetType(), target.Name, __dec)) { __issues.Add(\"too_big\", __wire + \" exceeds its declared precision and scale\", __wire); continue; }");
                w.Line("__val = __dec;");
                w.Close("}");
                w.Line("else if (clr == typeof(System.Collections.Generic.IList<decimal>))");
                w.Open("{");
                w.Line("if (prop.Value.ValueKind != System.Text.Json.JsonValueKind.Array) { __issues.Add(\"invalid_type\", __wire + \" is not an array\", __wire); continue; }");
                w.Line("var __decs = new System.Collections.Generic.List<decimal>();");
                w.Line("var __decBad = false;");
                w.Line("foreach (var __el in prop.Value.EnumerateArray())");
                w.Open("{");
                w.Line("if (!DecimalWire.TryParseElement(__el, out var __d1)) { __issues.Add(\"invalid_type\", __wire + \" holds a value that is not a decimal\", __wire, __decs.Count); __decBad = true; break; }");
                w.Line("if (!DecimalWire.FitsDeclared(existing.GetType(), target.Name, __d1)) { __issues.Add(\"too_big\", __wire + \" holds a value over its declared precision and scale\", __wire, __decs.Count); __decBad = true; break; }");
                w.Line("__decs.Add(__d1);");
                w.Close("}");
                w.Line("if (__decBad) continue;");
                w.Line("__val = __decs;");
                w.Close("}");
                arm = "else if";
            }
            // field.duration: a bare TimeSpan deserialized here would take System.Text.Json's own
            // "01:30:00" form, not the property's ISO-8601 converter, so the duration arms read the
            // wire form through `DurationWire` (the copy the entity generator emits into this
            // namespace) and refuse anything else with the validation envelope.
            if (hasDuration)
            {
                w.Line($"{arm} (clr == typeof(System.TimeSpan))");
                w.Open("{");
                w.Line("if (!DurationWire.TryParseElement(prop.Value, out var __dur)) { __issues.Add(\"invalid_type\", __wire + \" is not an ISO-8601 duration\", __wire); continue; }");
                w.Line("__val = __dur;");
                w.Close("}");
                w.Line("else if (clr == typeof(System.Collections.Generic.IList<System.TimeSpan>))");
                w.Open("{");
                w.Line("if (prop.Value.ValueKind != System.Text.Json.JsonValueKind.Array) { __issues.Add(\"invalid_type\", __wire + \" is not an array\", __wire); continue; }");
                w.Line("var __durs = new System.Collections.Generic.List<System.TimeSpan>();");
                w.Line("var __durBad = false;");
                w.Line("foreach (var __el in prop.Value.EnumerateArray())");
                w.Open("{");
                w.Line("if (!DurationWire.TryParseElement(__el, out var __u1)) { __issues.Add(\"invalid_type\", __wire + \" holds a value that is not an ISO-8601 duration\", __wire, __durs.Count); __durBad = true; break; }");
                w.Line("__durs.Add(__u1);");
                w.Close("}");
                w.Line("if (__durBad) continue;");
                w.Line("__val = __durs;");
                w.Close("}");
            }
            w.Line("else");
            w.Open("{");
            w.Line("try { __val = System.Text.Json.JsonSerializer.Deserialize(prop.Value.GetRawText(), clr, jsonOpts); }");
            w.Line("catch (System.Exception __e) { __issues.AddReadFailure(__e, clr, __wire); continue; }");
            w.Close("}");
        }
        else
        {
            w.Line("object? __val;");
            w.Line("try { __val = System.Text.Json.JsonSerializer.Deserialize(prop.Value.GetRawText(), clr, jsonOpts); }");
            w.Line("catch (System.Exception __e) { __issues.AddReadFailure(__e, clr, __wire); continue; }");
        }
        w.Line("// FR-036 A2 — validate the PRESENT, non-null value with the same per-field");
        w.Line("// DataAnnotations as create. This validates ONLY the present value (never the");
        w.Line("// whole row) so an ABSENT @required field is untouched, not a 400.");
        w.Line("if (!__issues.ValidateProperty(existing, target.Name, __val, jsonOpts)) continue;");
        w.Line("entry.CurrentValues[target] = __val;");
        w.Close("}");
        w.Line("if (__issues.Any) return __issues.ToResult();");
    }

    // Emit the per-subtype CRUD route set under /<base>/<segment>. Scoped to the subtype
    // via db.<DbSet>.OfType<Sub>(); cross-subtype ids are invisible (404). Create binds the
    // subtype CLR type (discriminator injected by EF on Add); update is a partial merge
    // that never touches the PK or the discriminator.
    protected virtual void WriteTphSubtypeRoutes(
        CsWriter w, TphSubtypePlan st, IReadOnlyList<MetaObject> hierarchy, MetaRoot root, GenConfig config, string baseRoute, string baseCls, string dbSet,
        string pkType, string pkProp, string discProp, MetaField? discField, Action<string> onWarn)
    {
        // #362 — field.object columns on a TPH subtype stay out of scope (Program D §6), but a
        // field.map @objectRef is NOT: it reaches the settable set, so its value objects reach
        // both write paths and must be validated on each.
        var mapVoFields = MapValueObjectFields(st.Entity, root, config);
        var subCls = CSharpNaming.Pascal(st.Entity.Name);
        var subType = ValueObjectNames.Ref(st.Entity, config);
        var subAllowlist = ValueObjectNames.CompanionRef(st.Entity, config, subCls + "FilterAllowlist");
        var seg = st.RouteSegment;
        var subRoute = baseRoute + "/" + seg;

        // Issue #203 — @autoSet columns on the subtype's EFFECTIVE fields (a shared
        // BaseEntity.createdAt/updatedAt is inherited by every subtype). Stamped on
        // create/update and skipped in the merge, exactly like a vanilla entity.
        var autoSetFields = AutoSetFields(st.Entity, config);
        var autoSetNavs = autoSetFields.Select(a => a.Nav).ToList();
        // FR-037 R1 — readOnly / writeOnce on the SUBTYPE's effective fields (a shared
        // base's mode is inherited by every subtype), excluded from the PATCH merge.
        var frozenNavs = FrozenNavs(st.Entity, config);
        // #484 — as on a plain entity: write-denied keys ignored, credentials omitted. One shared
        // column may be declared by several subtypes, so a mark on any declaration counts.
        var deniedFields = HierarchyMarkedFields(st.Entity, hierarchy, IsApiWriteDenied);
        var credentials = HierarchyMarkedFields(st.Entity, hierarchy, IsCredentialField).SelectMany(f => CredentialSpellings(f, config)).ToList();

        // Per-subtype list: GET /<base>/<seg>
        w.Blank();
        w.Line("app.MapGet(prefix + \"/" + subRoute + "\", async (HttpContext http, " + ValueObjectNames.ContextTypeRef(config) + " db) =>");
        w.Open("{");
        w.Line("var qs = http.Request.Query;");
        w.Line($"IQueryable<{subType}> q = db.{dbSet}.OfType<{subType}>().AsNoTracking();");
        var fmS = FilterMapArg(subAllowlist, st.Entity, config);
        WriteListQuery(w, subType, subAllowlist, fmS, $"{subCls}SortRules", NullsLargestSort("q", "EF.Property<object>(x!, __sortProp)"));
        WriteListPage(w, root.Api.Pagination);
        w.Line("var rows = await q.ToListAsync();");
        w.Line("var withCount = qs.TryGetValue(\"withCount\", out var wc) && (wc == \"1\" || string.Equals(wc, \"true\", System.StringComparison.OrdinalIgnoreCase));");
        w.Line($"if (!withCount) return {OkResult("rows", credentials)};");
        w.Line($"var total = await EfCoreFilterDispatch.Apply(db.{dbSet}.OfType<{subType}>().AsNoTracking(), listQuery, {subAllowlist}.Rules{fmS}).CountAsync();");
        w.Line($"return {OkResult("new { rows, total }", credentials, envelope: true)};");
        w.Close("});");

        // Per-subtype get: GET /<base>/<seg>/{id} — scoped (cross-subtype → 404).
        w.Blank();
        w.Line("app.MapGet(prefix + \"/" + subRoute + "/{id}\", async (HttpContext http, " + ValueObjectNames.ContextTypeRef(config) + " db) =>");
        w.Open("{");
        WriteReadId(w, pkType!);
        w.Line($"return await db.{dbSet}.OfType<{subType}>().AsNoTracking().FirstOrDefaultAsync(x => x.{pkProp} == id) is {{ }} found");
        using (w.Hanging()) w.Line("? " + OkResult("found", credentials));
        using (w.Hanging()) w.Line(": Results.NotFound(new { error = \"not_found\" });");
        w.Close("});");

        // Per-subtype create: POST /<base>/<seg> — discriminator injected by EF via the
        // subtype CLR type; the POST body OMITS the discriminator. FR-036 #4: the @required-key
        // presence set spans the subtype's EFFECTIVE fields (base + own) minus the PK and the
        // (EF-injected) discriminator, so an omitted @required value-type field → 400.
        var requiredKeys = RequiredCreateKeys(st.Entity, f =>
        {
            var p = CSharpNaming.PropertyName(f, config);
            return string.Equals(p, pkProp, System.StringComparison.Ordinal)
                   || string.Equals(p, discProp, System.StringComparison.Ordinal);
        });
        w.Blank();
        // VO columns on a TPH subtype are out of scope (Program D §6) — no typed arms.
        WriteCreateHandler(w, "/" + subRoute, subType, ValueObjectNames.ContextTypeRef(config), dbSet, requiredKeys,
            CreatedResult("prefix + \"/" + subRoute + "/\" + input." + pkProp, "input", credentials), [], mapVoFields, autoSetFields,
            deniedNavs: deniedFields.Select(f => CSharpNaming.PropertyName(f, config)).ToList(), credentials: credentials,
            serverOwned: ServerOwnedCreateResets(st.Entity, root, config, discField, hierarchy[0]), root: root,
            readOnlyRequired: RequiredReadOnlyProps(st.Entity, config));

        // Per-subtype update (PATCH + PUT): partial merge of the JSON body onto the scoped
        // entity, NEVER touching the PK or the discriminator. Cross-subtype id → 404.
        w.Blank();
        w.Line("async System.Threading.Tasks.Task<IResult> Update" + subCls + "(HttpContext http, " + ValueObjectNames.ContextTypeRef(config) + " db)");
        w.Open("{");
        WriteReadId(w, pkType!);
        w.Line($"var existing = await db.{dbSet}.OfType<{subType}>().FirstOrDefaultAsync(x => x.{pkProp} == id);");
        w.Line("if (existing is null) return Results.NotFound(new { error = \"not_found\" });");
        w.Line("System.Text.Json.JsonDocument body;");
        w.Line("try { body = await System.Text.Json.JsonDocument.ParseAsync(http.Request.Body); }");
        w.Line("catch (System.Text.Json.JsonException) { return RouteErrors.InvalidJson(); }");
        w.Line("using var bodyScope = body;");
        w.Line("if (body.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object) return ValidationIssues.Unreadable();");
        WriteUnknownFieldsCheck(w, root, "body");
        w.Line("// Configured JSON options (not defaults) so a custom converter — e.g. the");
        w.Line("// field.timestamp DateTimeOffset converter — is honored; defaults throw 500 on it.");
        w.Line("var jsonOpts = ((Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>)");
        using (w.Hanging()) w.Line("http.RequestServices.GetService(typeof(Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>))!)");
        using (w.Hanging()) w.Line(".Value.SerializerOptions;");
        w.Line("var entry = db.Entry(existing);");
        WriteUpdateAutoSet(w, autoSetFields);
        // ADR-0045 + the 0.19.4 lesson: TPH is a SEPARATE code path per port, so the
        // per-subtype merge states the same exclusion rather than inheriting it.
        WritePartialMergeLoop(w, discProp, [], mapVoFields, autoSetNavs, frozenNavs, HasDecimalField(st.Entity),
            deniedFields.SelectMany(f => WireKeys(f, config)).ToList(), deniedFields.Select(f => CSharpNaming.PropertyName(f, config)).ToList(), HasIsoDurationField(st.Entity, root));
        WriteSaveChanges(w);
        w.Line($"return {OkResult("existing", credentials)};");
        w.Close("}");
        w.Line("app.MapPatch(prefix + \"/" + subRoute + "/{id}\", Update" + subCls + ");");
        w.Line("app.MapPut(prefix + \"/" + subRoute + "/{id}\", Update" + subCls + ");");

        // Per-subtype delete: DELETE /<base>/<seg>/{id} — scoped (cross-subtype → 404).
        w.Blank();
        w.Line("app.MapDelete(prefix + \"/" + subRoute + "/{id}\", async (HttpContext http, " + ValueObjectNames.ContextTypeRef(config) + " db) =>");
        w.Open("{");
        WriteReadId(w, pkType!);
        w.Line($"var existing = await db.{dbSet}.OfType<{subType}>().FirstOrDefaultAsync(x => x.{pkProp} == id);");
        w.Line("if (existing is null) return Results.NotFound(new { error = \"not_found\" });");
        w.Line($"db.{dbSet}.Remove(existing);");
        WriteSaveChanges(w);
        w.Line("return Results.NoContent();");
        w.Close("});");

        // FW-8 — M:N traversal this SUBTYPE resolves, own + INHERITED (rule b: use the
        // resolving Relationships(), not an own-only read — M2MNavigationBuilder.For
        // already does this, so a relationship declared on the base or on an abstract
        // mid level between the base and this subtype is served here too; that overlap
        // with the base's own mount is deliberate, not redundant, per rule (b)). Every
        // mount is scoped: the junction FK addresses the shared base table, so without
        // the scope a sibling subtype's id would traverse it just as well and the
        // segment in the URL would be decorative (rule c).
        var sourceScope = new TphM2mSourceScope(dbSet, subType, pkProp);
        foreach (var nav in M2MNavigationBuilder.For(st.Entity, root, onWarn))
            WriteM2mRoute(w, nav, subRoute, pkType, root, config, sourceScope);
    }

    /// <summary>
    /// Emit the write, with the database's own constraints translated to the api
    /// contract's client errors.
    /// <para>
    /// A bare <c>await db.SaveChangesAsync();</c> let a driver failure reach ASP.NET's
    /// default handler, so a client-supplied foreign key naming no row — or a value
    /// duplicating a unique one — came back as a 500. Both are CLIENT errors, declared by
    /// the same metadata (<c>identity.reference</c>, <c>index.unique</c>) the handler
    /// already uses to reject bad enum members and missing required fields.
    /// </para>
    /// <para>
    /// An UNRECOGNISED failure rethrows: the operator keeps the full diagnostic and the
    /// caller still gets a plain 500. Classification lives in
    /// <see cref="Runtime.ConstraintErrors"/>, which is the C# half of runtime-ts's
    /// <c>constraint-errors.ts</c> — one code (<c>constraint_violation</c>) plus the
    /// kind, identical on both ports.
    /// </para>
    /// </summary>
    protected virtual void WriteSaveChanges(CsWriter w)
    {
        w.Line("try { await db.SaveChangesAsync(); }");
        w.Line("catch (System.Exception __saveError)");
        w.Open("{");
        w.Line("if (ConstraintErrors.Classify(__saveError) is { } __constraint)");
        using (w.Hanging()) w.Line("return Results.Json(");
        using (w.Hanging()) using (w.Hanging()) w.Line("new { error = __constraint.Error, constraint = __constraint.Constraint },");
        using (w.Hanging()) using (w.Hanging()) w.Line("statusCode: __constraint.Status);");
        w.Line("throw;");
        w.Close("}");
    }

    // A junction/target column's CLR property, through the same resolver its entity class used.
    protected static string JunctionProperty(MetaObject owner, string fieldName, GenConfig config) =>
        owner.FindField(fieldName) is { } f ? CSharpNaming.PropertyName(f, config) : CSharpNaming.Pascal(fieldName);

    // Emit the M:N traversal handler for one navigation. The junction + target are
    // mapped DbSets; the handler does the same two-stage join M2MResolver performs at
    // runtime, but over the generated DbSets via EF.Property (no metadata at runtime).
    //
    //   hetero / directed self-join: junction WHERE <SourceFkProp> = id → <TargetFkProp>,
    //                                then target WHERE pk IN (...).
    //   symmetric self-join: junction WHERE <SourceFkProp> = id OR <TargetFkProp> = id;
    //                        per row the related id is whichever column is NOT the source id.
    //
    // Junction FK properties / target PK property are EF.Property<T>(...) lookups, so the
    // handler stays reflection-free and EF translates the property access to the column.
    //
    // `root` resolves whether the TARGET is a TPH subtype (Defect B): such a subtype has
    // no table/DbSet of its own — DbContextGenerator.AppliesTo excludes it — so binding to
    // `db.<Pluralize(Target)>` names a DbSet property that does not exist and the generated
    // routes file fails to compile. `sourceScope`, when supplied, is the mirror problem on
    // the SOURCE side: this mount hangs under a TPH SUBTYPE's own path segment, but the
    // junction FK still addresses the shared base table, so a sibling subtype's id would
    // traverse it just as well and the segment would be decorative (rule c in the
    // cross-port contract; mirrors TS mount-m2m.ts's `sourceDiscriminator` Stage 0).
    protected virtual void WriteM2mRoute(
        CsWriter w, M2MNavigation nav, string sourceRoute, string pkType, MetaRoot root,
        GenConfig config, TphM2mSourceScope? sourceScope = null)
    {
        var relSeg = nav.Name;                                    // relationship name segment
        var targetCls = ValueObjectNames.Ref(nav.Target, config);
        // Defect B — a TPH subtype target is folded into its discriminator base's single
        // table (no DbSet of its own). Bind to the BASE's DbSet and narrow with
        // OfType<Sub>() so the emitted db.<DbSet> always names a real property; every
        // other target keeps binding to its own pluralized DbSet, byte-identical to before.
        var targetFrom = TphPlanBuilder.IsTphSubtype(nav.Target, root)
            ? $"db.{CSharpNaming.DbSetName(TphPlanBuilder.DiscriminatorRoot(nav.Target)!)}.OfType<{targetCls}>()"
            : $"db.{CSharpNaming.DbSetName(nav.Target)}";
        // The DbSet the context declares for the junction, @collectionName included (item 17).
        var junctionDbSet = CSharpNaming.DbSetName(nav.Junction);
        var srcFkProp = JunctionProperty(nav.Junction, nav.SourceField, config);
        var tgtFkProp = JunctionProperty(nav.Junction, nav.TargetField, config);

        // The junction FK CLR type (the related-id key type) + the target PK property.
        var fkType = JunctionFkType(nav);
        var targetPk = nav.Target.PrimaryIdentity()?.Fields is { Count: 1 } tf
            ? JunctionProperty(nav.Target, tf[0], config) : "Id";

        w.Blank();
        w.Line("app.MapGet(prefix + \"/" + sourceRoute + "/{id}/" + relSeg + "\", async (HttpContext http, " + ValueObjectNames.ContextTypeRef(config) + " db) =>");
        w.Open("{");
        WriteReadId(w, pkType);
        if (sourceScope is not null)
        {
            // Rule c — prove the id names a row of THIS subtype before touching the
            // junction. A well-formed id belonging to a SIBLING subtype is not an error
            // (it just has no relations under this segment): 200 with an empty list,
            // never 404 and never the sibling's rows.
            w.Line($"if (!await db.{sourceScope.DbSet}.OfType<{sourceScope.SubtypeClass}>().AnyAsync(x => x.{sourceScope.PkProp} == id))");
            using (w.Hanging()) w.Line($"return Results.Ok(new System.Collections.Generic.List<{targetCls}>());");
        }
        if (nav.Symmetric)
        {
            // Union both junction columns; the related id is the column that is NOT the source id.
            w.Line($"var pairs = await db.{junctionDbSet}.AsNoTracking()");
            using (w.Hanging()) w.Line($".Where(j => EF.Property<{fkType}>(j, \"{srcFkProp}\").Equals(id) || EF.Property<{fkType}>(j, \"{tgtFkProp}\").Equals(id))");
            using (w.Hanging()) w.Line($".Select(j => new {{ S = EF.Property<{fkType}>(j, \"{srcFkProp}\"), T = EF.Property<{fkType}>(j, \"{tgtFkProp}\") }})");
            using (w.Hanging()) w.Line(".ToListAsync();");
            w.Line($"var relatedIds = new System.Collections.Generic.HashSet<{fkType}>();");
            w.Line("foreach (var p in pairs)");
            using (w.Hanging()) w.Line("relatedIds.Add(p.S.Equals(id) ? p.T : p.S);");
        }
        else
        {
            w.Line($"var relatedIds = (await db.{junctionDbSet}.AsNoTracking()");
            using (w.Hanging()) w.Line($".Where(j => EF.Property<{fkType}>(j, \"{srcFkProp}\").Equals(id))");
            using (w.Hanging()) w.Line($".Select(j => EF.Property<{fkType}>(j, \"{tgtFkProp}\"))");
            using (w.Hanging()) w.Line(".ToListAsync()).ToHashSet();");
        }
        w.Line($"if (relatedIds.Count == 0) return Results.Ok(new System.Collections.Generic.List<{targetCls}>());");
        w.Line($"var rows = await {targetFrom}.AsNoTracking()");
        using (w.Hanging()) w.Line($".Where(t => relatedIds.Contains(EF.Property<{fkType}>(t, \"{targetPk}\")))");
        using (w.Hanging()) w.Line(".ToListAsync();");
        w.Line($"return {OkResult("rows", TphUnionCredentialNames(nav.Target, root, config))};");
        w.Close("});");
    }

    /// <summary>
    /// Where a subtype-scoped M:N mount proves the id in the URL really names a row of
    /// THAT subtype (rule c). <c>DbSet</c> is the BASE's DbSet property name (the
    /// subtype has none of its own); <c>SubtypeClass</c> narrows it via
    /// <c>OfType&lt;SubtypeClass&gt;()</c>; <c>PkProp</c> is the (shared) PK CLR
    /// property. Mirrors TS mount-m2m.ts's <c>sourceDiscriminator</c> option — this is
    /// the codegen-time descriptor for that runtime check.
    /// </summary>
    protected record TphM2mSourceScope(string DbSet, string SubtypeClass, string PkProp);

    // The CLR type of the junction FK columns (and thus the related-id key). Both
    // junction references point at same-typed PKs; use the source FK field's subtype.
    protected static string JunctionFkType(M2MNavigation nav)
    {
        var fkField = nav.Junction.FindField(nav.SourceField);
        return fkField is not null ? CSharpNaming.ScalarFor(fkField.SubType) ?? "long" : "long";
    }

    /// <summary>
    /// Emit a case-insensitive dictionary of each sortable field's DECLARED
    /// <c>@sortableDefaultOrder</c>, keyed by the SAME Pascal name the sort allowlist
    /// carries so the generated lookup can key on the allowlist's resolved value.
    /// </summary>
    /// <remarks>
    /// Declared orders only — a field with no <c>@sortableDefaultOrder</c> is absent and
    /// the generated handler supplies ascending. That split matches the other four ports:
    /// one place per port spells the fallback, so no port can drift by baking a different
    /// default into its map. <c>Attr()</c> is the RESOLVING accessor (ADR-0039), so an
    /// order inherited via <c>extends</c> is honoured.
    /// </remarks>
    /// <summary>
    /// The emitted sort expression for one column, with nulls LARGER than any value: ASC puts
    /// them last, DESC first, on every provider (Postgres's own default; SQLite and MySQL
    /// would otherwise put them first on ASC). A leading `col == null` key says it in a way
    /// every EF Core provider translates, where `NULLS LAST` is not portable.
    /// </summary>
    protected static string NullsLargestSort(string query, string column) =>
        $"desc ? {query}.OrderByDescending(x => {column} == null).ThenByDescending(x => {column}) : {query}.OrderBy(x => {column} == null).ThenBy(x => {column})";
}
