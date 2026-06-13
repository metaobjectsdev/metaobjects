// Builds the C# SDK api-surface IR (CSharpApiModel) from a loaded MetaRoot.
//
// This is the ACCURATE-BY-CONSTRUCTION half of the api-docs pipeline: every
// documented symbol name comes from the CSharpNaming seam (never re-concatenated
// here), and every inclusion decision comes from the corresponding generator's
// static AppliesTo(...) predicate (never re-implemented here). The result is that
// what this builder documents == what the generators emit, by SHARING the single
// source of truth rather than mirroring it.
//
// Per-category enumeration (mirrors the Java JavaApiModelBuilder, C#/EF-flavored):
//   • Objects (root.Objects()): each concrete object → a MODEL symbol. Entities add
//     DATA_ACCESS / REST / VALIDATION / FILTER, each gated by the matching generator's
//     AppliesTo. A value object → MODEL only.
//   • Templates (root.RootTemplates()): each template.output → PAYLOAD / RENDER /
//     PROMPT / OUTPUT_PARSER, gated by the matching generator's AppliesTo.
//
// Abstract objects yield NO symbols (cannot be instantiated; every entity generator's
// AppliesTo skips abstracts via EmitsInstanceArtifacts) → no unit at all (never empty).
// TPH subtypes are model-only (the routes/dbcontext generators suppress them), so they
// document MODEL only.

using MetaObjects.Codegen.Generators;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen.ApiDocs;

/// <summary>Builds the <see cref="CSharpApiModel"/> SDK-surface IR from a loaded <see cref="MetaRoot"/>.</summary>
public sealed class CSharpApiModelBuilder
{
    private readonly GenConfig _config;

    /// <param name="config">
    /// The codegen config (namespace + binding) used ONLY to resolve a symbol's display
    /// namespace via the same <see cref="PackageBindingResolver"/> the generators use.
    /// </param>
    public CSharpApiModelBuilder(GenConfig config) => _config = config;

    /// <summary>Build the SDK-surface model for <paramref name="project"/> from <paramref name="root"/>.</summary>
    public CSharpApiModel Build(MetaRoot root, string project)
    {
        var units = new List<ApiUnit>();

        // Objects: one unit per concrete object.entity / object.value.
        foreach (var obj in root.Objects())
        {
            var unit = BuildObjectUnit(obj, root);
            if (unit is not null) units.Add(unit);
        }

        // Templates: one unit per template.* node under the model root.
        foreach (var tmpl in root.RootTemplates())
            units.Add(BuildTemplateUnit(tmpl, root));

        return new CSharpApiModel(project, units);
    }

    // ----- objects -----------------------------------------------------------

    private ApiUnit? BuildObjectUnit(MetaObject obj, MetaRoot root)
    {
        var entity = obj.IsEntity();
        var ns = ResolveNamespace(obj);
        var unitKind = entity ? "entity" : "value";

        var symbols = new List<ApiSymbol>();

        // MODEL — only for concrete objects. An abstract object cannot be instantiated,
        // so we document no MODEL for it (documented ⊆ generated). A concrete value
        // object → MODEL only. A TPH subtype is model-only (routes/dbcontext suppress it).
        if (!InstanceArtifacts.IsAbstract(obj))
        {
            var model = CSharpNaming.ModelClassName(obj);
            symbols.Add(new ApiSymbol(
                model, ApiSymbolKind.Model, ns,
                $"class {model}",
                entity ? "the EF Core entity / in-memory model object" : "the value-object POCO"));
        }

        if (entity)
        {
            // DATA_ACCESS — the DbSet on the generated AppDbContext (entity persisted).
            if (DbContextGenerator.AppliesTo(obj, root))
            {
                var dbSet = CSharpNaming.DbSetName(obj);
                symbols.Add(new ApiSymbol(
                    dbSet, ApiSymbolKind.DataAccess, ns,
                    $"DbSet<{CSharpNaming.ModelClassName(obj)}> AppDbContext.{dbSet}",
                    "data access — the EF Core DbSet on the generated AppDbContext",
                    $"DbSet<{CSharpNaming.ModelClassName(obj)}>"));
            }

            // VALIDATION — the DataAnnotations constraints carried on the entity class
            // (required / max-length / range / regex). The validation symbol names the
            // entity class (the constraints live on its mapped properties).
            if (DbContextGenerator.AppliesTo(obj, root))
            {
                var cls = CSharpNaming.ModelClassName(obj);
                symbols.Add(new ApiSymbol(
                    cls, ApiSymbolKind.Validation, ns,
                    $"class {cls}",
                    "DataAnnotations validation on the create/update shape",
                    Fields: DtoFields(obj)));
            }

            // REST — one symbol per verb+path the routes generator registers.
            if (RoutesGenerator.AppliesTo(obj, root))
                AddRestSymbols(symbols, obj, ns, root);

            // FILTER — the per-entity sort/filter allowlist.
            if (FilterAllowlistGenerator.AppliesTo(obj))
            {
                var filter = CSharpNaming.FilterAllowlistName(obj);
                symbols.Add(new ApiSymbol(
                    filter, ApiSymbolKind.Filter, ns,
                    $"static class {filter}",
                    "the filterable-field + filter-operator allowlist"));
            }
        }

        // No symbols (e.g. an abstract object) → no unit at all (never an empty unit).
        if (symbols.Count == 0) return null;
        return new ApiUnit(CSharpNaming.ModelClassName(obj), PackageOf(obj), unitKind, symbols);
    }

    private void AddRestSymbols(List<ApiSymbol> symbols, MetaObject entity, string ns, MetaRoot root)
    {
        var routesClass = CSharpNaming.RoutesClassName(entity);
        var basePath = "/api/" + CSharpNaming.RoutePath(entity);
        var pk = entity.PrimaryIdentity()?.Fields ?? [];
        var hasItem = pk.Count == 1;
        var writable = hasItem && !entity.IsReadOnlyProjection();

        AddRest(symbols, routesClass, ns, "GET " + basePath, "list with pagination / sort / filters");
        if (hasItem) AddRest(symbols, routesClass, ns, "GET " + basePath + "/{id}", "fetch one by id");
        if (writable)
        {
            AddRest(symbols, routesClass, ns, "POST " + basePath, "create");
            AddRest(symbols, routesClass, ns, "PATCH " + basePath + "/{id}", "update");
            AddRest(symbols, routesClass, ns, "PUT " + basePath + "/{id}", "update (PUT alias)");
            AddRest(symbols, routesClass, ns, "DELETE " + basePath + "/{id}", "delete");
        }
        // M:N traversal — GET /<source-plural>/{id}/<relation>, only on a single-PK source.
        if (hasItem)
            foreach (var nav in M2MNavigationBuilder.For(entity, root))
                AddRest(symbols, routesClass, ns,
                    "GET " + basePath + "/{id}/" + nav.Name,
                    "M:N traversal — the related " + CSharpNaming.ModelClassName(nav.Target) + " rows");
    }

    private static void AddRest(List<ApiSymbol> symbols, string routesClass, string ns, string verbPath, string usage) =>
        symbols.Add(new ApiSymbol(verbPath, ApiSymbolKind.Rest, ns, verbPath, usage));

    // ----- templates ---------------------------------------------------------

    private ApiUnit BuildTemplateUnit(MetaData tmpl, MetaRoot root)
    {
        var ns = ResolveTemplateNamespace(tmpl);
        var name = tmpl.Name;
        var symbols = new List<ApiSymbol>();

        if (RenderHelperGenerator.AppliesTo(tmpl, root))
        {
            var render = CSharpNaming.RenderHelperName(name);
            var returns = IsEmailKind(tmpl) ? "EmailDocument" : "string";
            symbols.Add(new ApiSymbol(
                render, ApiSymbolKind.Render, ns,
                $"static class {render}",
                "renders the output template against a typed payload",
                returns));
        }
        if (OutputPromptGenerator.AppliesTo(tmpl, root))
        {
            var prompt = CSharpNaming.PromptClassName(name);
            symbols.Add(new ApiSymbol(
                prompt, ApiSymbolKind.Prompt, ns,
                $"static class {prompt}",
                "builds the output-format prompt fragment"));
        }
        if (OutputParserGenerator.AppliesTo(tmpl))
        {
            var parser = CSharpNaming.ParserClassName(name);
            symbols.Add(new ApiSymbol(
                parser, ApiSymbolKind.OutputParser, ns,
                $"static class {parser}",
                "parses model output back into the typed payload"));

            // PAYLOAD — the typed payload record the parser produces (referenced by the
            // parser/prompt). Documented only when the @payloadRef resolves to a VO whose
            // record the parser materializes (the parser names the record == payloadRef).
            if (tmpl.OwnAttr(TEMPLATE_ATTR_PAYLOAD_REF) is string payloadRef)
            {
                var vo = root.OwnChildren().FirstOrDefault(c => c.Type == TYPE_OBJECT && c.Name == payloadRef);
                if (vo is not null)
                    symbols.Add(new ApiSymbol(
                        payloadRef, ApiSymbolKind.Payload, ns,
                        $"record {payloadRef}",
                        "the typed payload projection bound to the template",
                        Fields: PayloadFields(vo)));
            }
        }

        return new ApiUnit(name, PackageOf(tmpl), "template", symbols);
    }

    /// <summary>True when the template's <c>@kind</c> (own attr, default document) is <c>email</c>.</summary>
    private static bool IsEmailKind(MetaData tmpl) =>
        tmpl.OwnAttr(TEMPLATE_ATTR_KIND) is string v &&
        v.Equals(TEMPLATE_KIND_EMAIL, StringComparison.OrdinalIgnoreCase);

    // ----- field shapes -------------------------------------------------------

    // The entity's documented field shapes: one FieldShape per scalar/enum field the
    // entity generator maps, typed via the SAME CSharpNaming.ScalarFor / EnumTypeName the
    // generator uses, with required = @required-or-PK (CSharpNaming.IsRequired).
    private static IReadOnlyList<FieldShape> DtoFields(MetaObject entity)
    {
        var rows = new List<FieldShape>();
        foreach (var f in entity.Fields())
        {
            string type;
            string? note = null;
            if (CSharpNaming.ScalarFor(f.SubType) is { } scalar)
                type = scalar;
            else if (f.SubType == MetaObjects.Core.Field.FieldConstants.FIELD_SUBTYPE_ENUM)
            {
                type = CSharpNaming.EnumTypeName(entity, f);
                if (f.EffectiveEnumValues is { Count: > 0 } values)
                    note = "allowed: " + string.Join(" | ", values);
            }
            else
                continue; // object-typed fields are owned-type navs, not a documented scalar shape
            var required = CSharpNaming.IsRequired(entity, f);
            rows.Add(new FieldShape(f.Name, type, !required, note));
        }
        return rows;
    }

    // The payload record's documented field shapes: one row per field of the @payloadRef
    // value object. Types are kept simple (the payload record is `required <type>`); enum
    // notes carry the allowed values.
    private static IReadOnlyList<FieldShape> PayloadFields(MetaData vo)
    {
        var rows = new List<FieldShape>();
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD))
        {
            var scalar = CSharpNaming.ScalarFor(f.SubType);
            var type = scalar ?? (f.SubType == MetaObjects.Core.Field.FieldConstants.FIELD_SUBTYPE_OBJECT ? "object" : f.SubType);
            rows.Add(new FieldShape(f.Name, type, Optional: false));
        }
        return rows;
    }

    // ----- namespace / package helpers ---------------------------------------

    // The unit's metadata PACKAGE (e.g. "acme::shop") — drives the doc-page layout path,
    // matching the shared cross-port manifest. NOT the C# namespace.
    private static string PackageOf(MetaData node) =>
        PackageBindingResolver.EffectivePackage(node) ?? "";

    // The symbol's display C# namespace, resolved the SAME way the generators resolve it.
    private string ResolveNamespace(MetaObject obj) =>
        PackageBindingResolver.Resolve(_config, PackageBindingResolver.EffectivePackage(obj), obj.Name);

    // Template-emitted helpers land at the configured default namespace (the render/prompt/
    // parser generators all emit `namespace ctx.Config.Namespace`).
    private string ResolveTemplateNamespace(MetaData tmpl) => _config.Namespace;
}
