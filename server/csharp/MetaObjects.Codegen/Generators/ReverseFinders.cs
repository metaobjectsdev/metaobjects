// ReverseFinders — ADR-0038 reverse-relationship navigation via explicit FK
// query methods (NOT lazy EF Core collections).
//
// For each FK an entity E holds (an identity.reference whose @fields names the
// local FK column), E's query surface gains a finder pair returning the E rows
// matching a given target id:
//
//   <E>[]  Find<EPlural>By<FkField>(db, value)    → WHERE <fk> = value   (single, indexed)
//   <E>[]  Find<EPlural>By<FkField>In(db, values) → WHERE <fk> IN values (batched, anti-N+1)
//
// The finder NAME derives from the FK FIELD (PascalCased, single trailing `Id`
// dropped — the CSharpNaming.ReverseFinder* SSOT), so it is unique within E by
// construction: an entity with several FKs to the SAME target yields several
// distinct finders, never a collision (the GameSession→Scene ×3 case).
//
// Both finders are plain, framework-free, single-query LINQ over the generated
// DbSet (Where + Contains) — no lazy navigation, no open-session requirement.
// They live in a per-entity <E>Queries static class so they read off the entity's
// own query surface. M:N navigation (junction traversal) is a SEPARATE concern
// (M2MNavigation) and is unaffected.

using MetaObjects.Meta;

namespace MetaObjects.Codegen.Generators;

/// <summary>
/// A resolved reverse FK on a referencing entity: the local FK field (the column
/// the finder filters on) and the target entity it references. Derived from an
/// <c>identity.reference</c> at codegen time.
/// </summary>
public sealed record ReverseFk(
    /// <summary>The local FK field name on the referencing entity (e.g. "currentSceneId").</summary>
    string FkField,
    /// <summary>The bare target entity name the FK references (e.g. "Scene").</summary>
    string TargetEntity);

/// <summary>
/// Builds <see cref="ReverseFk"/> descriptors and renders the reverse finders for
/// an entity. The single place codegen derives reverse FK navigation, mirroring
/// the TS reverseFksFor / renderReverseFinderFns.
/// </summary>
public static class ReverseFinderBuilder
{
    /// <summary>
    /// This entity's OWN reverse FKs, in declaration order — one per
    /// <c>identity.reference</c> with a single local FK field. A reference whose FK
    /// field or target cannot be resolved is skipped (the loader surfaces the error).
    /// </summary>
    public static IReadOnlyList<ReverseFk> For(MetaObject entity)
    {
        var result = new List<ReverseFk>();
        foreach (var reference in entity.ReferenceIdentities())
        {
            var fkField = reference.Fields.Count > 0 ? reference.Fields[0] : null;
            var target = reference.TargetEntity;
            if (string.IsNullOrEmpty(fkField) || string.IsNullOrEmpty(target)) continue;
            result.Add(new ReverseFk(fkField!, CSharpNaming.StripPkg(target!)));
        }
        return result;
    }

    /// <summary>
    /// The C# value type of the FK — the type the finder filters on. The BASE scalar
    /// is the target entity's PK type the FK references (falling back to the FK field's
    /// own subtype, then <c>long</c>), matching the key on the wire (the TS contract).
    /// The NULLABILITY mirrors the FK property the entity class emits: a non-required
    /// (optional) FK column is <c>long?</c>, so the batched <c>Contains(e.&lt;Fk&gt;)</c>
    /// element type lines up with the nullable property (a self-FK like Node.parentId).
    /// </summary>
    private static string FkValueType(MetaObject entity, ReverseFk fk, MetaRoot root)
    {
        var target = root.FindObject(fk.TargetEntity);
        var targetPkField = target?.PrimaryIdentity()?.Fields is { Count: 1 } pk
            ? target.FindField(pk[0])
            : null;

        string baseType =
            (targetPkField is not null ? CSharpNaming.ScalarFor(targetPkField.SubType) : null)
            ?? (entity.FindField(fk.FkField) is { } ownField ? CSharpNaming.ScalarFor(ownField.SubType) : null)
            ?? "long";

        // Nullability follows the FK property the entity class declares: a value type
        // gets `?` when the FK column is not required (reference types are already
        // nullable in the property and need no suffix).
        var fkRequired = entity.FindField(fk.FkField) is { } f && CSharpNaming.IsRequired(entity, f);
        return !fkRequired && CSharpNaming.IsValueType(baseType) ? baseType + "?" : baseType;
    }

    /// <summary>
    /// Render the per-entity <c>&lt;E&gt;Queries</c> static class holding the reverse
    /// finder pair for each reverse FK, or null when the entity holds no reverse FK.
    /// </summary>
    public static EmittedFile? Generate(MetaObject entity, GenContext ctx)
    {
        var fks = For(entity);
        if (fks.Count == 0) return null;

        var cls = CSharpNaming.Pascal(entity.Name);
        var queriesCls = CSharpNaming.QueriesClassName(entity);
        var dbSet = CSharpNaming.DbSetName(entity);

        var sb = new System.Text.StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects entity-generator (reverse FK finders, ADR-0038). Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System.Collections.Generic;");
        sb.AppendLine("using System.Linq;");
        sb.AppendLine("using Microsoft.EntityFrameworkCore;");
        sb.AppendLine();
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        sb.AppendLine("/// <summary>Reverse-relationship FK finders for " + cls + " (ADR-0038): explicit,");
        sb.AppendLine("/// single-query reads — no lazy navigation, no N+1.</summary>");
        sb.AppendLine($"public static class {queriesCls}");
        sb.AppendLine("{");

        var first = true;
        foreach (var fk in fks)
        {
            var valueType = FkValueType(entity, fk, ctx.Root);
            var prop = CSharpNaming.Pascal(fk.FkField);
            var arg = fk.FkField;
            var single = CSharpNaming.ReverseFinderName(entity, fk.FkField);
            var batched = CSharpNaming.ReverseFinderInName(entity, fk.FkField);

            if (!first) sb.AppendLine();
            first = false;

            // Single: one indexed WHERE <fk> = value → List<E>.
            sb.AppendLine($"    /// <summary>The {cls} rows whose {prop} equals <paramref name=\"{arg}\"/> (one indexed query).</summary>");
            sb.AppendLine($"    public static async System.Threading.Tasks.Task<List<{cls}>> {single}(AppDbContext db, {valueType} {arg}) =>");
            sb.AppendLine($"        await db.{dbSet}.AsNoTracking().Where(e => e.{prop} == {arg}).ToListAsync();");
            sb.AppendLine();

            // Batched: one WHERE <fk> IN (values) → List<E> (anti-N+1 "selectin" shape).
            sb.AppendLine($"    /// <summary>The {cls} rows whose {prop} is in <paramref name=\"{arg}s\"/> (one batched IN query; anti-N+1).</summary>");
            sb.AppendLine($"    public static async System.Threading.Tasks.Task<List<{cls}>> {batched}(AppDbContext db, IReadOnlyCollection<{valueType}> {arg}s)");
            sb.AppendLine("    {");
            sb.AppendLine($"        if ({arg}s.Count == 0) return new List<{cls}>();");
            sb.AppendLine($"        return await db.{dbSet}.AsNoTracking().Where(e => {arg}s.Contains(e.{prop})).ToListAsync();");
            sb.AppendLine("    }");
        }

        sb.AppendLine("}");
        return new EmittedFile($"{queriesCls}.g.cs", sb.ToString());
    }
}
