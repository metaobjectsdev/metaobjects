// Lifecycle and operation-target derivation (ADR-0063), shared by the loader's rules pass
// and `verify`'s rules gate. Everything here is DERIVED: a lifecycle, its states, its
// initial and terminal states and an operation's target entity have no vocabulary of their
// own. Mirrors server/typescript/packages/metadata/src/core/transition/lifecycle.ts.
//
// Reads are RESOLVING (ADR-0039): a transition declared on a base entity's field is a
// transition of every entity that extends it. It is NOT a transition of an entity whose field
// merely `extends` that field: a field extends another to share its values, and a history
// table of an order's status is not an order (LifecycleTransitionsOf).

using MetaObjects.Meta;

namespace MetaObjects.Core.Transition;

/// <summary>One lifecycle of an entity: an enum field with at least one transition.</summary>
/// <param name="Field">The enum field.</param>
/// <param name="States">The enum's @values, in declaration order.</param>
/// <param name="Initial">The enum's @default; null only on a model the loader refused.</param>
/// <param name="Transitions">The field's transitions.</param>
public sealed record Lifecycle(
    MetaData Field,
    IReadOnlyList<string> States,
    string? Initial,
    IReadOnlyList<MetaData> Transitions);

/// <summary>How an operation's target was derived. <c>ViaInput</c> means the input borrows the target's key.</summary>
public sealed record DerivedTarget(MetaData Entity, bool ViaInput);

/// <summary>Lifecycle and operation-target derivations.</summary>
public static class Lifecycles
{
    /// <summary>A string-array attr read resolving; a bare string is ONE element.</summary>
    public static IReadOnlyList<string> StringList(MetaData node, string attr) => node.Attr(attr) switch
    {
        IReadOnlyList<string> list => list,
        IReadOnlyList<object?> objs => objs.OfType<string>().ToList(),
        string s => [s],
        _ => [],
    };

    private static string? StringValue(MetaData node, string attr) => node.Attr(attr) as string;

    /// <summary>The <c>transition.action</c> children of a field, resolving.</summary>
    public static IReadOnlyList<MetaData> TransitionsOf(MetaData field) =>
        field.Children().Where(c => c.Type == TYPE_TRANSITION && c.SubType == TRANSITION_SUBTYPE_ACTION).ToList();

    /// <summary>Whether an entity's lifecycles are live: it declares or inherits a source. A lifecycle on an
    /// entity with no source loads and is inert (it derives no command); the writable-source check applies
    /// once a source is added (ADR-0063 section 2). Read through the resolving accessor.</summary>
    public static bool LifecycleIsLive(MetaData entity) => entity.Children().Any(c => c.Type == TYPE_SOURCE);

    /// <summary>An entity and every entity it extends, nearest first.</summary>
    public static IReadOnlyList<MetaData> EntityLineage(MetaData entity)
    {
        var output = new List<MetaData>();
        for (MetaData? e = entity; e is not null && !output.Contains(e); e = e.SuperData) output.Add(e);
        return output;
    }

    /// <summary>The transitions a field gives an entity: those declared on a field of the entity itself or
    /// of an entity it extends. A transition reached only through the field's own <c>extends</c> of
    /// another entity's field is not one (ADR-0063 section 2).</summary>
    public static IReadOnlyList<MetaData> LifecycleTransitionsOf(MetaData entity, MetaData field)
    {
        var lineage = EntityLineage(entity);
        return TransitionsOf(field).Where(t => t.Parent?.Parent is { } owner && lineage.Contains(owner)).ToList();
    }

    /// <summary>The lifecycles of an object, in effective field order. Only an <c>object.entity</c> has any.</summary>
    public static IReadOnlyList<Lifecycle> LifecyclesOf(MetaData obj)
    {
        if (obj.Type != TYPE_OBJECT || obj.SubType != OBJECT_SUBTYPE_ENTITY) return [];
        var output = new List<Lifecycle>();
        foreach (var field in obj.Children())
        {
            if (field.Type != TYPE_FIELD || field.SubType != FIELD_SUBTYPE_ENUM) continue;
            var transitions = LifecycleTransitionsOf(obj, field);
            if (transitions.Count == 0) continue;
            output.Add(new Lifecycle(
                field,
                StringList(field, FIELD_ATTR_VALUES),
                field.Attr(FIELD_ATTR_DEFAULT) as string,
                transitions));
        }
        return output;
    }

    /// <summary>Every transition of an entity, across all its lifecycles.</summary>
    public static IReadOnlyList<MetaData> EntityTransitions(MetaData obj) =>
        LifecyclesOf(obj).SelectMany(l => l.Transitions).ToList();

    /// <summary>A transition's @from (resolving).</summary>
    public static IReadOnlyList<string> TransitionFrom(MetaData t) => StringList(t, TRANSITION_ATTR_FROM);

    /// <summary>A transition's @to (resolving).</summary>
    public static string? TransitionTo(MetaData t) => StringValue(t, TRANSITION_ATTR_TO);

    /// <summary>The states reachable from the initial state, following every transition.</summary>
    public static HashSet<string> ReachableStates(Lifecycle l)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        if (l.Initial is null) return seen;
        var queue = new Queue<string>();
        queue.Enqueue(l.Initial);
        seen.Add(l.Initial);
        while (queue.Count > 0)
        {
            var s = queue.Dequeue();
            foreach (var t in l.Transitions)
            {
                var to = TransitionTo(t);
                if (to is not null && TransitionFrom(t).Contains(s) && seen.Add(to)) queue.Enqueue(to);
            }
        }
        return seen;
    }

    /// <summary>The members no transition leaves (a self-transition counts as leaving).</summary>
    public static IReadOnlyList<string> TerminalStates(Lifecycle l)
    {
        var leaving = l.Transitions.SelectMany(TransitionFrom).ToHashSet(StringComparer.Ordinal);
        return l.States.Where(s => !leaving.Contains(s)).ToList();
    }

    /// <summary>The primary key field names of an entity: its effective <c>identity.primary</c> @fields.</summary>
    public static IReadOnlyList<string> PrimaryKeyFields(MetaData entity)
    {
        var primary = entity.Children().FirstOrDefault(c => c.Type == TYPE_IDENTITY && c.SubType == IDENTITY_SUBTYPE_PRIMARY);
        return primary is null ? [] : StringList(primary, IDENTITY_ATTR_FIELDS);
    }

    /// <summary>The package a node's references resolve in: its top-level node's effective package.</summary>
    public static string ReferrerPackageOf(MetaData node) =>
        NamingRefs.EffectivePackageOf(NamingRefs.TopLevelNodeOf(node));

    /// <summary>Resolve an object reference written on <paramref name="node"/> (owner part only).</summary>
    public static MetaData? ResolveObjectOn(MetaData node, string reference) =>
        NamingRefs.ResolveObjectRef(node.Root(), NamingRefs.SplitChildTail(reference).Owner, ReferrerPackageOf(node));

    /// <summary>
    /// The object a field's <c>extends</c> NAMES, and the member it names there. <c>id extends
    /// PurchaseRequest.id</c> names PurchaseRequest even when PurchaseRequest inherits <c>id</c> from
    /// an abstract base, which is where the resolved super node physically lives.
    /// </summary>
    private static (MetaData Owner, string Member)? ExtendedMember(MetaData f)
    {
        var reference = f.SuperRef;
        var sup = f.SuperData;
        if (reference is null || sup is null) return null;
        var (owner, tail) = NamingRefs.SplitChildTail(reference);
        if (tail.Length > 0)
        {
            var named = NamingRefs.ResolveObjectRef(f.Root(), owner, ReferrerPackageOf(f));
            if (named is not null) return (named, sup.Name);
        }
        var parent = sup.Parent;
        return parent is not null && parent.Type == TYPE_OBJECT ? (parent, sup.Name) : null;
    }

    /// <summary>The entities whose whole primary key a value object borrows, once: every primary key field
    /// of the <c>object.entity</c> is extended by exactly one field of the value. A value that borrows part
    /// of a composite key, or one key field twice, names no single row of that entity, so it borrows
    /// nothing from it.</summary>
    private static List<MetaData> BorrowedKeyEntities(MetaData value)
    {
        var counts = new List<(MetaData Owner, Dictionary<string, int> Members)>();
        foreach (var f in value.Children())
        {
            if (f.Type != TYPE_FIELD) continue;
            if (ExtendedMember(f) is not { } ext || ext.Owner.SubType != OBJECT_SUBTYPE_ENTITY) continue;
            if (!PrimaryKeyFields(ext.Owner).Contains(ext.Member)) continue;
            var idx = counts.FindIndex(c => ReferenceEquals(c.Owner, ext.Owner));
            if (idx < 0) { counts.Add((ext.Owner, new Dictionary<string, int>(StringComparer.Ordinal))); idx = counts.Count - 1; }
            var members = counts[idx].Members;
            members[ext.Member] = members.GetValueOrDefault(ext.Member) + 1;
        }
        return counts
            .Where(c => PrimaryKeyFields(c.Owner).All(k => c.Members.GetValueOrDefault(k) == 1))
            .Select(c => c.Owner).ToList();
    }

    /// <summary>The base entity of a projection: the entity its extended identity names, else the one
    /// entity its extended fields name. Null when there is none or more than one.</summary>
    public static MetaData? ProjectionBaseEntity(MetaData projection)
    {
        foreach (var id in projection.Children())
        {
            if (id.Type != TYPE_IDENTITY) continue;
            if (ExtendedMember(id) is { } ext && ext.Owner.SubType == OBJECT_SUBTYPE_ENTITY) return ext.Owner;
        }
        var owners = new List<MetaData>();
        foreach (var f in projection.Children())
        {
            if (f.Type != TYPE_FIELD) continue;
            if (ExtendedMember(f) is { } ext && ext.Owner.SubType == OBJECT_SUBTYPE_ENTITY && !owners.Contains(ext.Owner))
                owners.Add(ext.Owner);
        }
        return owners.Count == 1 ? owners[0] : null;
    }

    /// <summary>
    /// The target entity derived from an operation's shapes, or null:
    /// 1. the one entity whose whole primary key the <c>@inputRef</c> value borrows (by <c>extends</c>),
    ///    each key field once;
    /// 2. else the <c>@outputRef</c>: an entity is its own target, a projection its base entity.
    /// Whole keys of two entities, part of a key, or one key field borrowed twice derive nothing
    /// from the input.
    /// </summary>
    public static DerivedTarget? DeriveOperationTarget(MetaData op)
    {
        if (StringValue(op, OPERATION_ATTR_INPUT_REF) is { } inputRef)
        {
            var input = ResolveObjectOn(op, inputRef);
            if (input is not null && input.SubType == OBJECT_SUBTYPE_VALUE)
            {
                var borrowed = BorrowedKeyEntities(input);
                if (borrowed.Count == 1) return new DerivedTarget(borrowed[0], ViaInput: true);
            }
        }
        if (StringValue(op, OPERATION_ATTR_OUTPUT_REF) is { } outputRef)
        {
            var output = ResolveObjectOn(op, outputRef);
            if (output?.SubType == OBJECT_SUBTYPE_ENTITY) return new DerivedTarget(output, ViaInput: false);
            if (output?.SubType == OBJECT_SUBTYPE_PROJECTION)
            {
                var baseEntity = ProjectionBaseEntity(output);
                if (baseEntity is not null) return new DerivedTarget(baseEntity, ViaInput: false);
            }
        }
        return null;
    }

    /// <summary>The operation's target: the declared <c>@objectRef</c> when it names an entity, else the derived one.</summary>
    public static MetaData? OperationTarget(MetaData op)
    {
        if (StringValue(op, OPERATION_ATTR_OBJECT_REF) is { } declared)
        {
            var node = ResolveObjectOn(op, declared);
            return node?.SubType == OBJECT_SUBTYPE_ENTITY ? node : null;
        }
        return DeriveOperationTarget(op)?.Entity;
    }

    /// <summary>
    /// Whether the operation addresses one row of its target by key, so its derived path is
    /// <c>/&lt;collection&gt;/{key}/&lt;operation&gt;</c>: its input borrows the target's key, or it is a
    /// query with no input and no @many whose target comes from its output (a get by key).
    /// </summary>
    public static bool OperationIsKeyed(MetaData op)
    {
        var derived = DeriveOperationTarget(op);
        if (derived is null) return false;
        if (derived.ViaInput) return true;
        return op.SubType == OPERATION_SUBTYPE_QUERY
            && StringValue(op, OPERATION_ATTR_INPUT_REF) is null
            && op.Attr(OPERATION_ATTR_MANY) is not true;
    }
}
