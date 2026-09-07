// SourceResolution — THE @role: primary source lookup, and the one place the
// primary-source DIVERGENCE refusal lives.
//
// Ported alongside typescript/packages/metadata/src/naming.ts (primaryRdbSource),
// python/src/metaobjects/source_resolution.py and
// java/metadata/.../source/SourceResolution.java.

namespace MetaObjects.Meta;

/// <summary>
/// THE <c>@role: primary</c> source lookup — and the one place the primary-source
/// DIVERGENCE refusal lives, so that every caller inherits it.
///
/// <para>It lives in the core <c>MetaObjects</c> assembly, not in
/// <c>MetaObjects.Codegen</c>'s naming helper, because the RUNTIME asks the same
/// question: <c>M2MResolver.TableOf</c> reads <see cref="MetaObject.DbTable"/> and
/// executes SQL against the answer, going through no generator at all. Mirrors Python's
/// <c>metaobjects.source_resolution</c>, whose codegen, api-docs and runtime callers all
/// inherit the refusal for free.</para>
///
/// <para><b>The refusal.</b></para>
///
/// <para>An object whose <c>@role: primary</c> sources resolve to MORE THAN ONE physical
/// name has no single answer to give, so <see cref="RefuseDivergentPrimaries"/> throws
/// rather than picking one. The shape loads with ZERO errors: ValidateOnePrimarySource
/// (Loader/ValidationPasses.cs) enforces "exactly one primary" over OWN children only, and
/// MetaData.EffectiveChildren shadows an own child over a super child only on a
/// (type, name) match — so two <c>source.rdb</c> nodes with DIFFERENT explicit names at
/// two levels of an <c>extends</c> chain never collide, and both survive on the child's
/// effective <see cref="MetaObject.Sources"/>.</para>
///
/// <para>Every consumer downstream binds ONE name unconditionally, with no per-site
/// equality guard. The refusal used to live in <c>CSharpNaming</c> — so it ran only for
/// code generation, and the M:N runtime resolver silently bound the inherited PARENT's
/// relation. A refusal that depends on which consumer asked is not a refusal.</para>
///
/// <para>DIRECTION-BLIND: it compares every primary against every other, so it does not
/// matter which of them is writable nor which was declared first. Comparing against the
/// first primary WRITABLE source can only see a divergence when one of the two is
/// read-only — and, since inherited sources come first, only when the read-only one is
/// the inherited one.</para>
///
/// <para>Two primaries AGREEING on a name is not a divergence and stays legal: the
/// invariant is that an object has ONE physical name, not that it declares one source. A
/// read-only primary beside a non-primary REPLICA does not reach it either — a replica is
/// not <c>role == primary</c>.</para>
/// </summary>
public static class SourceResolution
{
    /// <summary>
    /// Every <c>@role: primary</c> source of <paramref name="obj"/>, RESOLVING through the
    /// <c>extends</c> chain (ADR-0039) — an entity inheriting its <c>source.rdb</c> from an
    /// abstract base must see it, or it would wrongly read as unpersisted.
    /// <para>Private: nothing outside this class needs the LIST. The two public entry
    /// points below are the whole surface — a caller either wants the resolved primary or
    /// only wants the refusal, and no third shape has a use.</para>
    /// </summary>
    private static IReadOnlyList<MetaSource> PrimaryRdbSources(MetaObject obj) =>
        obj.Sources().Where(s => s.Role == SOURCE_ROLE_PRIMARY).ToList();

    /// <summary>
    /// The role-scoped PRIMARY source of <paramref name="obj"/>, or null when it has none
    /// (#248: participation in the database derives from a declared primary source, never
    /// from the object subtype). Runs <see cref="RefuseDivergentPrimaries"/> first, so
    /// every caller inherits the refusal.
    /// </summary>
    public static MetaSource? PrimaryRdbSource(MetaObject obj)
    {
        var primaries = PrimaryRdbSources(obj);
        Refuse(obj, primaries);
        return primaries.Count == 0 ? null : primaries[0];
    }

    /// <summary>
    /// Refuse <paramref name="obj"/> when its <c>@role: primary</c> sources disagree on a
    /// physical name. See the class doc for the reachability analysis and for why the
    /// check is direction-blind.
    /// </summary>
    public static void RefuseDivergentPrimaries(MetaObject obj) => Refuse(obj, PrimaryRdbSources(obj));

    /// <summary>
    /// The RESOLVED address of a source — the same three parts the names artifact
    /// compares, so the shared authority and the generated artifact cannot answer
    /// "is this one object?" differently. Rendered rather than structural because every
    /// port must produce a byte-identical message from it.
    ///
    /// RAW, deliberately: an absent <c>@schema</c> is NOT folded into a dialect default.
    /// On Postgres absent and "public" address the same relation, but on SQLite/D1 they
    /// do not — the expected-schema builder rejects ANY declared schema, "public"
    /// included, while an absent one is fine. Deciding what "absent" means belongs to the
    /// caller's dialect, not to this layer.
    /// </summary>
    public static string AddressKey(MetaSource source)
    {
        string schema = source.Schema ?? "";
        string qualifier = schema.Length == 0 ? "" : $"\"{schema}\".";
        return $"{qualifier}\"{source.PhysicalName}\" ({source.EffectiveKind})";
    }

    /// <summary>
    /// The refusal itself, over a primary list the caller already has. ONE implementation
    /// and ONE copy of the message: a check written twice is a check that can disagree
    /// with itself, which is the same defect one level down from the one this class
    /// prevents (a NAME resolved twice). The message is a cross-port contract string — the
    /// other four ports carry it verbatim.
    /// </summary>
    private static void Refuse(MetaObject obj, IReadOnlyList<MetaSource> primaries)
    {
        var distinct = primaries
            .Select(AddressKey)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        if (distinct.Count <= 1) return;
        // Sorted, so the message is identical in every port regardless of source order.
        var joined = string.Join(" vs ", distinct);
        throw new InvalidOperationException(
            $"{obj.Name}: role=primary sources disagree on the object's physical address — " +
            $"{joined}. Every consumer binds ONE address. Give them a matching @kind, @schema " +
            "and physical name, or drop the extra role=primary declaration.");
    }
}
