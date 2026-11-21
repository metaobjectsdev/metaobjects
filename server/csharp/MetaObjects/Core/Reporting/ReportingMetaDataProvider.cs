// The metaobjects-reporting pack: dimension.*, measure.*, segment.filter and object.report
// (FR-044). Its own provider so a project can leave it out; it is in the default bundle, so
// every existing model loads unchanged. Types and attrs are declared in the embedded
// reporting.json, whose `extends` also admits the vocabulary as children of object.entity
// and adds @segment to origin.aggregate / origin.first. Mirrors the TS reportingProvider.

using MetaObjects.Core.Object;
using MetaObjects.Meta;
using MetaObjects.Registry.Spec;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Core.Reporting;

/// <summary>The reporting pack provider (<c>metaobjects-reporting</c>).</summary>
public sealed class ReportingMetaDataProvider : IMetaDataTypeProvider
{
    /// <summary>The shared singleton — composed into the default registry.</summary>
    public static readonly IMetaDataTypeProvider Instance = new ReportingMetaDataProvider();

    /// <summary>The provider id — matches reporting.json's <c>"provider"</c> field.</summary>
    public const string ProviderId = "metaobjects-reporting";

    private static readonly Lazy<SpecMetamodelReader> Reader = new(SpecMetamodelReader.Load);

    public string Id => ProviderId;

    public string? Description =>
        "Reporting: dimension / measure / segment and object.report, compiled to a read-only view.";

    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        void Reg(string type, string subType, string label, List<AttrSchema> attrs, Func<TypeId, string, MetaData> factory) =>
            registry.Register(new TypeDefinition(
                typeId: new TypeId(type, subType),
                description: $"{label} ({subType})",
                childRules: [new ChildRule(TYPE_ATTR, CHILD_RULE_WILDCARD, CHILD_RULE_WILDCARD)],
                factory: factory,
                attributes: attrs));

        foreach (string subType in ReportingConstants.DIMENSION_SUBTYPES)
            Reg(TYPE_DIMENSION, subType, "Dimension", ReportingSchema.DimensionAttrsMap[subType].ToList(), (tid, n) => new MetaDimension(tid, n));
        foreach (string subType in ReportingConstants.MEASURE_SUBTYPES)
            Reg(TYPE_MEASURE, subType, "Measure", ReportingSchema.MeasureAttrsMap[subType].ToList(), (tid, n) => new MetaMeasure(tid, n));
        foreach (string subType in ReportingConstants.SEGMENT_SUBTYPES)
            Reg(TYPE_SEGMENT, subType, "Segment", ReportingSchema.SegmentAttrsMap[subType].ToList(), (tid, n) => new MetaSegment(tid, n));

        // object.report extends the base another provider registered: fold that base's
        // attrs and child rules in (the strict pass later rebuilds the structural rules
        // from the spec, which composes the same base).
        TypeDefinition objectBase = registry.Find(TYPE_OBJECT, SUBTYPE_BASE)
            ?? throw new InvalidOperationException("metaobjects-reporting: object.base is not registered");
        registry.Register(new TypeDefinition(
            typeId: new TypeId(TYPE_OBJECT, ObjectConstants.OBJECT_SUBTYPE_REPORT),
            description: $"Object/entity ({ObjectConstants.OBJECT_SUBTYPE_REPORT})",
            childRules: objectBase.ChildRules.ToList(),
            factory: (tid, n) => new MetaObject(tid, n),
            attributes: [.. objectBase.Attributes, .. ReportingSchema.ReportAttrs, ObjectSchema.CollectionNameAttr]));

        registry.ApplyProviderExtends(
            Reader.Value,
            ProviderId,
            new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal));
    }
}
