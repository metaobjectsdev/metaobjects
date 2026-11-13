// Lifecycle constants (ADR-0063) — the `transition` type, its subtype and attrs.
//
// A lifecycle has no vocabulary of its own: it is a `field.enum` with at least one
// `transition.action` child. Its states are the enum's @values, its initial state the
// enum's @default, its terminal states the members no transition leaves.
// Mirrors server/typescript/packages/metadata/src/core/transition/transition-constants.ts.

namespace MetaObjects.Core.Transition;

/// <summary>Constants of the lifecycle concern.</summary>
public static class TransitionConstants
{
    /// <summary>A move made by an operation.</summary>
    public const string TRANSITION_SUBTYPE_ACTION = "action";
    public static readonly string[] TRANSITION_SUBTYPES = [TRANSITION_SUBTYPE_ACTION];

    /// <summary>The states a move may start from (members of the parent enum's @values).</summary>
    public const string TRANSITION_ATTR_FROM = "from";
    /// <summary>The state a move ends in.</summary>
    public const string TRANSITION_ATTR_TO = "to";
    /// <summary>A guard over the entity's own fields (the attr.expression grammar).</summary>
    public const string TRANSITION_ATTR_CONDITION = "condition";
    public const string TRANSITION_ATTR_PERMISSION = "permission";
    public const string TRANSITION_ATTR_PUBLIC = "public";
}
