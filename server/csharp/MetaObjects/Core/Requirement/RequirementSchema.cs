// Requirement attribute schemas — the per-subtype attr sets for requirement.functional
// and requirement.architectural.
//
// Colocated per ADR-0003. Mirrors the canonical spec/metamodel/requirement.json (which
// this port embeds + reads): DESCRIPTIONS are deliberately NOT hand-copied here — FR-033
// sources every description from the shared JSON via Registry.ApplySpecDescriptions, so
// the prose is byte-identical to TS by construction. Only the facets the manifest needs
// but the description pass does not carry (value type / array-ness / requiredness /
// allowedValues) are declared here.

using MetaObjects.Core.Attr;

namespace MetaObjects.Core.Requirement;

/// <summary>Attribute schemas for the requirement concern.</summary>
public static class RequirementSchema
{
    /// <summary>
    /// @status — the closed lifecycle enum, shared verbatim by both subtypes. The value
    /// set drives the ADR-0036 allowedValues facet in the registry manifest, so its
    /// declaration ORDER is part of the cross-port contract.
    /// </summary>
    private static readonly AttrSchema StatusAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_STATUS,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: true,
        AllowedValues: [.. RequirementConstants.REQUIREMENT_STATUSES]);

    /// <summary>@statement — what the capability/policy is, in one sentence. Required on both.</summary>
    private static readonly AttrSchema StatementAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_STATEMENT,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: true);

    /// <summary>@counterexample — what breaking it looks like. Required on both: a requirement
    /// that cannot be violated is a description, not a requirement.</summary>
    private static readonly AttrSchema CounterexampleAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_COUNTEREXAMPLE,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: true);

    /// <summary>@implementedBy — FQN references to the realising model nodes. Optional on
    /// both (an organisational functional level legitimately carries none).</summary>
    private static readonly AttrSchema ImplementedByAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_IMPLEMENTED_BY,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        IsArray: true);

    /// <summary>@disposition — what was DECIDED about the outstanding work, which is a
    /// different question from whether the work is done (that is @status). ABSENT means
    /// UNDECIDED, a real state and the one a review exists to find.</summary>
    private static readonly AttrSchema DispositionAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_DISPOSITION,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        AllowedValues: [.. RequirementConstants.REQUIREMENT_DISPOSITIONS]);

    /// <summary>@trackedBy — issue/ticket references for outstanding work. Free-form and
    /// never resolved: verify has no network, so nothing here is
    /// checked to exist.</summary>
    private static readonly AttrSchema TrackedByAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_TRACKED_BY,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        IsArray: true);

    /// <summary>@level on functional — REQUIRED. Levels are the object-in-focus
    /// decomposition and a functional requirement always sits at one.</summary>
    private static readonly AttrSchema LevelAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_LEVEL,
        ValueType: AttrConstants.ATTR_SUBTYPE_INT,
        Required: true);

    /// <summary>@level on architectural — OPTIONAL. Absent means a flat, object-independent
    /// policy (the original and still the default form); present opts the node into a
    /// levelled tree, e.g. a quality taxonomy over the non-functional set. Levelling is
    /// opt-in precisely so adding a taxonomy cannot invalidate existing flat policies.</summary>
    private static readonly AttrSchema OptionalLevelAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_LEVEL,
        ValueType: AttrConstants.ATTR_SUBTYPE_INT,
        Required: false);

    private static readonly IReadOnlyList<AttrSchema> FunctionalAttrs =
    [
        LevelAttr,
        StatusAttr,
        DispositionAttr,
        TrackedByAttr,
        StatementAttr,
        CounterexampleAttr,
        ImplementedByAttr,
    ];

    private static readonly IReadOnlyList<AttrSchema> ArchitecturalAttrs =
    [
        OptionalLevelAttr,
        StatusAttr,
        DispositionAttr,
        TrackedByAttr,
        StatementAttr,
        CounterexampleAttr,
        ImplementedByAttr,
    ];

    /// <summary>
    /// Attrs per requirement subtype. The sets are identical apart from @level, which is
    /// REQUIRED on functional and OPTIONAL on architectural.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> RequirementAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [RequirementConstants.REQUIREMENT_SUBTYPE_FUNCTIONAL] = FunctionalAttrs,
            [RequirementConstants.REQUIREMENT_SUBTYPE_ARCHITECTURAL] = ArchitecturalAttrs,
        };
}
