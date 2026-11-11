// callable-generator — FR-015. Emits one <Entity>.callable.g.cs per entity backed by
// a callable source.rdb (@kind: "storedProc" | "tableFunction"): a static EF Core
// calling method that runs `SELECT * FROM <schema.>proc(<args...>)` and returns the
// (read-only projection) entity rows.
//
// Two emitted forms, decided by whether the `names` generator is part of this run
// (ctx.Config.IncludeNames — ADR-0034's opt-in arm):
//   • names ON  — the procedure's name is REFERENCED (`<Entity>Names.SourcePrimaryProc`, or
//     `…Function` for a tableFunction — the member is named for the source's @kind), spliced into a
//     FromSqlRaw string with `{n}` placeholders for the arguments. It has to be raw: a
//     FromSqlInterpolated hole binds a PARAMETER, and an identifier cannot be one — the C#
//     analogue of the drizzle `sql.raw` the TS reference uses for the same reason.
//   • names OFF — the name is spelled literally inside FromSqlInterpolated, the documented
//     fallback and byte-identical to what this generator always emitted.
// Either way every ARGUMENT is a parameter, never spliced text.
//
// The call-site argument list is derived from the @parameterRef value-object's field
// children IN DECLARATION ORDER — the same order contract the TS reference uses
// (server/typescript/packages/codegen-ts/src/templates/callable-file.ts). A callable
// without @parameterRef emits a zero-argument method (no `args` parameter).
//
// Mirrors the TS callable generator's stable name ("callable") + return contract.

using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Persistence.Source.SourceConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>Generates a typed EF Core calling method per callable-source entity (FR-015).</summary>
public class CallableGenerator : PerEntityGenerator
{
    public override string Name => "callable-generator";

    /// <summary>Only entities whose primary source is a callable kind (storedProc / tableFunction).</summary>
    public override bool Filter(MetaObject entity) => CallableSource(entity) is not null;

    // The callable source = the first OWN source whose effective kind is callable. A
    // callable entity is a read-only projection (no writable table), so the source is
    // declared on the entity itself.
    private static MetaSource? CallableSource(MetaObject entity) =>
        entity.OwnSources().FirstOrDefault(s => s.IsCallable());

    protected override EmittedFile GenerateOne(MetaObject entity, GenContext ctx)
    {
        var source = CallableSource(entity)
            ?? throw new InvalidOperationException(
                $"{Name}: entity \"{entity.Name}\" has no callable source.rdb (storedProc / tableFunction).");

        var cls = CSharpNaming.Pascal(entity.Name);

        // Schema-qualified physical proc/function name (e.g. analytics.fn_phase_summary).
        var physical = source.PhysicalName;
        var schemaPrefix = string.IsNullOrEmpty(source.Schema) ? "" : $"{source.Schema}.";
        var procName = $"{schemaPrefix}{physical}";

        // §A6 — the constant members to reference for the procedure's name and schema, or
        // null for the literal arm (see the file header). The @schema half used to stay a
        // spelled literal on BOTH arms while the artifact's schema constant sat right there
        // unread, on the grounds that schema qualification was "being ruled on separately".
        // It has been: every port now qualifies, so this reads the constant like everything
        // else. The prefix expression below is therefore an EXPRESSION, not a string — on the
        // names arm it concatenates the constant, on the literal arm it is the spelled
        // schema, and both produce the same SQL.
        //
        // The ROLE is the callable source's own, never a hardcoded "primary": the source was
        // already selected by CallableSource above, and asking it which role it plays is one
        // selection rather than two that agree until they do not. Since 0.25.0 the physical
        // name lives under the alias for its @kind — SourcePrimaryProc for a storedProc,
        // SourcePrimaryFunction for a tableFunction — so the emitted member says WHAT it is.
        var strategy = ctx.Config.ColumnNamingStrategy;
        var includeNames = ctx.Config.IncludeNames;
        var procMember = CSharpNaming.SourceNameMember(entity, strategy, includeNames, source.Role, ctx.Config);
        var schemaMember = CSharpNaming.SourceSchemaMember(entity, strategy, includeNames, source.Role, ctx.Config);
        // The schema prefix as it appears INSIDE the FromSqlRaw concatenation on the names
        // arm: `" + XNames.SourcePrimarySchema + "."`. Empty when the callable declares no @schema.
        var schemaPrefixExpr = schemaMember is null
            ? schemaPrefix
            : $"\" + {schemaMember} + \".";

        // Resolve the @parameterRef value-object (same root as the entity). Its field
        // children — in declaration order — are the call-site arguments.
        var argsObjectName = source.ParameterRef;
        MetaObject? argsObject = null;
        if (argsObjectName is not null)
        {
            argsObject = global::MetaObjects.NamingRefs.RefTarget(source, SOURCE_ATTR_PARAMETER_REF) as MetaObject;
            if (argsObject is null)
                ctx.Warn(
                    $"{Name}: callable \"{entity.Name}\" @parameterRef \"{argsObjectName}\" did not resolve — " +
                    "emitting a zero-argument method.");
        }

        // ADR-0039: OwnFields is the deliberate cross-port form here (TS reads argsObject.ownChildren())
        // — the callable's SQL binds exactly the params the args value-object DECLARES, in declaration
        // order; the VO is the authored parameter list, not an extends participant. Each argument is
        // a PARAMETER on both arms: an interpolation hole under FromSqlInterpolated, a `{n}`
        // placeholder under FromSqlRaw.
        var argProps = argsObject is null
            ? []
            : argsObject.OwnFields().Select(f => CSharpNaming.Pascal(f.Name)).ToList();

        var sqlArgs = string.Join(", ", argProps.Select(p => $"{{args.{p}}}"));
        var hasArgs = argsObject is not null;
        // The names-ON call: `FromSqlRaw("SELECT * FROM <schema.>" + <Entity>Names.SourcePrimaryProc + "({0}, {1})", args.A, args.B)`.
        // The concatenation is of compile-time constants, so the SQL EF receives is one string with
        // the identifier already in place; only the `{n}` holes become DbParameters.
        var rawPlaceholders = string.Join(", ", argProps.Select((_, i) => $"{{{i}}}"));
        var rawArgs = string.Concat(argProps.Select(p => $", args.{p}"));
        var fromSql = procMember is null
            ? $"FromSqlInterpolated($\"SELECT * FROM {procName}({sqlArgs})\")"
            : $"FromSqlRaw(\"SELECT * FROM {schemaPrefixExpr}\" + {procMember} + \"({rawPlaceholders})\"{rawArgs})";
        // rc.19 R65: every generated type is named global::-qualified — the context, the result
        // and the arguments object — so neither a namespace nor a pair of usings can capture one.
        var ctxType = ValueObjectNames.ContextTypeRef(ctx.Config);
        // Use the resolved args VO's C# type — @parameterRef (and source.ParameterRef) can be a
        // package-qualified FQN ("acme::reporting::FooArgs"), and "::" is invalid in a C# type (CS7000).
        var fileNs = ctx.Config.Namespace;
        var argsType = hasArgs ? ValueObjectNames.GlobalRef(argsObject!, ctx.Config) : null;
        var resultType = ValueObjectNames.GlobalRef(entity, ctx.Config);
        var signature = hasArgs ? $"{ctxType} db, {argsType} args" : $"{ctxType} db";
        // The wrapper class is declared in Config.Namespace, whatever the object's package.
        ctx.Claim($"the C# namespace {fileNs}", $"{cls}Callable", entity.ResolutionKey(), NameClaims.HomeNamespaceRemedy("a callable wrapper"));

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects callable-generator. Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System.Collections.Generic;");
        sb.AppendLine("using System.Threading.Tasks;");
        sb.AppendLine("using Microsoft.EntityFrameworkCore;");
        // Package-binding — the callable's home namespace + the args VO's namespace, when split.
        // The callable file declares a `static class {cls}Callable` referencing the
        // result type and the args type; both can live in different per-package
        sb.AppendLine();
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        var kindNoun = source.EffectiveKind == SOURCE_KIND_STORED_PROC ? "stored procedure" : "table function";
        // The doc summary names the procedure the same way the SQL does — by the constant on
        // the names-ON arm (with the schema, when any, still spelled), literally otherwise.
        // The doc names the constants bare (prose, not code that must resolve).
        var procDocMember = CSharpNaming.SourceNameMember(entity, strategy, includeNames, source.Role);
        var schemaDocMember = CSharpNaming.SourceSchemaMember(entity, strategy, includeNames, source.Role);
        var procDoc = procDocMember is null
            ? $"the <c>{procName}</c> {kindNoun}"
            : $"the {kindNoun} named by <c>{procDocMember}</c>{(schemaDocMember is null ? "" : $" in schema <c>{schemaDocMember}</c>")}";
        sb.AppendLine("/// <summary>");
        sb.AppendLine($"/// FR-015: typed wrapper around {procDoc}. Arguments bind in");
        sb.AppendLine($"/// declaration order from the @parameterRef value-object{(hasArgs ? $" (<c>{argsObjectName}</c>)" : string.Empty)}.");
        sb.AppendLine("/// </summary>");
        sb.AppendLine($"public static class {cls}Callable");
        sb.AppendLine("{");
        sb.AppendLine($"    public static async Task<IReadOnlyList<{resultType}>> Call({signature})");
        sb.AppendLine("    {");
        sb.AppendLine($"        return await db.Set<{resultType}>()");
        sb.AppendLine($"            .{fromSql}");
        sb.AppendLine("            .AsNoTracking()");
        sb.AppendLine("            .ToListAsync();");
        sb.AppendLine("    }");
        sb.AppendLine("}");

        return new EmittedFile(OutputPaths.Of(entity, $"{cls}.callable.g.cs"), sb.ToString());
    }
}
