// TphPlan — codegen-side descriptor for an FR-017 table-per-hierarchy (TPH) base.
//
// Mirrors the TS reference (codegen-ts/src/templates/tph-discriminator.ts:
// isTphDiscriminatorBase / tphPlan / tphRouteSegment / collectTphSubtypeFields /
// collectConcreteSubtypes). An object.entity carrying @discriminator is the TPH
// base; concrete entities that `extends` it and declare @discriminatorValue are
// its subtypes. All subtypes share ONE physical table (single-table inheritance).
//
// The plan is the single source of truth every TPH-aware generator reads (entity,
// dbcontext, routes) so the route-segment rule and subtype set can never drift
// between the emitted artifacts. The per-subtype REST route segment is the
// @discriminatorValue lowercased — derived in exactly one place
// (TphRouteSegment).

using MetaObjects.Meta;
using static MetaObjects.Core.Object.ObjectConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>One concrete subtype bound to a TPH base.</summary>
/// <param name="Entity">The concrete subtype entity.</param>
/// <param name="Value">Its <c>@discriminatorValue</c> (e.g. <c>"Bridge"</c>).</param>
/// <param name="RouteSegment">The per-subtype REST route segment (e.g. <c>"bridge"</c>).</param>
public sealed record TphSubtypePlan(MetaObject Entity, string Value, string RouteSegment);

/// <summary>
/// The single source of truth for a TPH base's polymorphic shape: the discriminator
/// field name, the concrete subtypes (stable name-sorted order), each subtype's
/// <c>@discriminatorValue</c>, and its per-subtype route segment.
/// </summary>
public sealed record TphPlan(MetaObject Base, string DiscriminatorField, IReadOnlyList<TphSubtypePlan> Subtypes);

/// <summary>
/// Builds <see cref="TphPlan"/> descriptors from metadata — the single place codegen
/// derives TPH behavior. Shared by the entity / dbcontext / routes generators so they
/// agree on the discriminator field, subtype set, and route segments.
/// </summary>
public static class TphPlanBuilder
{
    /// <summary>
    /// The per-subtype REST route segment for a discriminator value — the ONE place
    /// this rule lives (mirrors TS <c>tphRouteSegment</c>): the value lowercased
    /// (<c>"Bridge"</c> → <c>bridge</c>, <c>"PriorAuth"</c> → <c>priorauth</c>).
    /// </summary>
    public static string RouteSegment(string discriminatorValue) =>
        discriminatorValue.ToLowerInvariant();

    /// <summary>
    /// The <see cref="TphPlan"/> for a discriminator base, or <see langword="null"/> when
    /// <paramref name="baseObj"/> is not a discriminator base (no <c>@discriminator</c>, or
    /// no concrete subtypes).
    /// </summary>
    public static TphPlan? For(MetaObject baseObj, MetaRoot root)
    {
        if (baseObj.OwnAttr(OBJECT_ATTR_DISCRIMINATOR) is not string discField || discField.Length == 0)
            return null;
        var subtypes = CollectConcreteSubtypes(baseObj, root);
        if (subtypes.Count == 0) return null;
        return new TphPlan(baseObj, discField, subtypes
            .Select(b => new TphSubtypePlan(b.Subtype, b.Value, RouteSegment(b.Value)))
            .ToList());
    }

    /// <summary>
    /// True when this entity is a TPH discriminator base — it carries <c>@discriminator</c>
    /// AND at least one concrete subtype declares <c>@discriminatorValue</c> extending it.
    /// </summary>
    public static bool IsTphDiscriminatorBase(MetaObject obj, MetaRoot root) => For(obj, root) is not null;

    /// <summary>
    /// True when this entity is a concrete TPH subtype — it declares <c>@discriminatorValue</c>
    /// and (transitively) extends a <c>@discriminator</c>-bearing base. Such an entity emits
    /// NO standalone table/DbSet/routes (it is folded into the base's single table).
    /// </summary>
    public static bool IsTphSubtype(MetaObject obj, MetaRoot root)
    {
        if (obj.OwnAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE) is not string value || value.Length == 0)
            return false;
        return DiscriminatorRoot(obj) is { } discRoot && !ReferenceEquals(discRoot, obj);
    }

    /// <summary>
    /// True when this entity participates in a TPH hierarchy as a NON-root member — it
    /// (transitively) extends a <c>@discriminator</c> base. Unlike <see cref="IsTphSubtype"/>
    /// this includes ABSTRACT intermediates (which carry no <c>@discriminatorValue</c>) as well
    /// as concrete leaves. Used to emit the inheritance chain `Sub : DirectParent` for every
    /// link, so abstract intermediates are real base classes (not baseless shapes). The
    /// discriminator root itself returns false.
    /// </summary>
    public static bool IsTphMember(MetaObject obj, MetaRoot root) =>
        DiscriminatorRoot(obj) is { } discRoot && !ReferenceEquals(discRoot, obj);

    /// <summary>
    /// The subtype-only fields folded into the base's single TPH table. For each concrete
    /// subtype, every effective field NOT already on the base is collected (effective, so a
    /// multi-level hierarchy's intermediate fields are captured too), deduplicated by name
    /// across subtypes. The caller emits each as a nullable column (rows of other subtypes
    /// store NULL). Mirrors TS <c>collectTphSubtypeFields</c>.
    /// </summary>
    public static IReadOnlyList<MetaField> CollectSubtypeFields(MetaObject baseObj, MetaRoot root)
    {
        var plan = For(baseObj, root);
        if (plan is null) return [];
        var baseNames = new HashSet<string>(baseObj.Fields().Select(f => f.Name), StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var outFields = new List<MetaField>();
        foreach (var st in plan.Subtypes)
            foreach (var f in st.Entity.Fields())
            {
                if (baseNames.Contains(f.Name)) continue; // base column — already emitted
                if (!seen.Add(f.Name)) continue;          // shared subtype column — emit once
                outFields.Add(f);
            }
        return outFields;
    }

    // The concrete subtypes bound to this base via extends, in stable (name-sorted) order.
    private static List<(MetaObject Subtype, string Value)> CollectConcreteSubtypes(MetaObject baseObj, MetaRoot root)
    {
        var bindings = new List<(MetaObject, string)>();
        foreach (var obj in root.Objects())
        {
            if (!obj.IsEntity()) continue;
            if (obj.IsAbstract) continue;
            if (ReferenceEquals(obj, baseObj)) continue;
            if (obj.OwnAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE) is not string value || value.Length == 0) continue;

            // Walk the extends chain looking for baseObj.
            var cursor = obj.SuperData;
            var found = false;
            while (cursor is not null)
            {
                if (ReferenceEquals(cursor, baseObj)) { found = true; break; }
                cursor = cursor.SuperData;
            }
            if (!found) continue;
            bindings.Add((obj, value));
        }
        bindings.Sort((a, b) => string.CompareOrdinal(a.Item1.Name, b.Item1.Name));
        return bindings;
    }

    // The nearest @discriminator-bearing ancestor (or self), walking the extends chain.
    private static MetaObject? DiscriminatorRoot(MetaObject obj)
    {
        MetaData? cursor = obj;
        while (cursor is not null)
        {
            if (cursor.OwnAttr(OBJECT_ATTR_DISCRIMINATOR) is string v && v.Length > 0)
                return cursor as MetaObject;
            cursor = cursor.SuperData;
        }
        return null;
    }
}
