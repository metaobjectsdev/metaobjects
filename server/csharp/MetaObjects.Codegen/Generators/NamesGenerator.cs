// names-generator — emits one <Entity>Names.g.cs per object with a declared (or
// inherited) primary source (#248): GENERATED per-object physical database name
// constants (spec A1/A2/A6) a hand-written consumer references instead of a string
// literal.
//
// const, not static readonly: a [Table("...")]/[Column("...")] attribute argument
// requires a compile-time constant, and those two sites are the whole reason this
// artifact can replace a literal rather than sit beside one. ColumnsByField is
// `static readonly` because a Dictionary cannot be const — it serves iteration, not
// the attributes.

using System.Text;
using MetaObjects.Meta;

namespace MetaObjects.Codegen.Generators;

/// <summary>Generates one <c>&lt;Entity&gt;Names.g.cs</c> per object with a declared primary source.</summary>
public sealed class NamesGenerator : PerEntityGenerator
{
    public override string Name => "names";

    /// <summary>
    /// Pass 1 — every matched object that participates in the database (#248). Pass 2 — the
    /// abstract bases those participants EXTEND, each carrying the columns it declares so a
    /// child states them once rather than restating its parent's.
    /// <para>Pass 2 is reached by walking UP from a participant, never by scanning for
    /// abstracts: that is what keeps #248 intact. A sourceless object nothing persistable
    /// extends — an <c>object.value</c>, say — is not reached, so it acquires no artifact
    /// and no phantom participation.</para>
    /// </summary>
    public override IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var emitted = new HashSet<string>(StringComparer.Ordinal);
        var files = new List<EmittedFile>();

        var participants = ctx.Entities.Where(Filter).ToList();
        foreach (var entity in participants)
        {
            emitted.Add(entity.Name);
            files.Add(GenerateOne(entity, ctx));
        }

        foreach (var entity in participants)
        {
            for (var sup = CSharpNaming.NamesArtifactSuperOf(entity); sup is not null;
                 sup = CSharpNaming.NamesArtifactSuperOf(sup))
            {
                // Already emitted, and so is everything above it.
                if (!emitted.Add(sup.Name)) break;
                var fragment = Render(sup, ctx, fragment: true);
                if (fragment is not null) files.Add(fragment);
            }
        }
        return files;
    }

    // #248: participation derives from a declared primary source, never from the
    // object subtype — never gate on IsEntity()/abstract/etc. A cheap existence check;
    // the strategy-sensitive full resolve happens once, in GenerateOne, against the real
    // ctx.Config.ColumnNamingStrategy. The divergence refusal is not this generator's to
    // own and never was — it lives in MetaObjects.Meta.SourceResolution, which every
    // caller that resolves a physical name goes through, codegen and runtime alike.
    protected override bool Filter(MetaObject entity) => CSharpNaming.HasPrimarySource(entity);

    protected override EmittedFile GenerateOne(MetaObject entity, GenContext ctx) =>
        Render(entity, ctx, fragment: false)
        ?? throw new InvalidOperationException(
            $"{entity.Name}: Filter() matched (a primary source exists) but ResolveObjectNames " +
            "returned null.");

    private static EmittedFile? Render(MetaObject entity, GenContext ctx, bool fragment)
    {
        var cls = CSharpNaming.NamesClassName(entity);

        // A3: the SAME resolver the EF Core bindings are meant to call, with the same
        // arguments, in the same run — CSharpNaming.ResolveObjectNames (beside
        // NamesClassName) is the ONE place a data name is resolved.
        var names = fragment
            ? CSharpNaming.ResolveSuperFragmentNames(entity, ctx.Config.ColumnNamingStrategy)
            : CSharpNaming.ResolveObjectNames(entity, ctx.Config.ColumnNamingStrategy);
        if (names is null) return null;

        // The class DECLARES only its own columns when it has a base to inherit the rest
        // from; without one it must declare every field it describes, because a consumer
        // looks a column up by field name and an inherited one has to be there.
        var superCls = names.SuperNames is null
            ? null
            : CSharpNaming.NamesClassName(names.SuperNames.Name);
        var rows = superCls is null ? names.Fields : names.OwnFields;

        var fields = rows.Values
            .Select(f => (Member: CSharpNaming.Pascal(f.Name), f.Name, f.Column))
            .OrderBy(t => t.Name, StringComparer.Ordinal)
            .ToList();

        // Two fields whose Pascal forms collide would emit duplicate const members.
        // C# would refuse to compile it, but the error would name a generated file and
        // read as a codegen bug rather than a model one. Fail here, naming the model.
        var dupe = fields.GroupBy(t => t.Member).FirstOrDefault(g => g.Count() > 1);
        if (dupe is not null)
            throw new InvalidOperationException(
                $"{entity.Name}: fields {string.Join(", ", dupe.Select(d => d.Name))} all yield the " +
                $"constant member \"{dupe.Key}\". Rename one, or give it an explicit @column.");

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects names-generator. Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System.Collections.Generic;");
        sb.AppendLine();
        // Task 4 (§A6) — the same per-package resolution EntityGenerator uses for the
        // entity itself, so a package carrying a PackageNamespaces override still lands
        // its <Entity>Names companion in the SAME namespace as the entity it describes
        // (the promise the consumption sites rely on: no new `using` is required).
        // Bare ctx.Config.Namespace would silently break that promise whenever a
        // per-package override is configured.
        sb.AppendLine($"namespace {PackageBindingResolver.Resolve(ctx.Config, PackageBindingResolver.EffectivePackage(entity), entity.Name, fallbackContext: entity.Name)};");
        sb.AppendLine();
        sb.AppendLine("/// <summary>");
        sb.AppendLine($"/// GENERATED — per-object physical database names for {CSharpNaming.Pascal(entity.Name)} (spec A1/A2/A6).");
        sb.AppendLine("/// </summary>");
        // `abstract class`, not `static class`: a static class can neither inherit nor be
        // inherited, and this artifact now extends its parent's rather than restating it.
        // Abstract keeps the "never instantiate this" guarantee a static class gave, and a
        // `const` is inherited — `CopayAuthNames.IdColumn` resolves through the base — so
        // every consumption site is unchanged.
        var extends = superCls is null ? "" : $" : {superCls}";
        sb.AppendLine($"public abstract class {cls}{extends}");
        sb.AppendLine("{");
        // A fragment has no source, so no Kind/Name/Schema/ReadOnly — it must never acquire
        // a physical name it never declared. A TPH subtype INHERITS its base's source, so
        // those four come from the base class rather than being restated here.
        if (!fragment && !names.InheritsSource)
        {
        sb.AppendLine($"    public const string Kind = \"{names.Kind}\";");
        sb.AppendLine($"    public const string Name = \"{names.Name}\";");
        // Omitted, never emitted as null: absent means undeclared, and a `null` constant
        // would read as "declared empty".
        if (!string.IsNullOrEmpty(names.Schema))
            sb.AppendLine($"    public const string Schema = \"{names.Schema}\";");
        sb.AppendLine($"    public const bool ReadOnly = {(names.ReadOnly == true ? "true" : "false")};");
        sb.AppendLine();
        }
        foreach (var (member, field, column) in fields)
        {
            sb.AppendLine($"    public const string {member}Field = \"{field}\";");
            sb.AppendLine($"    public const string {member}Column = \"{column}\";");
        }
        sb.AppendLine();
        // ColumnsByField stays COMPLETE — every field, inherited included — because it is
        // the lookup surface, and a miss on an inherited field is exactly the fallback-to-
        // literal this artifact removes. It repeats no LITERAL: an inherited entry's value
        // is the base's own const, reached through the base class. `new` because a derived
        // class hides the base's field rather than overriding it (a static field cannot be
        // virtual), which is what makes `<Sub>Names.ColumnsByField` the complete one.
        var hides = superCls is null ? "" : "new ";
        sb.AppendLine($"    public static {hides}readonly Dictionary<string, string> ColumnsByField = new(System.StringComparer.Ordinal)");
        sb.AppendLine("    {");
        foreach (var f in names.Fields.Values.OrderBy(v => v.Name, StringComparer.Ordinal))
            sb.AppendLine($"        [\"{f.Name}\"] = {CSharpNaming.Pascal(f.Name)}Column,");
        sb.AppendLine("    };");
        sb.AppendLine("}");

        return new EmittedFile($"{cls}.g.cs", sb.ToString());
    }
}
