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
    /// True when this requirement is permitted to reference the model at all.
    /// Architectural requirements always may (their claim set is the point); functional
    /// ones only at or below the link floor, so the organisational tiers stay
    /// organisational.
    /// </summary>
    public bool MayReferenceModel()
    {
        if (IsArchitectural()) return true;
        int? level = Level;
        return level is not null && level.Value >= REQUIREMENT_LINK_FLOOR_LEVEL;
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
