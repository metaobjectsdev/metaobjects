// names-generator — emits one <Entity>Names.g.cs per object with a declared (or
// inherited) primary source (#248): GENERATED per-object physical database name
// constants (spec A1/A2/A6) a hand-written consumer references instead of a string
// literal.
//
// The artifact MIRRORS THE METADATA TREE. Every node it describes — the object, each
// source, each identity, each index — carries its own `type`, `subType` and `name`, and a
// physical name sits under the member that says what it IS: `SourcePrimaryTable`,
// `SourceReplicaView`, `SourcePrimaryProc`, using PHYSICAL_NAME_ATTR_BY_KIND, the
// metamodel's own FR-016/ADR-0018 alias map. Before 0.25.0 one member called `Name` held a
// table, a view and a stored procedure in the same run, told apart only by a sibling
// `Kind`, and in none of them did it hold the object's own name.
//
// Fields are the ONE node kind that keeps a bare `<Pascal>Field`/`<Pascal>Column` pair,
// and the asymmetry is deliberate: a field's subType does not change what `Column`
// denotes, while an object's subType decides table-vs-view and an identity's decides
// unique-vs-not (ADR-0040 put uniqueness in the type).
//
// const, not static readonly: a [Table("...")]/[Column("...")] attribute argument
// requires a compile-time constant, and those two sites are the whole reason this
// artifact can replace a literal rather than sit beside one. ColumnsByField is
// `static readonly` because a Dictionary cannot be const — it serves iteration, not
// the attributes.

using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Persistence.Source.SourceConstants;

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
                // "Fragment" means "declares no source", so it is DERIVED rather than
                // asserted. Hardcoding true was right for the shape this pass was written
                // for — an abstract base with columns and no table — and wrong for the one
                // it also reaches: a scoped run walks up to a TPH BASE, which owns the
                // shared table, and a fragment renders no source members at all while the
                // subtype's class still inherits them.
                var fragment = Render(sup, ctx,
                    fragment: SourceResolution.PrimaryRdbSource(sup) is null);
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

    /// <summary>One emitted constant: its member name, its declaration body, and the metadata
    /// node it came from (named in the collision refusal, so a failure points at the model).</summary>
    private readonly record struct Member(string Name, string Decl, string NodePath);

    private static Member Str(string name, string value, string nodePath) =>
        new(name, $"const string {name} = \"{value}\";", nodePath);

    /// <summary>
    /// Every constant an artifact declares, in emission order, grouped so the emitter can
    /// separate the groups with blank lines.
    /// <para><paramref name="ownOnly"/> selects what a class with a BASE declares — its own
    /// members, the rest reached through C# inheritance. Without a base every member must be
    /// here: a consumer looks a column up by field name, and an inherited miss falls back to
    /// a literal, which is the defect the artifact exists to remove.</para>
    /// <para>The SOURCE group needs no <c>InheritsSource</c> test: a TPH subtype declares no
    /// own source, so its <c>OwnSources</c> is empty and base-class inheritance carries the
    /// base's <c>SourcePrimaryTable</c> down. The structural fact and the emission rule are
    /// the same fact, read once.</para>
    /// </summary>
    private static List<List<Member>> MemberGroups(ObjectNames n, bool ownOnly)
    {
        var groups = new List<List<Member>>();

        // The object's own identity. `Name` is the METAMODEL name — it held the physical name
        // until 0.25.0, and that member changing meaning without changing shape is the one
        // thing here a hand-written consumer adopts without a compile error.
        groups.Add(
        [
            Str(CSharpNaming.Pascal(CSharpNaming.MEMBER_TYPE), n.Type, "object"),
            Str(CSharpNaming.Pascal(CSharpNaming.MEMBER_SUB_TYPE), n.SubType, "object"),
            Str(CSharpNaming.Pascal(CSharpNaming.MEMBER_NAME), n.Name, "object"),
        ]);

        var sources = ownOnly ? n.OwnSources : n.Sources;
        var sourceMembers = new List<Member>();
        foreach (var role in sources.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            var src = sources[role];
            var path = $"source @role \"{role}\"";
            string M(string member) => CSharpNaming.SourceMemberName(role, member);
            sourceMembers.Add(Str(M(CSharpNaming.MEMBER_TYPE), src.Type, path));
            sourceMembers.Add(Str(M(CSharpNaming.MEMBER_SUB_TYPE), src.SubType, path));
            sourceMembers.Add(Str(M(CSharpNaming.MEMBER_KIND), src.Kind, path));
            // Omitted, never emitted as null: absent means undeclared, and a `null` constant
            // would read as "declared empty".
            if (!string.IsNullOrEmpty(src.Schema))
                sourceMembers.Add(Str(M(SOURCE_ATTR_SCHEMA), src.Schema, path));
            if (src.PhysicalNameAlias is { } alias && src.PhysicalName is { } physical)
                sourceMembers.Add(Str(M(alias), physical, path));
        }
        groups.Add(sourceMembers);

        var fields = ownOnly ? n.OwnFields : n.Fields;
        var fieldMembers = new List<Member>();
        foreach (var f in fields.Values.OrderBy(v => v.Name, StringComparer.Ordinal))
        {
            var path = $"field \"{f.Name}\"";
            fieldMembers.Add(Str(CSharpNaming.FieldMemberName(f.Name, CSharpNaming.MEMBER_FIELD), f.Name, path));
            fieldMembers.Add(Str(CSharpNaming.FieldMemberName(f.Name, CSharpNaming.MEMBER_COLUMN), f.Column, path));
        }
        groups.Add(fieldMembers);

        foreach (var keys in new[]
                 {
                     ownOnly ? n.OwnIdentities : n.Identities,
                     ownOnly ? n.OwnIndexes : n.Indexes,
                 })
        {
            var keyMembers = new List<Member>();
            foreach (var k in keys.Values.OrderBy(v => v.Name, StringComparer.Ordinal))
            {
                var path = $"{k.Type}.{k.SubType} \"{k.Name}\"";
                string M(string member) => CSharpNaming.KeyMemberName(k.Type, k.Name, member);
                keyMembers.Add(Str(M(CSharpNaming.MEMBER_TYPE), k.Type, path));
                keyMembers.Add(Str(M(CSharpNaming.MEMBER_SUB_TYPE), k.SubType, path));
                keyMembers.Add(Str(M(CSharpNaming.MEMBER_NAME), k.Name, path));
                if (k.Index is { } index)
                    keyMembers.Add(Str(M(CSharpNaming.MEMBER_INDEX), index, path));
            }
            groups.Add(keyMembers);
        }

        return groups;
    }

    /// <summary>
    /// The member names this artifact's BASE CLASS CHAIN already declares — what a member
    /// emitted here would HIDE, so it is emitted with <c>new</c>.
    /// <para>Not cosmetic: every artifact now declares <c>Type</c>/<c>SubType</c>/<c>Name</c>
    /// of its own, so every derived one hides three of its base's members (CS0108). A
    /// generator that emits warnings trains a reader to ignore them.</para>
    /// </summary>
    private static HashSet<string> InheritedMembers(MetaObject obj, ColumnNamingStrategy strategy)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        for (var sup = CSharpNaming.NamesArtifactSuperOf(obj); sup is not null;
             sup = CSharpNaming.NamesArtifactSuperOf(sup))
        {
            // The SAME fragment rule Generate() uses: pass 1 emits a participant with its
            // sources, pass 2 emits everything above it as a fragment. A super that resolves
            // object names IS a participant.
            var names = CSharpNaming.ResolveObjectNames(sup, strategy)
                        ?? CSharpNaming.ResolveSuperFragmentNames(sup, strategy);
            if (names is null) continue;
            var supOwnOnly = CSharpNaming.NamesArtifactSuperOf(sup) is not null;
            foreach (var m in MemberGroups(names, supOwnOnly).SelectMany(g => g)) set.Add(m.Name);
        }
        return set;
    }

    private static EmittedFile? Render(MetaObject entity, GenContext ctx, bool fragment)
    {
        var cls = CSharpNaming.NamesClassName(entity);
        var strategy = ctx.Config.ColumnNamingStrategy;

        // A3: the SAME resolver the EF Core bindings are meant to call, with the same
        // arguments, in the same run — CSharpNaming.ResolveObjectNames (beside
        // NamesClassName) is the ONE place a data name is resolved.
        var names = fragment
            ? CSharpNaming.ResolveSuperFragmentNames(entity, strategy)
            : CSharpNaming.ResolveObjectNames(entity, strategy);
        if (names is null) return null;

        var superCls = names.SuperNames is null
            ? null
            : CSharpNaming.NamesClassName(names.SuperNames.Name);

        // The collision guard runs over the WHOLE effective member set, never just what this
        // class declares, and never per-collection. Two reasons, and both were paid for:
        //
        //  - Once a child stopped restating its inherited constants, an own-only check could
        //    no longer see a collision that spans the inheritance boundary — and the compiler
        //    would not catch it either, because a derived `const` HIDES the base's rather than
        //    clashing with it. The file would compile while ColumnsByField mapped the
        //    inherited field name to the child's column.
        //  - Per-collection is not enough now that four node kinds share one flat member
        //    namespace: `uq_cust_email` (an identity) and `uqCustEmail` (an index) yield the
        //    same member from different collections, and one would silently overwrite the
        //    other.
        var byMember = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var m in MemberGroups(names, ownOnly: false).SelectMany(g => g))
        {
            if (byMember.TryGetValue(m.Name, out var first))
                throw new InvalidOperationException(
                    $"{entity.Name}: {first} and {m.NodePath} both yield the constant member " +
                    $"\"{m.Name}\". Rename one, or give it an explicit @column.");
            byMember[m.Name] = m.NodePath;
        }

        var inherited = InheritedMembers(entity, strategy);
        var groups = MemberGroups(names, ownOnly: superCls is not null);

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
        foreach (var group in groups.Where(g => g.Count > 0))
        {
            foreach (var m in group)
                sb.AppendLine($"    public {(inherited.Contains(m.Name) ? "new " : "")}{m.Decl}");
            sb.AppendLine();
        }
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
            sb.AppendLine($"        [\"{f.Name}\"] = {CSharpNaming.FieldMemberName(f.Name, CSharpNaming.MEMBER_COLUMN)},");
        sb.AppendLine("    };");
        sb.AppendLine("}");

        return new EmittedFile($"{cls}.g.cs", sb.ToString());
    }
}
