// The metaobjects-requirements pack: requirement.functional / requirement.architectural.
// Its own provider so a project can leave it out; it is in the default bundle, so every
// existing model loads unchanged. Types and attrs are declared in the embedded
// requirement.json, whose `extends` admits `requirement` under metadata.root.
// Mirrors the TS requirementsProvider.

using MetaObjects.Meta;
using MetaObjects.Registry.Spec;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Core.Requirement;

/// <summary>The requirements pack provider (<c>metaobjects-requirements</c>).</summary>
public sealed class RequirementsMetaDataProvider : IMetaDataTypeProvider
{
    /// <summary>The shared singleton — composed into the default registry.</summary>
    public static readonly IMetaDataTypeProvider Instance = new RequirementsMetaDataProvider();

    /// <summary>The provider id — matches requirement.json's <c>"provider"</c> field.</summary>
    public const string ProviderId = "metaobjects-requirements";

    private static readonly Lazy<SpecMetamodelReader> Reader = new(SpecMetamodelReader.Load);

    public string Id => ProviderId;

    public string? Description =>
        "Requirements: requirement.functional (existence) and requirement.architectural (universality).";

    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        // Hierarchy IS nesting: BOTH subtypes may nest requirement children. Structural
        // cardinality comes from requirement.json via ApplySpecDescriptions.
        foreach (string subType in RequirementConstants.REQUIREMENT_SUBTYPES)
        {
            registry.Register(new TypeDefinition(
                typeId: new TypeId(TYPE_REQUIREMENT, subType),
                description: $"Requirement ({subType})",
                childRules:
                [
                    new ChildRule(TYPE_ATTR, CHILD_RULE_WILDCARD, CHILD_RULE_WILDCARD),
                    new ChildRule(TYPE_REQUIREMENT, CHILD_RULE_WILDCARD, CHILD_RULE_WILDCARD),
                ],
                factory: (tid, n) => new MetaRequirement(tid, n),
                attributes: RequirementSchema.RequirementAttrsMap.TryGetValue(subType, out var reqAttrs)
                    ? reqAttrs.ToList()
                    : []));
        }

        registry.ApplyProviderExtends(
            Reader.Value,
            ProviderId,
            new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal));
    }
}
