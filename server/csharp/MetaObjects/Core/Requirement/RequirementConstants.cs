// Requirement concern constants — type name, subtypes, attr keys, statuses, levels.
//
// Colocated per ADR-0003. Mirrors
// server/typescript/packages/metadata/src/core/requirement/requirement-constants.ts.
//
// `requirement.*` is REGISTERED metamodel vocabulary (requirements-as-metadata ruling
// amendment 3): the capability ledger IS a metadata model, so it is declared in
// `metaobjects/` beside the entities it describes and validated by the loader like
// everything else — not hand-parsed from a side file.

namespace MetaObjects.Core.Requirement;

/// <summary>
/// Requirement concern constants — the two requirement subtypes, their attr keys, the
/// closed status enum, and the level vocabulary.
/// </summary>
public static class RequirementConstants
{
    // -----------------------------------------------------------------------
    // Subtypes (2) — the axis is CHECK POLARITY, a genuine behaviour difference
    // and therefore a subtype under ADR-0037 §2:
    //   functional    -> EXISTENCE:    fails when nothing implements it
    //   architectural -> UNIVERSALITY: fails when something violates it
    // -----------------------------------------------------------------------

    /// <summary>What the product does for a user — checked by EXISTENCE.</summary>
    public const string REQUIREMENT_SUBTYPE_FUNCTIONAL = "functional";

    /// <summary>How the system is built — checked by UNIVERSALITY (the opposite polarity).</summary>
    public const string REQUIREMENT_SUBTYPE_ARCHITECTURAL = "architectural";

    public static readonly string[] REQUIREMENT_SUBTYPES =
    [
        REQUIREMENT_SUBTYPE_FUNCTIONAL,
        REQUIREMENT_SUBTYPE_ARCHITECTURAL,
    ];

    // -----------------------------------------------------------------------
    // Attrs
    // -----------------------------------------------------------------------

    /// <summary>1 solution · 2 segment (app/library) · 3 service · 4 object · 5 member.</summary>
    public const string REQUIREMENT_ATTR_LEVEL = "level";
    public const string REQUIREMENT_ATTR_STATUS = "status";
    public const string REQUIREMENT_ATTR_DISPOSITION = "disposition";
    public const string REQUIREMENT_ATTR_TRACKED_BY = "trackedBy";
    public const string REQUIREMENT_ATTR_STATEMENT = "statement";
    public const string REQUIREMENT_ATTR_VIOLATION = "violation";
    public const string REQUIREMENT_ATTR_IMPLEMENTED_BY = "implementedBy";

    // -----------------------------------------------------------------------
    // Status — a closed enum, enforced by the registry via allowedValues.
    // -----------------------------------------------------------------------

    /// <summary>Intended but not built. Its references may legitimately dangle, and it
    /// never contributes to object coverage — planning a capability must not silence the
    /// warning that nothing implements it.</summary>
    public const string REQUIREMENT_STATUS_PLANNED = "planned";

    public const string REQUIREMENT_STATUS_LIVE = "live";
    public const string REQUIREMENT_STATUS_PARTIAL = "partial";

    /// <summary>
    /// The closed status set, in DECLARATION order — the manifest emits
    /// <c>allowedValues</c> in this order, so it is part of the cross-port contract
    /// (never sorted).
    /// </summary>
    public static readonly string[] REQUIREMENT_STATUSES =
    [
        REQUIREMENT_STATUS_PLANNED,
        REQUIREMENT_STATUS_LIVE,
        REQUIREMENT_STATUS_PARTIAL,
    ];

    /// <summary>
    /// Statuses whose implementing nodes are supposed to still exist. A dangling
    /// <c>@implementedBy</c> on one of these means the model moved and the requirement is
    /// stale; on the other two the nodes are supposed to be GONE, which is the whole
    /// point of the entry. The asymmetry inverts as a pair.
    /// </summary>
    public static readonly string[] REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES =
    [
        REQUIREMENT_STATUS_LIVE,
        REQUIREMENT_STATUS_PARTIAL,
    ];

    /// <summary>
    /// Statuses with outstanding work, so a <c>@disposition</c> is meaningful on them. On
    /// any other status the decision IS the status, and recording a second one can only
    /// agree with it or contradict it.
    /// </summary>
    public static readonly string[] REQUIREMENT_STATUSES_WITH_OUTSTANDING_WORK =
    [
        REQUIREMENT_STATUS_PLANNED,
        REQUIREMENT_STATUS_PARTIAL,
    ];

    // -----------------------------------------------------------------------
    // Disposition — what was DECIDED about the outstanding work. Orthogonal to
    // status, which says whether the work is done. ABSENT means UNDECIDED, and
    // that is the state a review exists to find; collapsing it into the status
    // enum would make "there is a gap" and "we chose to live with it" one fact.
    // -----------------------------------------------------------------------

    public const string REQUIREMENT_DISPOSITION_ACCEPTED = "accepted";
    public const string REQUIREMENT_DISPOSITION_DEFERRED = "deferred";

    /// <summary>The closed disposition set, in DECLARATION order (see REQUIREMENT_STATUSES
    /// for why order is contractual).</summary>
    public static readonly string[] REQUIREMENT_DISPOSITIONS =
    [
        REQUIREMENT_DISPOSITION_ACCEPTED,
        REQUIREMENT_DISPOSITION_DEFERRED,
    ];

    // -----------------------------------------------------------------------
    // Levels — organisational above the link floor, model-referencing at or below.
    // -----------------------------------------------------------------------

    public const int REQUIREMENT_LEVEL_SOLUTION = 1;
    public const int REQUIREMENT_LEVEL_SEGMENT = 2;
    public const int REQUIREMENT_LEVEL_SERVICE = 3;
    public const int REQUIREMENT_LEVEL_OBJECT = 4;
    public const int REQUIREMENT_LEVEL_MEMBER = 5;

    /// <summary>
    /// The lowest level that may reference the model. L1-L3 are organisational and
    /// carrying <c>@implementedBy</c> there is an error.
    /// </summary>
    public const int REQUIREMENT_LINK_FLOOR_LEVEL = REQUIREMENT_LEVEL_OBJECT;

    public const int REQUIREMENT_MIN_LEVEL = REQUIREMENT_LEVEL_SOLUTION;
    public const int REQUIREMENT_MAX_LEVEL = REQUIREMENT_LEVEL_MEMBER;
}
