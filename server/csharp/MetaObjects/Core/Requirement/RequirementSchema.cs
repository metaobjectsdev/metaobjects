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

    /// <summary>@violation — what breaking it looks like. Required on both: a requirement
    /// that cannot be violated is a description, not a requirement.</summary>
    private static readonly AttrSchema ViolationAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_VIOLATION,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: true);

    /// <summary>@implementedBy — FQN references to the realising model nodes. Optional on
    /// both (an organisational functional level legitimately carries none).</summary>
    private static readonly AttrSchema ImplementedByAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_IMPLEMENTED_BY,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        IsArray: true);

    /// <summary>@supersededBy — the requirement that replaced this one. Optional on both.</summary>
    private static readonly AttrSchema SupersededByAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_SUPERSEDED_BY,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false);

    /// <summary>@level — functional-only: levels come from object-in-focus decomposition,
    /// and an architectural requirement is object-independent by definition.</summary>
    private static readonly AttrSchema LevelAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_LEVEL,
        ValueType: AttrConstants.ATTR_SUBTYPE_INT,
        Required: true);

    /// <summary>@verifiedBy — functional-only: an architectural requirement's proof is the
    /// universality check over the model, not a named behaviour test.</summary>
    private static readonly AttrSchema VerifiedByAttr = new AttrSchema(
        Name: RequirementConstants.REQUIREMENT_ATTR_VERIFIED_BY,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        IsArray: true);

    private static readonly IReadOnlyList<AttrSchema> FunctionalAttrs =
    [
        LevelAttr,
        StatusAttr,
        StatementAttr,
        ViolationAttr,
        ImplementedByAttr,
        VerifiedByAttr,
        SupersededByAttr,
    ];

    private static readonly IReadOnlyList<AttrSchema> ArchitecturalAttrs =
    [
        StatusAttr,
        StatementAttr,
        ViolationAttr,
        ImplementedByAttr,
        SupersededByAttr,
    ];

    /// <summary>
    /// Attrs per requirement subtype. functional adds @level + @verifiedBy; architectural
    /// carries neither.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> RequirementAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [RequirementConstants.REQUIREMENT_SUBTYPE_FUNCTIONAL] = FunctionalAttrs,
            [RequirementConstants.REQUIREMENT_SUBTYPE_ARCHITECTURAL] = ArchitecturalAttrs,
        };
}
