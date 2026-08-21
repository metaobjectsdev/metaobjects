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
//   - GET list honours ?limit=N&offset=N pagination.
//   - GET list honours ?sort=<field>:asc|desc against a static SortAllowlist
//     derived from the entity's scalar fields (case-insensitive lookup).
//     Unknown field → 400 { "error": "validation", "message": ... }.
//   - GET list honours ?withCount=1 → switches the envelope from a bare row
//     array to { rows, total }. The grid hook always sends withCount=1.
//   - Update accepts BOTH PATCH and PUT (TS reference exposes both; we match).
//   - 404 responses carry a JSON envelope: { "error": "not_found" }.
//
// Filter operators (eq/ne/gt/gte/lt/lte/in/like/isNull) ship via FR-009 — the
// generated list handler calls FilterParser.Parse against the per-entity
// <Entity>FilterAllowlist (emitted by FilterAllowlistGenerator), then
// dispatches the resulting predicates onto the IQueryable<T> via
// EfCoreFilterDispatch.ApplyFilter. Both helpers live in
// MetaObjects.Codegen.Runtime — consumers reference the codegen assembly
// at runtime in their ASP.NET host.

using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>Generates Minimal API CRUD route registration per <c>object.entity</c>.</summary>
public class RoutesGenerator : PerEntityGenerator
{
    public override string Name => "routes-generator";

    protected override bool Filter(MetaObject entity) =>
        (entity.IsEntity() || entity.DbView is not null) && InstanceArtifacts.EmitsInstanceArtifacts(entity);

    /// <summary>
    /// True iff this entity gets a generated routes file: it passes <see cref="Filter"/>
    /// (persisted, instance-emitting) and is NOT a TPH subtype (subtypes are served via
    /// the base's per-subtype routes). Single source of truth shared by the generator
    /// loop AND the api-docs builder (so docs never claim REST a routes-off entity lacks).
    /// </summary>
    public static bool AppliesTo(MetaObject entity, MetaRoot root) =>
        (entity.IsEntity() || entity.DbView is not null)
        && InstanceArtifacts.EmitsInstanceArtifacts(entity)
        && !TphPlanBuilder.IsTphSubtype(entity, root);

    // FR-017 TPH: a concrete subtype is served via its base's per-subtype routes — it
    // emits NO standalone routes file (the base mounts polymorphic + per-subtype CRUD).
    // The subtype skip needs the root, which Filter doesn't receive, so it is applied
    // here where the GenContext is in scope.
    public override IEnumerable<EmittedFile> Generate(GenContext ctx) =>
        ctx.Entities
            .Where(e => AppliesTo(e, ctx.Root))
            .Select(e => GenerateOne(e, ctx));

    protected override EmittedFile GenerateOne(MetaObject entity, GenContext ctx)
    {
        if (TphPlanBuilder.For(entity, ctx.Root) is { } tph)
            return GenerateTphRoutes(entity, tph, ctx);
        return GenerateStandardRoutes(entity, ctx);
    }

    protected virtual EmittedFile GenerateStandardRoutes(MetaObject entity, GenContext ctx)
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
                pkProp = CSharpNaming.Pascal(pkField.Name);
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
        var voFields = ValueObjectFields(entity, ctx.Root, ctx.Config.ColumnNamingStrategy);
        // Issue #203 — @autoSet timestamp columns the generated CRUD stamps with now()
        // (insert stamps all; update stamps onUpdate; the merge loop skips them; an
        // InsertPreserving escape hatch is emitted when any exist).
        var autoSetFields = AutoSetFields(entity);
        var autoSetNavs = autoSetFields.Select(a => a.Nav).ToList();
        // FR-037 R1 — readOnly / writeOnce are excluded from the PATCH merge.
        var frozenNavs = FrozenNavs(entity);
        // Physical table + PK column for the post-save array-null clear (EF OwnsMany ToJson
        // writes [] for a null nav, so a nullable array column is NULLed via raw SQL).
        var table = CSharpNaming.Table(entity);
        var pkColumn = pkFields.Count == 1 && entity.Fields().FirstOrDefault(f => f.Name == pkFields[0]) is { } pkf
            ? CSharpNaming.Column(pkf, ctx.Config.ColumnNamingStrategy)
            : "id";
        if (!hasItem)
            ctx.Warn($"{Name}: \"{entity.Name}\" has no single-column primary key — emitting collection GET only.");

        // Sort allowlist: every scalar field on the entity is sortable. The
        // generated handler does case-insensitive lookup so the wire grammar
        // (?sort=createdAt:desc) matches the C# property name (CreatedAt).
        var sortFields = entity.Fields()
            .Where(f => CSharpNaming.ScalarFor(f.SubType) is not null && !f.ResolvedIsArray())
            .Select(f => CSharpNaming.Pascal(f.Name))
            .ToList();

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects routes-generator. Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System.Linq;");
        sb.AppendLine("using Microsoft.AspNetCore.Builder;");
        sb.AppendLine("using Microsoft.AspNetCore.Http;");
        sb.AppendLine("using Microsoft.AspNetCore.Routing;");
        sb.AppendLine("using Microsoft.EntityFrameworkCore;");
        sb.AppendLine("using MetaObjects.Codegen.Runtime;");
        sb.AppendLine();
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        sb.AppendLine($"public static class {cls}Routes");
        sb.AppendLine("{");
        // Static sort allowlist (case-insensitive) so the qs ?sort=field:dir
        // is gated against the entity's scalar fields.
        sb.Append("    private static readonly System.Collections.Generic.HashSet<string> SortAllowlist =");
        sb.AppendLine(" new(System.StringComparer.OrdinalIgnoreCase)");
        sb.AppendLine("    {");
        foreach (var name in sortFields) sb.AppendLine($"        \"{name}\",");
        sb.AppendLine("    };");
        sb.AppendLine();
        sb.AppendLine($"    public static IEndpointRouteBuilder Map{cls}Routes(this IEndpointRouteBuilder app, string prefix = \"/api\")");
        sb.AppendLine("    {");

        // List — honours ?limit / ?offset / ?sort / ?withCount per api-contract.md.
        sb.AppendLine("        app.MapGet(prefix + \"/" + route + "\", async (HttpContext http, AppDbContext db) =>");
        sb.AppendLine("        {");
        sb.AppendLine("            var qs = http.Request.Query;");
        sb.AppendLine($"            IQueryable<{readCls}> q = db." + readDbSet + ".AsNoTracking();");
        sb.AppendLine();
        sb.AppendLine("            // Filter: ?filter[<field>][<op>]=<value> against the per-entity allowlist.");
        sb.AppendLine($"            var filter = FilterParser.Parse(qs, {cls}FilterAllowlist.Fields, {cls}FilterAllowlist.OpsByField);");
        sb.AppendLine("            if (filter.ErrorEnvelope is not null)");
        sb.AppendLine("                return Results.BadRequest(new { error = filter.ErrorEnvelope });");
        sb.AppendLine($"            q = EfCoreFilterDispatch.ApplyFilter(q, filter.Predicates);");
        sb.AppendLine();
        sb.AppendLine("            // Sort: ?sort=field:asc|desc against the static allowlist.");
        sb.AppendLine("            if (qs.TryGetValue(\"sort\", out var sortRaw) && !string.IsNullOrWhiteSpace(sortRaw))");
        sb.AppendLine("            {");
        sb.AppendLine("                var parts = sortRaw.ToString().Split(':', 2);");
        sb.AppendLine("                var field = parts[0];");
        sb.AppendLine("                var desc = parts.Length > 1 && string.Equals(parts[1], \"desc\", System.StringComparison.OrdinalIgnoreCase);");
        sb.AppendLine("                if (!SortAllowlist.TryGetValue(field, out var resolved))");
        sb.AppendLine("                    return Results.BadRequest(new { error = \"invalid_sort\" });");
        sb.AppendLine($"                q = ApplySort{cls}(q, resolved, desc);");
        sb.AppendLine("            }");
        sb.AppendLine();
        sb.AppendLine("            // Pagination: ?offset=N first (skip), then ?limit=N (take).");
        sb.AppendLine("            if (qs.TryGetValue(\"offset\", out var offsetRaw) && int.TryParse(offsetRaw, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var offset) && offset > 0)");
        sb.AppendLine("                q = q.Skip(offset);");
        sb.AppendLine("            if (qs.TryGetValue(\"limit\", out var limitRaw) && int.TryParse(limitRaw, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var limit) && limit > 0)");
        sb.AppendLine("                q = q.Take(limit);");
        sb.AppendLine();
        sb.AppendLine("            var rows = await q.ToListAsync();");
        sb.AppendLine();
        sb.AppendLine("            // withCount=1 → { rows, total } envelope; otherwise bare row array.");
        sb.AppendLine("            var withCount = qs.TryGetValue(\"withCount\", out var wc) && (wc == \"1\" || string.Equals(wc, \"true\", System.StringComparison.OrdinalIgnoreCase));");
        sb.AppendLine("            if (!withCount) return Results.Ok(rows);");
        sb.AppendLine($"            var totalQ = EfCoreFilterDispatch.ApplyFilter(db.{readDbSet}.AsNoTracking(), filter.Predicates);");
        sb.AppendLine("            var total = await totalQ.CountAsync();");
        sb.AppendLine("            return Results.Ok(new { rows, total });");
        sb.AppendLine("        });");

        if (hasItem)
        {
            sb.AppendLine();
            sb.AppendLine("        app.MapGet(prefix + \"/" + route + "/{id}\", async (" + pkType + " id, AppDbContext db) =>");
            sb.AppendLine("            await db." + readDbSet + ".FindAsync(id) is { } found");
            sb.AppendLine("                ? Results.Ok(found)");
            sb.AppendLine("                : Results.NotFound(new { error = \"not_found\" }));");
        }

        if (writable)
        {
            // FR-036 #4 — @required-key presence set (the non-PK @required fields whose keys
            // must be PRESENT + non-null on a create body). A @required VALUE-TYPE field (e.g.
            // field.timestamp → non-nullable DateTimeOffset) binds to a CLR default when
            // omitted, invisible to [Required], so the create handler checks raw-JSON presence.
            var requiredKeys = RequiredCreateKeys(entity, f => pkFields.Contains(f.Name));
            sb.AppendLine();
            // #214 — a write-through create binds the derived-FREE WRITE entity, persists to
            // the table, then RE-READS the row through the replica view by PK so the returned
            // body carries the derived (view-computed) fields (read-your-writes).
            AppendCreateHandler(sb, "/" + route, cls, dbSet, requiredKeys,
                "Results.Created(prefix + \"/" + route + "\", input)", voFields, autoSetFields,
                writeThrough ? (readDbSet, pkProp!, route) : null);

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
            // emitted by AppendPartialMergeLoop.
            sb.AppendLine();
            sb.AppendLine("        async System.Threading.Tasks.Task<IResult> Update" + cls + "(" + pkType + " id, HttpContext http, AppDbContext db)");
            sb.AppendLine("        {");
            sb.AppendLine("            var existing = await db." + dbSet + ".FindAsync(id);");
            sb.AppendLine("            if (existing is null) return Results.NotFound(new { error = \"not_found\" });");
            sb.AppendLine("            using var body = await System.Text.Json.JsonDocument.ParseAsync(http.Request.Body);");
            sb.AppendLine("            // Deserialize each value with the app's CONFIGURED JSON options, not defaults —");
            sb.AppendLine("            // a field.timestamp binds to DateTimeOffset via a custom converter registered on");
            sb.AppendLine("            // ConfigureHttpJsonOptions, and default options cannot read the wire format, throwing 500.");
            sb.AppendLine("            var jsonOpts = ((Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>)");
            sb.AppendLine("                http.RequestServices.GetService(typeof(Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>))!)");
            sb.AppendLine("                .Value.SerializerOptions;");
            sb.AppendLine("            var entry = db.Entry(existing);");
            AppendUpdateAutoSet(sb, autoSetFields);
            AppendPartialMergeLoop(sb, null, voFields, autoSetNavs, frozenNavs);
            sb.AppendLine("            await db.SaveChangesAsync();");
            AppendArrayNullClears(sb, voFields, table, pkColumn);
            // #214 — writes target the table; for a write-through entity re-read the row
            // through the replica view by PK so the returned body carries the derived fields.
            if (writeThrough)
            {
                sb.AppendLine($"            var __view = await db.{readDbSet}.FindAsync(id);");
                // #214 [2] — a @kind:materializedView (unrefreshed) or filtered replica view may
                // not surface the just-written row; fall back to the write entity so the body is
                // never null (degraded — missing only the derived fields; matches the Python port).
                sb.AppendLine("            return Results.Ok((object?)__view ?? existing);");
            }
            else
            {
                sb.AppendLine("            return Results.Ok(existing);");
            }
            sb.AppendLine("        }");
            sb.AppendLine("        app.MapPatch(prefix + \"/" + route + "/{id}\", Update" + cls + ");");
            sb.AppendLine("        app.MapPut(prefix + \"/" + route + "/{id}\", Update" + cls + ");");
            sb.AppendLine();
            sb.AppendLine("        app.MapDelete(prefix + \"/" + route + "/{id}\", async (" + pkType + " id, AppDbContext db) =>");
            sb.AppendLine("        {");
            sb.AppendLine("            var existing = await db." + dbSet + ".FindAsync(id);");
            sb.AppendLine("            if (existing is null) return Results.NotFound(new { error = \"not_found\" });");
            sb.AppendLine("            db." + dbSet + ".Remove(existing);");
            sb.AppendLine("            await db.SaveChangesAsync();");
            sb.AppendLine("            return Results.NoContent();");
            sb.AppendLine("        });");
        }

        // FR-018 M:N traversal — GET /<source-plural>/{id}/<relationName> through the
        // junction. Only on a single-PK source (the route addresses the source by id).
        // Cross-port contract: source URL segment = pluralized ENTITY name, relation
        // segment = relationship name.
        if (hasItem)
            foreach (var nav in M2MNavigationBuilder.For(entity, ctx.Root))
                AppendM2mRoute(sb, nav, route, pkType!);

        sb.AppendLine();
        sb.AppendLine("        return app;");
        sb.AppendLine("    }");
        sb.AppendLine();
        // Allowlisted property name → IOrderedQueryable dispatch via EF.Property.
        // Reflection-free at runtime; EF Core translates EF.Property(x, "<Name>")
        // into the column reference at SQL generation.
        sb.AppendLine($"    private static IOrderedQueryable<{readCls}> ApplySort{cls}(IQueryable<{readCls}> q, string field, bool desc)");
        sb.AppendLine("    {");
        sb.AppendLine("        return field switch");
        sb.AppendLine("        {");
        foreach (var name in sortFields)
        {
            sb.AppendLine($"            \"{name}\" => desc ? q.OrderByDescending(x => EF.Property<object>(x!, \"{name}\")) : q.OrderBy(x => EF.Property<object>(x!, \"{name}\")),");
        }
        sb.AppendLine("            _ => (IOrderedQueryable<" + readCls + ">)q.OrderBy(x => 0),");
        sb.AppendLine("        };");
        sb.AppendLine("    }");
        // Issue #203 — the verbatim-insert escape hatch, only for an entity with @autoSet
        // fields (writable entities only; a read-only projection has no insert path).
        if (writable && autoSetFields.Count > 0)
            AppendInsertPreserving(sb, cls, dbSet);
        sb.AppendLine("}");

        return new EmittedFile($"{cls}Routes.g.cs", sb.ToString());
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
    protected virtual EmittedFile GenerateTphRoutes(MetaObject baseEntity, TphPlan tph, GenContext ctx)
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
        var pkProp = pkField is not null ? CSharpNaming.Pascal(pkField.Name) : null;
        bool hasItem = pkType is not null;

        var discProp = CSharpNaming.Pascal(tph.DiscriminatorField);

        // Sortable base scalar fields (the polymorphic list sorts on base columns).
        var sortFields = baseEntity.Fields()
            .Where(f => CSharpNaming.ScalarFor(f.SubType) is not null && !f.ResolvedIsArray())
            .Select(f => CSharpNaming.Pascal(f.Name))
            .ToList();

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects routes-generator (TPH). Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System.Linq;");
        sb.AppendLine("using Microsoft.AspNetCore.Builder;");
        sb.AppendLine("using Microsoft.AspNetCore.Http;");
        sb.AppendLine("using Microsoft.AspNetCore.Routing;");
        sb.AppendLine("using Microsoft.EntityFrameworkCore;");
        sb.AppendLine("using MetaObjects.Codegen.Runtime;");
        sb.AppendLine();
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        sb.AppendLine($"public static class {baseCls}Routes");
        sb.AppendLine("{");

        // Polymorphic sort allowlist over the base scalar columns.
        sb.Append("    private static readonly System.Collections.Generic.HashSet<string> SortAllowlist =");
        sb.AppendLine(" new(System.StringComparer.OrdinalIgnoreCase)");
        sb.AppendLine("    {");
        foreach (var name in sortFields) sb.AppendLine($"        \"{name}\",");
        sb.AppendLine("    };");
        sb.AppendLine();

        // Per-subtype sort allowlists (case-insensitive) over each subtype's EFFECTIVE
        // scalar fields (inherited base + own). The per-subtype list resolves the qs
        // ?sort=<field> through this to the CLR property name before EF.Property — a raw
        // lowercase field (e.g. "id") would otherwise fail EF translation (no "id"
        // property; it's "Id") and 500.
        foreach (var st in tph.Subtypes)
        {
            var subClsName = CSharpNaming.Pascal(st.Entity.Name);
            var subSortFields = st.Entity.Fields()
                .Where(f => CSharpNaming.ScalarFor(f.SubType) is not null && !f.ResolvedIsArray())
                .Select(f => CSharpNaming.Pascal(f.Name))
                .ToList();
            sb.Append($"    private static readonly System.Collections.Generic.HashSet<string> {subClsName}SortAllowlist =");
            sb.AppendLine(" new(System.StringComparer.OrdinalIgnoreCase)");
            sb.AppendLine("    {");
            foreach (var name in subSortFields) sb.AppendLine($"        \"{name}\",");
            sb.AppendLine("    };");
            sb.AppendLine();
        }

        sb.AppendLine($"    public static IEndpointRouteBuilder Map{baseCls}Routes(this IEndpointRouteBuilder app, string prefix = \"/api\")");
        sb.AppendLine("    {");

        // --- Polymorphic list: GET /<base> (union of all subtypes; each row carries its discriminator) ---
        sb.AppendLine("        app.MapGet(prefix + \"/" + baseRoute + "\", async (HttpContext http, AppDbContext db) =>");
        sb.AppendLine("        {");
        sb.AppendLine("            var qs = http.Request.Query;");
        sb.AppendLine($"            IQueryable<{baseCls}> q = db.{dbSet}.AsNoTracking();");
        sb.AppendLine($"            var filter = FilterParser.Parse(qs, {baseCls}FilterAllowlist.Fields, {baseCls}FilterAllowlist.OpsByField);");
        sb.AppendLine("            if (filter.ErrorEnvelope is not null) return Results.BadRequest(new { error = filter.ErrorEnvelope });");
        sb.AppendLine("            q = EfCoreFilterDispatch.ApplyFilter(q, filter.Predicates);");
        sb.AppendLine("            if (qs.TryGetValue(\"sort\", out var sortRaw) && !string.IsNullOrWhiteSpace(sortRaw))");
        sb.AppendLine("            {");
        sb.AppendLine("                var parts = sortRaw.ToString().Split(':', 2);");
        sb.AppendLine("                var desc = parts.Length > 1 && string.Equals(parts[1], \"desc\", System.StringComparison.OrdinalIgnoreCase);");
        sb.AppendLine("                if (!SortAllowlist.TryGetValue(parts[0], out var resolved)) return Results.BadRequest(new { error = \"invalid_sort\" });");
        sb.AppendLine("                q = ApplySort(q, resolved, desc);");
        sb.AppendLine("            }");
        sb.AppendLine("            if (qs.TryGetValue(\"offset\", out var offRaw) && int.TryParse(offRaw, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var off) && off > 0) q = q.Skip(off);");
        sb.AppendLine("            if (qs.TryGetValue(\"limit\", out var limRaw) && int.TryParse(limRaw, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var lim) && lim > 0) q = q.Take(lim);");
        sb.AppendLine("            var rows = await q.ToListAsync();");
        sb.AppendLine("            var withCount = qs.TryGetValue(\"withCount\", out var wc) && (wc == \"1\" || string.Equals(wc, \"true\", System.StringComparison.OrdinalIgnoreCase));");
        sb.AppendLine("            if (!withCount) return Results.Ok(rows);");
        sb.AppendLine($"            var total = await EfCoreFilterDispatch.ApplyFilter(db.{dbSet}.AsNoTracking(), filter.Predicates).CountAsync();");
        sb.AppendLine("            return Results.Ok(new { rows, total });");
        sb.AppendLine("        });");

        if (hasItem)
        {
            // --- Polymorphic get: GET /<base>/{id} (one row of whatever subtype) ---
            sb.AppendLine();
            sb.AppendLine("        app.MapGet(prefix + \"/" + baseRoute + "/{id}\", async (" + pkType + " id, AppDbContext db) =>");
            sb.AppendLine($"            await db.{dbSet}.AsNoTracking().FirstOrDefaultAsync(x => x.{pkProp} == id) is {{ }} found");
            sb.AppendLine("                ? Results.Ok(found)");
            sb.AppendLine("                : Results.NotFound(new { error = \"not_found\" }));");

            // --- Per-subtype CRUD sets ---
            foreach (var st in tph.Subtypes)
                AppendTphSubtypeRoutes(sb, st, baseRoute, baseCls, dbSet, pkType!, pkProp!, discProp);
        }

        sb.AppendLine();
        sb.AppendLine("        return app;");
        sb.AppendLine("    }");
        sb.AppendLine();

        // Polymorphic sort dispatch over base scalar columns (reflection-free via EF.Property).
        sb.AppendLine($"    private static IOrderedQueryable<{baseCls}> ApplySort(IQueryable<{baseCls}> q, string field, bool desc)");
        sb.AppendLine("    {");
        sb.AppendLine("        return field switch");
        sb.AppendLine("        {");
        foreach (var name in sortFields)
            sb.AppendLine($"            \"{name}\" => desc ? q.OrderByDescending(x => EF.Property<object>(x!, \"{name}\")) : q.OrderBy(x => EF.Property<object>(x!, \"{name}\")),");
        sb.AppendLine("            _ => (IOrderedQueryable<" + baseCls + ">)q.OrderBy(x => 0),");
        sb.AppendLine("        };");
        sb.AppendLine("    }");
        // Issue #203 — a verbatim-insert escape hatch per subtype that declares @autoSet
        // fields (overloaded by the subtype parameter type; the discriminator is injected by
        // EF via the subtype CLR type on Add). Only when the subtype has @autoSet columns.
        if (hasItem)
            foreach (var st in tph.Subtypes)
                if (AutoSetFields(st.Entity).Count > 0)
                    AppendInsertPreserving(sb, CSharpNaming.Pascal(st.Entity.Name), dbSet);
        sb.AppendLine("}");

        return new EmittedFile($"{baseCls}Routes.g.cs", sb.ToString());
    }

    // FR-036 #4 — the wire keys of the @required fields whose keys must be PRESENT (and
    // non-null) on a create body. Uses the SAME required-predicate as the DTO's [Required]
    // (MetaField.IsRequired = own @required OR a validator.required child), matching the
    // cross-port contract (Java's @NotNull set / Python-Pydantic required set). The caller
    // supplies the exclusion for the PK (server-/route-assigned) and, for a TPH subtype, the
    // (EF-injected) discriminator. Returns the camelCase field names — matched case-insensitively
    // against the raw JSON keys, so a camelCase wire key resolves to its PascalCase property.
    private static List<string> RequiredCreateKeys(MetaObject obj, Func<MetaField, bool> isPkOrDisc) =>
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
            .Where(f => f.IsRequired && f.AutoSet is null && !f.IsDerived() && !isPkOrDisc(f))
            .Select(f => f.Name)
            .ToList();

    // Issue #203 — one @autoSet timestamp column the generated CRUD stamps with now().
    // Nav is the PascalCase CLR property; NowExpr is the now() literal keyed off the
    // COLUMN's temporal CLR type (generalizes beyond DateTimeOffset). OnUpdate columns
    // are stamped on both insert and update; onCreate columns are stamped on insert only
    // (never rewritten on update — the write-once created-at contract).
    private sealed record AutoSetField(string Nav, string NowExpr, bool OnUpdate);

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
    private static List<string> FrozenNavs(MetaObject entity) =>
        entity.Fields()
            .Where(f => f.Mutability != MetaObjects.Core.Field.FieldConstants.MUTABILITY_READ_WRITE)
            .Select(f => CSharpNaming.Pascal(f.Name))
            .ToList();

    private static List<AutoSetField> AutoSetFields(MetaObject entity)
    {
        var list = new List<AutoSetField>();
        foreach (var f in entity.Fields())
        {
            if (f.AutoSet is not (AUTO_SET_ON_CREATE or AUTO_SET_ON_UPDATE)) continue;
            if (NowExprFor(f) is not { } now) continue;   // non-temporal @autoSet — skip
            list.Add(new AutoSetField(
                Nav: CSharpNaming.Pascal(f.Name),
                NowExpr: now,
                OnUpdate: f.AutoSet == AUTO_SET_ON_UPDATE));
        }
        return list;
    }

    // The now() expression for a field, keyed off its COLUMN's temporal CLR type
    // (ADR-0036 Wave 2: field.timestamp is DateTimeOffset, or DateTime under @localTime;
    // field.date → DateOnly; field.time → TimeOnly). Fully qualified so no extra using is
    // needed. Returns null for a non-temporal field.
    private static string? NowExprFor(MetaField field) =>
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
    // deserialize, validate, and assign these as CLR owned-nav properties. WireName is the
    // metadata (camelCase) field name; Nav is the PascalCase property; DeserType is the VO
    // POCO type (or List<VO> for an array); JsonColumn is the physical jsonb column (the
    // .ToJson name); IsArray / Required drive the merge semantics (present-null: a nullable
    // single/array clears, a @required column 400s).
    private sealed record VoField(
        string WireName, string Nav, string DeserType, string JsonColumn, bool IsArray, bool Required);

    private static List<VoField> ValueObjectFields(MetaObject entity, MetaRoot root, ColumnNamingStrategy strategy)
    {
        var list = new List<VoField>();
        foreach (var f in entity.Fields())
        {
            if (f.SubType != FIELD_SUBTYPE_OBJECT || f.ObjectRef is not { } oref) continue;
            if (f.IsDerived()) continue;   // #214 — derived VO fields are view-only, not writable
            var target = root.FindObject(CSharpNaming.StripPkg(oref));
            if (target is null || !target.IsValue()) continue;   // value objects only (jsonb-stored)
            var voType = CSharpNaming.Pascal(target.Name);
            var isArray = f.ResolvedIsArray();                    // ADR-0039: resolving array-ness
            list.Add(new VoField(
                WireName: f.Name,
                Nav: CSharpNaming.Pascal(f.Name),
                DeserType: isArray ? $"System.Collections.Generic.List<{voType}>" : voType,
                JsonColumn: CSharpNaming.Column(f, strategy),
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
    private static void AppendCreateHandler(
        StringBuilder sb, string mapPath, string cls, string dbSet,
        IReadOnlyList<string> requiredKeys, string createdExpr, IReadOnlyList<VoField> voFields,
        IReadOnlyList<AutoSetField> autoSetFields,
        (string ReadDbSet, string PkProp, string Route)? reRead = null)
    {
        if (requiredKeys.Count == 0)
        {
            sb.AppendLine($"        app.MapPost(prefix + \"{mapPath}\", async ({cls} input, AppDbContext db) =>");
            sb.AppendLine("        {");
            AppendCreateValidation(sb);
            AppendCreateVoValidation(sb, voFields);
            AppendCreateAutoSet(sb, autoSetFields);
            AppendCreatePersist(sb, dbSet, createdExpr, reRead);
            sb.AppendLine("        });");
            return;
        }

        sb.AppendLine($"        app.MapPost(prefix + \"{mapPath}\", async (HttpContext http, AppDbContext db) =>");
        sb.AppendLine("        {");
        AppendJsonOptsLocal(sb);
        sb.AppendLine("            using var __body = await System.Text.Json.JsonDocument.ParseAsync(http.Request.Body);");
        sb.AppendLine("            if (__body.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object)");
        sb.AppendLine("                return Results.BadRequest(new { error = \"validation\" });");
        // FR-036 #4 — @required-key presence: an omitted key OR an explicit null on a @required
        // field → 400, matching the JVM/Python "missing @required → 400" contract. Case-insensitive
        // so a camelCase wire key ("createdAt") matches its PascalCase property ("CreatedAt").
        sb.AppendLine("            var __present = new System.Collections.Generic.HashSet<string>(System.StringComparer.OrdinalIgnoreCase);");
        sb.AppendLine("            foreach (var __p in __body.RootElement.EnumerateObject())");
        sb.AppendLine("                if (__p.Value.ValueKind != System.Text.Json.JsonValueKind.Null) __present.Add(__p.Name);");
        sb.Append("            foreach (var __req in new[] { ");
        sb.Append(string.Join(", ", requiredKeys.Select(k => "\"" + k + "\"")));
        sb.AppendLine(" })");
        sb.AppendLine("                if (!__present.Contains(__req)) return Results.BadRequest(new { error = \"validation\" });");
        // A malformed body (e.g. a JSON array for a single-VO / scalar for an object column)
        // throws JsonException — return the cross-port 400 {error:"validation"} rather than an
        // unhandled 500 (matches the no-required-keys path's automatic model-binding 400, and
        // every other port). Program D — the VO columns make wrong-shaped bodies reachable.
        sb.AppendLine($"            {cls} input;");
        sb.AppendLine("            try { input = System.Text.Json.JsonSerializer.Deserialize<" + cls + ">(__body.RootElement.GetRawText(), jsonOpts); }");
        sb.AppendLine("            catch (System.Text.Json.JsonException) { return Results.BadRequest(new { error = \"validation\" }); }");
        sb.AppendLine("            if (input is null) return Results.BadRequest(new { error = \"validation\" });");
        AppendCreateValidation(sb);
        AppendCreateVoValidation(sb, voFields);
        AppendCreateAutoSet(sb, autoSetFields);
        AppendCreatePersist(sb, dbSet, createdExpr, reRead);
        sb.AppendLine("        });");
    }

    // The persist tail of a generated POST handler: add the bound `input` to the WRITE
    // DbSet, save, and return. For a plain entity that returns the bound row via
    // <paramref name="createdExpr"/>. For a write-through entity (#214) <paramref name="reRead"/>
    // is set: the row is read back THROUGH the replica view by PK so the returned body
    // carries the derived (view-computed) fields. Assumes `input` + `db` are in scope.
    private static void AppendCreatePersist(
        StringBuilder sb, string dbSet, string createdExpr,
        (string ReadDbSet, string PkProp, string Route)? reRead)
    {
        sb.AppendLine($"            db.{dbSet}.Add(input);");
        sb.AppendLine("            await db.SaveChangesAsync();");
        if (reRead is { } rr)
        {
            sb.AppendLine($"            var __created = await db.{rr.ReadDbSet}.FindAsync(input.{rr.PkProp});");
            // #214 [2] — a @kind:materializedView (unrefreshed) or filtered replica view may not
            // surface the just-inserted row; fall back to the bound write `input` so the 201 body
            // is never null (degraded — missing only the derived fields; matches the Python port).
            sb.AppendLine($"            return Results.Created(prefix + \"/{rr.Route}/\" + input.{rr.PkProp}, (object?)__created ?? input);");
        }
        else
        {
            sb.AppendLine($"            return {createdExpr};");
        }
    }

    // Issue #203 — stamp EVERY @autoSet column (onCreate AND onUpdate) with now() on
    // insert, overriding whatever the client sent (the model's value is ignored, so a
    // fresh row's updated-at equals its created-at). Emits nothing when the entity has no
    // @autoSet field. Assumes the bound local `input` is in scope.
    private static void AppendCreateAutoSet(StringBuilder sb, IReadOnlyList<AutoSetField> autoSetFields)
    {
        foreach (var a in autoSetFields)
            sb.AppendLine($"            input.{a.Nav} = {a.NowExpr};");
    }

    // Issue #203 — stamp each onUpdate @autoSet column with now() on update, BEFORE the
    // caller's partial merge (so a partial PATCH still bumps updated-at). onCreate columns
    // are NOT stamped — they are never rewritten (the write-once created-at contract). The
    // merge loop skips every @autoSet column, so this assignment is authoritative. Assumes
    // the tracked entity local `existing` is in scope.
    private static void AppendUpdateAutoSet(StringBuilder sb, IReadOnlyList<AutoSetField> autoSetFields)
    {
        foreach (var a in autoSetFields)
            if (a.OnUpdate)
                sb.AppendLine($"            existing.{a.Nav} = {a.NowExpr};");
    }

    // Issue #203 — the InsertPreserving escape hatch for one entity: a public static helper
    // that persists `input` WITHOUT @autoSet stamping (the onCreate/onUpdate columns are
    // written verbatim), for import / restore / replication paths that must keep the
    // original timestamps. Emitted only for an entity that declares @autoSet fields (else
    // there is nothing to preserve — the normal POST already writes every column verbatim).
    private static void AppendInsertPreserving(StringBuilder sb, string cls, string dbSet)
    {
        sb.AppendLine();
        sb.AppendLine("    /// <summary>Escape hatch: insert without @autoSet stamping (created-at/updated-at");
        sb.AppendLine("    /// written verbatim from <paramref name=\"input\"/>) for import / restore / replication.</summary>");
        sb.AppendLine($"    public static async System.Threading.Tasks.Task<{cls}> InsertPreserving(AppDbContext db, {cls} input)");
        sb.AppendLine("    {");
        sb.AppendLine($"        db.{dbSet}.Add(input);");
        sb.AppendLine("        await db.SaveChangesAsync();");
        sb.AppendLine("        return input;");
        sb.AppendLine("    }");
    }

    // Program D — post-save raw NULL for each nullable array-of-VO column a request cleared
    // to present-null. EF Core 8 OwnsMany(...).ToJson persists a null collection nav as `[]`
    // (never SQL NULL), so the merge loop sets the CLR nav to null (for the returned row) AND
    // flags the column; here we run a targeted UPDATE to actually NULL the jsonb column AFTER
    // SaveChanges (the fixed table/column names are codegen constants; the PK value is
    // parameterized). Emits nothing when the entity has no nullable array-of-VO column.
    private static void AppendArrayNullClears(
        StringBuilder sb, IReadOnlyList<VoField> voFields, string table, string pkColumn)
    {
        for (int i = 0; i < voFields.Count; i++)
        {
            var vf = voFields[i];
            if (!vf.IsArray || vf.Required) continue;
            sb.AppendLine(
                $"            if (__clearVo{i}) await db.Database.ExecuteSqlRawAsync(" +
                $"\"UPDATE \\\"{table}\\\" SET \\\"{vf.JsonColumn}\\\" = NULL WHERE \\\"{pkColumn}\\\" = {{0}}\", id);");
        }
    }

    // Program D — validate each present value-object column on CREATE. The top-level
    // TryValidateObject (AppendCreateValidation) does NOT recurse into an owned-nav VO, so a
    // nested-constraint violation (e.g. a VO string member over @maxLength) would slip through.
    // ValueObjectValidator.Validate runs the VO's own DataAnnotations per element + recurses
    // into nested VO members; a null nav is vacuously valid (a missing required VO column is
    // already caught by the @required-key presence check). Assumes `input` is in scope.
    private static void AppendCreateVoValidation(StringBuilder sb, IReadOnlyList<VoField> voFields)
    {
        foreach (var vf in voFields)
            sb.AppendLine(
                $"            if (!ValueObjectValidator.Validate(input.{vf.Nav})) return Results.BadRequest(new {{ error = \"validation\" }});");
    }

    // The configured System.Text.Json options local (`jsonOpts`) — the app's
    // ConfigureHttpJsonOptions serializer options, NOT defaults, so a custom converter (e.g.
    // the field.timestamp DateTimeOffset converter) is honored; default options 500 on it.
    // Assumes `HttpContext http` is in scope.
    private static void AppendJsonOptsLocal(StringBuilder sb)
    {
        sb.AppendLine("            var jsonOpts = ((Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>)");
        sb.AppendLine("                http.RequestServices.GetService(typeof(Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>))!)");
        sb.AppendLine("                .Value.SerializerOptions;");
    }

    // FR-036 A2 — the shared create-validation preamble for a generated POST handler
    // (vanilla entity + each TPH per-subtype create). Runs the model's DataAnnotations
    // (the emitted [Required]/[MaxLength]/[MinLength]/[Range]/[RegularExpression]) over the
    // bound `input` and rejects a violating body with the cross-port {error:"validation"}
    // envelope BEFORE the row is persisted (ASP.NET minimal-API model binding never runs
    // DataAnnotations on its own). Assumes the bound local `input` is in scope.
    private static void AppendCreateValidation(StringBuilder sb)
    {
        sb.AppendLine("            var __vr = new System.Collections.Generic.List<System.ComponentModel.DataAnnotations.ValidationResult>();");
        sb.AppendLine("            if (!System.ComponentModel.DataAnnotations.Validator.TryValidateObject(");
        sb.AppendLine("                    input, new System.ComponentModel.DataAnnotations.ValidationContext(input), __vr, true))");
        sb.AppendLine("                return Results.BadRequest(new { error = \"validation\" });");
    }

    // FR-035 PATCH-2 — the shared present-key merge loop for the generated update
    // handler (vanilla entity + each TPH subtype). Enumerates the JSON body and writes
    // ONLY the present keys: an explicit null CLEARS a nullable column, an explicit null
    // on a NOT-NULL (@required) column is a 400 {error:"validation"}, and the PK — plus
    // the TPH discriminator when `discProp` is non-null — is never written. Assumes the
    // locals `body` (JsonDocument), `existing` (the entity instance), `entry` (EntityEntry)
    // and `jsonOpts` are in scope.
    private static void AppendPartialMergeLoop(
        StringBuilder sb, string? discProp, IReadOnlyList<VoField> voFields,
        IReadOnlyList<string> autoSetNavs, IReadOnlyList<string> frozenNavs)
    {
        // A nullable array-of-VO column that a request clears to null (present-null) can NOT be
        // NULLed by an owned-nav assignment — EF OwnsMany(...).ToJson writes `[]` for a null
        // collection nav, not SQL NULL. Track it via a flag + a post-save raw UPDATE
        // (AppendArrayNullClears). Declared before the loop so the post-save clears see it.
        for (int i = 0; i < voFields.Count; i++)
            if (voFields[i].IsArray && !voFields[i].Required)
                sb.AppendLine($"            var __clearVo{i} = false;");

        sb.AppendLine("            foreach (var prop in body.RootElement.EnumerateObject())");
        sb.AppendLine("            {");
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
            sb.AppendLine($"                if (string.Equals(prop.Name, \"{vf.WireName}\", System.StringComparison.OrdinalIgnoreCase))");
            sb.AppendLine("                {");
            sb.AppendLine("                    if (prop.Value.ValueKind == System.Text.Json.JsonValueKind.Null)");
            sb.AppendLine("                    {");
            if (vf.Required)
                sb.AppendLine("                        return Results.BadRequest(new { error = \"validation\" }); // @required VO column: present-null is a 400");
            else
            {
                sb.AppendLine($"                        existing.{vf.Nav} = null;");
                if (vf.IsArray)
                    sb.AppendLine($"                        __clearVo{i} = true; // NULL the jsonb column post-save (EF writes [] for a null OwnsMany nav)");
                sb.AppendLine("                        continue;");
            }
            sb.AppendLine("                    }");
            // A wrong-shaped VO value (e.g. a JSON array for a single-VO column, an object for an
            // array column) throws JsonException — return the cross-port 400 rather than an
            // unhandled 500 (matches every other port + this port's own reference lane).
            sb.AppendLine($"                    {vf.DeserType} {v};");
            sb.AppendLine($"                    try {{ {v} = System.Text.Json.JsonSerializer.Deserialize<{vf.DeserType}>(prop.Value.GetRawText(), jsonOpts); }}");
            sb.AppendLine("                    catch (System.Text.Json.JsonException) { return Results.BadRequest(new { error = \"validation\" }); }");
            sb.AppendLine($"                    if (!ValueObjectValidator.Validate({v})) return Results.BadRequest(new {{ error = \"validation\" }});");
            sb.AppendLine($"                    existing.{vf.Nav} = {v}{(vf.Required ? "!" : "")};");
            sb.AppendLine("                    continue;");
            sb.AppendLine("                }");
        }
        sb.AppendLine("                var target = entry.Metadata.FindProperty(prop.Name)");
        sb.AppendLine("                    ?? entry.Metadata.GetProperties().FirstOrDefault(p => string.Equals(p.Name, prop.Name, System.StringComparison.OrdinalIgnoreCase));");
        sb.AppendLine("                if (target is null) continue;");
        sb.AppendLine("                if (target.IsPrimaryKey()) continue;                        // PK is route-authoritative");
        if (discProp is not null)
        {
            sb.AppendLine($"                if (string.Equals(target.Name, \"{discProp}\", System.StringComparison.Ordinal)) continue; // discriminator is immutable");
        }
        // Issue #203 — @autoSet columns are server-owned: an onUpdate column is stamped to
        // now() (below), an onCreate column is never rewritten. Either way the caller can
        // never set them via the PATCH/PUT body, so skip any present key.
        foreach (var nav in autoSetNavs)
            sb.AppendLine($"                if (string.Equals(target.Name, \"{nav}\", System.StringComparison.Ordinal)) continue; // @autoSet: server-owned");
        // FR-037 R1 — @mutability readOnly / writeOnce are not PATCH-settable. STRIPPED,
        // never 400'd: the uniform behaviour of every excluded key on this path. Skipping
        // BEFORE the null branch also covers the FR-035 present-null arm, since clearing a
        // column is itself a write.
        foreach (var nav in frozenNavs)
            sb.AppendLine($"                if (string.Equals(target.Name, \"{nav}\", System.StringComparison.Ordinal)) continue; // @mutability: not patch-settable");
        sb.AppendLine("                if (prop.Value.ValueKind == System.Text.Json.JsonValueKind.Null)");
        sb.AppendLine("                {");
        sb.AppendLine("                    // FR-035 PATCH-2: explicit null clears a nullable column; on a");
        sb.AppendLine("                    // NOT-NULL (@required) column it is a 400 (matching the cross-port contract).");
        sb.AppendLine("                    if (!target.IsNullable) return Results.BadRequest(new { error = \"validation\" });");
        sb.AppendLine("                    entry.CurrentValues[target] = null;");
        sb.AppendLine("                    continue;");
        sb.AppendLine("                }");
        sb.AppendLine("                var clr = System.Nullable.GetUnderlyingType(target.ClrType) ?? target.ClrType;");
        sb.AppendLine("                var __val = System.Text.Json.JsonSerializer.Deserialize(prop.Value.GetRawText(), clr, jsonOpts);");
        sb.AppendLine("                // FR-036 A2 — validate the PRESENT, non-null value with the same per-field");
        sb.AppendLine("                // DataAnnotations as create. This validates ONLY the present value (never the");
        sb.AppendLine("                // whole row) so an ABSENT @required field is untouched, not a 400.");
        sb.AppendLine("                var __pr = new System.Collections.Generic.List<System.ComponentModel.DataAnnotations.ValidationResult>();");
        sb.AppendLine("                if (!System.ComponentModel.DataAnnotations.Validator.TryValidateProperty(__val,");
        sb.AppendLine("                        new System.ComponentModel.DataAnnotations.ValidationContext(existing) { MemberName = target.Name }, __pr))");
        sb.AppendLine("                    return Results.BadRequest(new { error = \"validation\" });");
        sb.AppendLine("                entry.CurrentValues[target] = __val;");
        sb.AppendLine("            }");
    }

    // Emit the per-subtype CRUD route set under /<base>/<segment>. Scoped to the subtype
    // via db.<DbSet>.OfType<Sub>(); cross-subtype ids are invisible (404). Create binds the
    // subtype CLR type (discriminator injected by EF on Add); update is a partial merge
    // that never touches the PK or the discriminator.
    private static void AppendTphSubtypeRoutes(
        StringBuilder sb, TphSubtypePlan st, string baseRoute, string baseCls, string dbSet,
        string pkType, string pkProp, string discProp)
    {
        var subCls = CSharpNaming.Pascal(st.Entity.Name);
        var seg = st.RouteSegment;
        var subRoute = baseRoute + "/" + seg;

        // Issue #203 — @autoSet columns on the subtype's EFFECTIVE fields (a shared
        // BaseEntity.createdAt/updatedAt is inherited by every subtype). Stamped on
        // create/update and skipped in the merge, exactly like a vanilla entity.
        var autoSetFields = AutoSetFields(st.Entity);
        var autoSetNavs = autoSetFields.Select(a => a.Nav).ToList();
        // FR-037 R1 — readOnly / writeOnce on the SUBTYPE's effective fields (a shared
        // base's mode is inherited by every subtype), excluded from the PATCH merge.
        var frozenNavs = FrozenNavs(st.Entity);

        // Per-subtype list: GET /<base>/<seg>
        sb.AppendLine();
        sb.AppendLine("        app.MapGet(prefix + \"/" + subRoute + "\", async (HttpContext http, AppDbContext db) =>");
        sb.AppendLine("        {");
        sb.AppendLine("            var qs = http.Request.Query;");
        sb.AppendLine($"            IQueryable<{subCls}> q = db.{dbSet}.OfType<{subCls}>().AsNoTracking();");
        sb.AppendLine($"            var filter = FilterParser.Parse(qs, {subCls}FilterAllowlist.Fields, {subCls}FilterAllowlist.OpsByField);");
        sb.AppendLine("            if (filter.ErrorEnvelope is not null) return Results.BadRequest(new { error = filter.ErrorEnvelope });");
        sb.AppendLine("            q = EfCoreFilterDispatch.ApplyFilter(q, filter.Predicates);");
        sb.AppendLine("            if (qs.TryGetValue(\"sort\", out var sortRaw) && !string.IsNullOrWhiteSpace(sortRaw))");
        sb.AppendLine("            {");
        sb.AppendLine("                var parts = sortRaw.ToString().Split(':', 2);");
        sb.AppendLine("                var desc = parts.Length > 1 && string.Equals(parts[1], \"desc\", System.StringComparison.OrdinalIgnoreCase);");
        sb.AppendLine($"                if (!{subCls}SortAllowlist.TryGetValue(parts[0], out var resolved)) return Results.BadRequest(new {{ error = \"invalid_sort\" }});");
        sb.AppendLine("                q = desc ? q.OrderByDescending(x => EF.Property<object>(x!, resolved)) : q.OrderBy(x => EF.Property<object>(x!, resolved));");
        sb.AppendLine("            }");
        sb.AppendLine("            if (qs.TryGetValue(\"offset\", out var offRaw) && int.TryParse(offRaw, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var off) && off > 0) q = q.Skip(off);");
        sb.AppendLine("            if (qs.TryGetValue(\"limit\", out var limRaw) && int.TryParse(limRaw, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var lim) && lim > 0) q = q.Take(lim);");
        sb.AppendLine("            var rows = await q.ToListAsync();");
        sb.AppendLine("            var withCount = qs.TryGetValue(\"withCount\", out var wc) && (wc == \"1\" || string.Equals(wc, \"true\", System.StringComparison.OrdinalIgnoreCase));");
        sb.AppendLine("            if (!withCount) return Results.Ok(rows);");
        sb.AppendLine($"            var total = await EfCoreFilterDispatch.ApplyFilter(db.{dbSet}.OfType<{subCls}>().AsNoTracking(), filter.Predicates).CountAsync();");
        sb.AppendLine("            return Results.Ok(new { rows, total });");
        sb.AppendLine("        });");

        // Per-subtype get: GET /<base>/<seg>/{id} — scoped (cross-subtype → 404).
        sb.AppendLine();
        sb.AppendLine("        app.MapGet(prefix + \"/" + subRoute + "/{id}\", async (" + pkType + " id, AppDbContext db) =>");
        sb.AppendLine($"            await db.{dbSet}.OfType<{subCls}>().AsNoTracking().FirstOrDefaultAsync(x => x.{pkProp} == id) is {{ }} found");
        sb.AppendLine("                ? Results.Ok(found)");
        sb.AppendLine("                : Results.NotFound(new { error = \"not_found\" }));");

        // Per-subtype create: POST /<base>/<seg> — discriminator injected by EF via the
        // subtype CLR type; the POST body OMITS the discriminator. FR-036 #4: the @required-key
        // presence set spans the subtype's EFFECTIVE fields (base + own) minus the PK and the
        // (EF-injected) discriminator, so an omitted @required value-type field → 400.
        var requiredKeys = RequiredCreateKeys(st.Entity, f =>
        {
            var p = CSharpNaming.Pascal(f.Name);
            return string.Equals(p, pkProp, System.StringComparison.Ordinal)
                   || string.Equals(p, discProp, System.StringComparison.Ordinal);
        });
        sb.AppendLine();
        // VO columns on a TPH subtype are out of scope (Program D §6) — no typed arms.
        AppendCreateHandler(sb, "/" + subRoute, subCls, dbSet, requiredKeys,
            "Results.Created(prefix + \"/" + subRoute + "/\" + input." + pkProp + ", input)", [], autoSetFields);

        // Per-subtype update (PATCH + PUT): partial merge of the JSON body onto the scoped
        // entity, NEVER touching the PK or the discriminator. Cross-subtype id → 404.
        sb.AppendLine();
        sb.AppendLine("        async System.Threading.Tasks.Task<IResult> Update" + subCls + "(" + pkType + " id, HttpContext http, AppDbContext db)");
        sb.AppendLine("        {");
        sb.AppendLine($"            var existing = await db.{dbSet}.OfType<{subCls}>().FirstOrDefaultAsync(x => x.{pkProp} == id);");
        sb.AppendLine("            if (existing is null) return Results.NotFound(new { error = \"not_found\" });");
        sb.AppendLine("            var body = await System.Text.Json.JsonDocument.ParseAsync(http.Request.Body);");
        sb.AppendLine("            // Configured JSON options (not defaults) so a custom converter — e.g. the");
        sb.AppendLine("            // field.timestamp DateTimeOffset converter — is honored; defaults throw 500 on it.");
        sb.AppendLine("            var jsonOpts = ((Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>)");
        sb.AppendLine("                http.RequestServices.GetService(typeof(Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>))!)");
        sb.AppendLine("                .Value.SerializerOptions;");
        sb.AppendLine("            var entry = db.Entry(existing);");
        AppendUpdateAutoSet(sb, autoSetFields);
        // ADR-0045 + the 0.19.4 lesson: TPH is a SEPARATE code path per port, so the
        // per-subtype merge states the same exclusion rather than inheriting it.
        AppendPartialMergeLoop(sb, discProp, [], autoSetNavs, frozenNavs);
        sb.AppendLine("            await db.SaveChangesAsync();");
        sb.AppendLine("            return Results.Ok(existing);");
        sb.AppendLine("        }");
        sb.AppendLine("        app.MapPatch(prefix + \"/" + subRoute + "/{id}\", Update" + subCls + ");");
        sb.AppendLine("        app.MapPut(prefix + \"/" + subRoute + "/{id}\", Update" + subCls + ");");

        // Per-subtype delete: DELETE /<base>/<seg>/{id} — scoped (cross-subtype → 404).
        sb.AppendLine();
        sb.AppendLine("        app.MapDelete(prefix + \"/" + subRoute + "/{id}\", async (" + pkType + " id, AppDbContext db) =>");
        sb.AppendLine("        {");
        sb.AppendLine($"            var existing = await db.{dbSet}.OfType<{subCls}>().FirstOrDefaultAsync(x => x.{pkProp} == id);");
        sb.AppendLine("            if (existing is null) return Results.NotFound(new { error = \"not_found\" });");
        sb.AppendLine($"            db.{dbSet}.Remove(existing);");
        sb.AppendLine("            await db.SaveChangesAsync();");
        sb.AppendLine("            return Results.NoContent();");
        sb.AppendLine("        });");
    }

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
    private static void AppendM2mRoute(
        System.Text.StringBuilder sb, M2MNavigation nav, string sourceRoute, string pkType)
    {
        var relSeg = nav.Name;                                    // relationship name segment
        var targetCls = CSharpNaming.Pascal(nav.Target.Name);
        var targetDbSet = CSharpNaming.Pluralize(targetCls);
        var junctionDbSet = CSharpNaming.Pluralize(CSharpNaming.Pascal(nav.Junction.Name));
        var srcFkProp = CSharpNaming.Pascal(nav.SourceField);
        var tgtFkProp = CSharpNaming.Pascal(nav.TargetField);

        // The junction FK CLR type (the related-id key type) + the target PK property.
        var fkType = JunctionFkType(nav);
        var targetPk = nav.Target.PrimaryIdentity()?.Fields is { Count: 1 } tf
            ? CSharpNaming.Pascal(tf[0]) : "Id";

        sb.AppendLine();
        sb.AppendLine("        app.MapGet(prefix + \"/" + sourceRoute + "/{id}/" + relSeg + "\", async (" + pkType + " id, AppDbContext db) =>");
        sb.AppendLine("        {");
        if (nav.Symmetric)
        {
            // Union both junction columns; the related id is the column that is NOT the source id.
            sb.AppendLine($"            var pairs = await db.{junctionDbSet}.AsNoTracking()");
            sb.AppendLine($"                .Where(j => EF.Property<{fkType}>(j, \"{srcFkProp}\").Equals(id) || EF.Property<{fkType}>(j, \"{tgtFkProp}\").Equals(id))");
            sb.AppendLine($"                .Select(j => new {{ S = EF.Property<{fkType}>(j, \"{srcFkProp}\"), T = EF.Property<{fkType}>(j, \"{tgtFkProp}\") }})");
            sb.AppendLine("                .ToListAsync();");
            sb.AppendLine($"            var relatedIds = new System.Collections.Generic.HashSet<{fkType}>();");
            sb.AppendLine("            foreach (var p in pairs)");
            sb.AppendLine("                relatedIds.Add(p.S.Equals(id) ? p.T : p.S);");
        }
        else
        {
            sb.AppendLine($"            var relatedIds = (await db.{junctionDbSet}.AsNoTracking()");
            sb.AppendLine($"                .Where(j => EF.Property<{fkType}>(j, \"{srcFkProp}\").Equals(id))");
            sb.AppendLine($"                .Select(j => EF.Property<{fkType}>(j, \"{tgtFkProp}\"))");
            sb.AppendLine("                .ToListAsync()).ToHashSet();");
        }
        sb.AppendLine($"            if (relatedIds.Count == 0) return Results.Ok(new System.Collections.Generic.List<{targetCls}>());");
        sb.AppendLine($"            var rows = await db.{targetDbSet}.AsNoTracking()");
        sb.AppendLine($"                .Where(t => relatedIds.Contains(EF.Property<{fkType}>(t, \"{targetPk}\")))");
        sb.AppendLine("                .ToListAsync();");
        sb.AppendLine("            return Results.Ok(rows);");
        sb.AppendLine("        });");
    }

    // The CLR type of the junction FK columns (and thus the related-id key). Both
    // junction references point at same-typed PKs; use the source FK field's subtype.
    private static string JunctionFkType(M2MNavigation nav)
    {
        var fkField = nav.Junction.FindField(nav.SourceField);
        return fkField is not null ? CSharpNaming.ScalarFor(fkField.SubType) ?? "long" : "long";
    }
}
