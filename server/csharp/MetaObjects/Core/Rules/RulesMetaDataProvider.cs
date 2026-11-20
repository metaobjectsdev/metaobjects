// The metaobjects-rules pack: the declared API surface (api / operation / binding) and
// lifecycle moves (transition, a child of field.enum). ADR-0066, experimental.
//
// It is its OWN provider rather than part of metaobjects-core-types, so a project can
// leave it out. It is in the default bundle (CoreTypes.LibraryProviders), so every
// existing model loads unchanged. The pack owns its types AND the child rules that admit
// them on types core owns (metadata.root holds an api; field.enum holds a transition):
// both ride in api.json / transition.json `extends`. Compose the pack out and the types
// are unknown. The cross-node rules (Loader/ValidationPasses.Rules.cs) only fire on
// rules nodes. Mirrors the TS rulesProvider.

using MetaObjects.Core.Api;
using MetaObjects.Core.Transition;
using MetaObjects.Meta;
using MetaObjects.Registry.Spec;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Core.Rules;

/// <summary>The business-rules pack provider (<c>metaobjects-rules</c>).</summary>
public sealed class RulesMetaDataProvider : IMetaDataTypeProvider
{
    /// <summary>The shared singleton — composed into the default registry.</summary>
    public static readonly IMetaDataTypeProvider Instance = new RulesMetaDataProvider();

    /// <summary>The provider id — matches the <c>"provider"</c> field of api.json / transition.json.</summary>
    public const string ProviderId = "metaobjects-rules";

    private static readonly Lazy<SpecMetamodelReader> Reader = new(SpecMetamodelReader.Load);

    public string Id => ProviderId;

    public string? Description =>
        "Business rules (ADR-0066, experimental): the declared API surface (api / operation / binding) and lifecycle moves (transition on a field.enum).";

    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        // One class per type; the subtype carries no behaviour of its own. Descriptions, the
        // structural child graph and cardinalities come from api.json / transition.json via
        // ApplySpecDescriptions.
        void Reg(string type, string subType, List<AttrSchema> attrs, Func<TypeId, string, MetaData> factory) =>
            registry.Register(new TypeDefinition(
                typeId: new TypeId(type, subType),
                description: $"{type} ({subType})",
                childRules: [new ChildRule(TYPE_ATTR, CHILD_RULE_WILDCARD, CHILD_RULE_WILDCARD)],
                factory: factory,
                attributes: attrs));

        Reg(TYPE_API, SUBTYPE_BASE, [], (tid, n) => new MetaApi(tid, n));
        Reg(TYPE_API, ApiConstants.API_SUBTYPE_OPERATIONAL, [], (tid, n) => new MetaApi(tid, n));
        Reg(TYPE_OPERATION, SUBTYPE_BASE, [.. ApiSchema.OperationBaseAttrs], (tid, n) => new MetaOperation(tid, n));
        Reg(TYPE_OPERATION, ApiConstants.OPERATION_SUBTYPE_COMMAND, [.. ApiSchema.CommandAttrs], (tid, n) => new MetaOperation(tid, n));
        Reg(TYPE_OPERATION, ApiConstants.OPERATION_SUBTYPE_QUERY, [.. ApiSchema.QueryAttrs], (tid, n) => new MetaOperation(tid, n));
        Reg(TYPE_BINDING, SUBTYPE_BASE, [], (tid, n) => new MetaBinding(tid, n));
        Reg(TYPE_BINDING, ApiConstants.BINDING_SUBTYPE_REST, [.. ApiSchema.RestBindingAttrs], (tid, n) => new MetaBinding(tid, n));
        Reg(TYPE_TRANSITION, SUBTYPE_BASE, [.. TransitionSchema.TransitionBaseAttrs], (tid, n) => new MetaTransition(tid, n));
        Reg(TYPE_TRANSITION, TransitionConstants.TRANSITION_SUBTYPE_ACTION, [.. TransitionSchema.ActionAttrs], (tid, n) => new MetaTransition(tid, n));

        // The child rules that admit the pack's types on core types.
        registry.ApplyProviderExtends(
            Reader.Value,
            ProviderId,
            new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal));
    }
}
