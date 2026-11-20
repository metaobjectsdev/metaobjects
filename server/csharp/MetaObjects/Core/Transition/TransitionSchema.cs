// Attribute schemas for transition.* (ADR-0066). Mirrors spec/metamodel/transition.json;
// descriptions come from the shared JSON via Registry.ApplySpecDescriptions.

using MetaObjects.Core.Attr;

namespace MetaObjects.Core.Transition;

/// <summary>Attribute schemas for transition.*.</summary>
public static class TransitionSchema
{
    /// <summary>The attrs every transition shares (transition.base).</summary>
    public static readonly IReadOnlyList<AttrSchema> TransitionBaseAttrs =
    [
        new(Name: TransitionConstants.TRANSITION_ATTR_PERMISSION, ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: false),
        new(Name: TransitionConstants.TRANSITION_ATTR_PUBLIC, ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN, Required: false),
    ];

    public static readonly IReadOnlyList<AttrSchema> ActionAttrs =
    [
        .. TransitionBaseAttrs,
        new(Name: TransitionConstants.TRANSITION_ATTR_FROM, ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: true, IsArray: true),
        new(Name: TransitionConstants.TRANSITION_ATTR_TO, ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: true),
        new(Name: TransitionConstants.TRANSITION_ATTR_CONDITION, ValueType: AttrConstants.ATTR_SUBTYPE_EXPRESSION, Required: false),
    ];
}
