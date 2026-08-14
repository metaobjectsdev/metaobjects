// MetaRequirement — concrete node class for type=requirement nodes.
// Both registered subtypes (functional / architectural) are backed by this one class.
//
// Ported 1:1 from
// server/typescript/packages/metadata/src/core/requirement/meta-requirement.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>requirement.*</c> nodes.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
// ADR-0039: every getter below uses the RESOLVING Attr() accessor — a requirement that
// `extends` an abstract parent inherits its properties.
public class MetaRequirement(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>What the product does for a user — checked by EXISTENCE.</summary>
    public bool IsFunctional() => SubType == REQUIREMENT_SUBTYPE_FUNCTIONAL;

    /// <summary>How the system is built — checked by UNIVERSALITY (the opposite polarity).</summary>
    public bool IsArchitectural() => SubType == REQUIREMENT_SUBTYPE_ARCHITECTURAL;

    /// <summary>
    /// 1 solution · 2 segment · 3 service · 4 object · 5 member. Architectural
    /// requirements carry none — they are object-independent by definition.
    /// ADR-0039: resolving — @level may be inherited via extends.
    /// </summary>
    public int? Level
    {
        get
        {
            // An `int`-typed attr arrives as long OR int (ValueMatchesType accepts both).
            var v = Attr(REQUIREMENT_ATTR_LEVEL);
            return v switch
            {
                int i => i,
                long l => (int)l,
                _ => null,
            };
        }
    }

    /// <summary>
    /// The lifecycle status (a closed enum: live / partial / abandoned / superseded).
    /// ADR-0039: resolving — inheritable via extends.
    /// </summary>
    public string? Status => Attr(REQUIREMENT_ATTR_STATUS) as string;

    /// <summary>
    /// FQN references to the model nodes realising this requirement.
    /// ADR-0039: resolving — inheritable via extends.
    /// </summary>
    public IReadOnlyList<string> ImplementedBy
    {
        get
        {
            var v = Attr(REQUIREMENT_ATTR_IMPLEMENTED_BY);
            return v is IReadOnlyList<string> list ? list : [];
        }
    }

    /// <summary>
    /// Names of the tests proving the behaviour. <c>verify</c> checks each exists and is
    /// not skipped; it never runs them.
    /// ADR-0039: resolving — inheritable via extends.
    /// </summary>
    public IReadOnlyList<string> VerifiedBy
    {
        get
        {
            var v = Attr(REQUIREMENT_ATTR_VERIFIED_BY);
            return v is IReadOnlyList<string> list ? list : [];
        }
    }

    /// <summary>
    /// What was DECIDED about the outstanding work — a different question from whether the
    /// work is done, which is what <c>@status</c> answers. <c>null</c> means UNDECIDED, a
    /// real state and the one a review exists to find.
    /// ADR-0039: resolving — inheritable via extends.
    /// </summary>
    public string? Disposition => Attr(REQUIREMENT_ATTR_DISPOSITION) as string;

    /// <summary>
    /// Issue/ticket references for outstanding work. Free-form and NEVER resolved —
    /// <c>verify</c> has no network, so unlike <c>@verifiedBy</c> nothing here is checked
    /// to exist.
    /// ADR-0039: resolving — inheritable via extends.
    /// </summary>
    public IReadOnlyList<string> TrackedBy
    {
        get
        {
            var v = Attr(REQUIREMENT_ATTR_TRACKED_BY);
            return v is IReadOnlyList<string> list ? list : [];
        }
    }

    /// <summary>
    /// Intended but not built. Its nodes may legitimately not exist yet, and it must NOT
    /// count toward object coverage — planning a capability cannot be allowed to silence
    /// the warning that nothing implements it.
    /// </summary>
    public bool IsPlanned() => Status == REQUIREMENT_STATUS_PLANNED;

    /// <summary>True when there is outstanding work, so a <c>@disposition</c> says something.</summary>
    public bool HasOutstandingWork()
    {
        string? status = Status;
        return status is not null
            && REQUIREMENT_STATUSES_WITH_OUTSTANDING_WORK.Contains(status);
    }

    /// <summary>
    /// True when this requirement is permitted to reference the model at all.
    ///
    /// An UNLEVELLED architectural requirement always may — its claim set is the whole
    /// point, and that is the original flat form. Once a level is PRESENT the node has
    /// opted into a tree, and the link floor applies to it exactly as it does to a
    /// functional one, so an "ISO 25010 Security" grouping node cannot quietly start
    /// naming entities. Levelling is the opt-in; enforcing the floor unconditionally would
    /// have broken every existing flat policy.
    /// </summary>
    public bool MayReferenceModel()
    {
        int? level = Level;
        if (level is null) return IsArchitectural();
        return level.Value >= REQUIREMENT_LINK_FLOOR_LEVEL;
    }

    /// <summary>
    /// True when a dangling <c>@implementedBy</c> is an ERROR rather than expected.
    /// An abandoned or superseded requirement's nodes are supposed to be gone.
    /// </summary>
    public bool RequiresLiveNodes()
    {
        string? status = Status;
        return status is not null
            && REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES.Contains(status);
    }
}
