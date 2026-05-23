// CoreTypes — ported 1:1 from typescript/packages/metadata/src/core-types.ts
//
// Registers the core metaobjects metamodel vocabulary (metadata, object, field,
// attr, validator, view, layout, source, origin, identity, relationship) into a
// TypeRegistry.  A single provider class is exposed as CoreTypes.CoreTypesProvider.
//
// NOTE: dbProvider is intentionally NOT included here.  The conformance corpus
// loads fixtures with provider id "metaobjects-core-types" only; the DB-domain
// extension lives in a separate (future) provider.

using MetaObjects.Meta;
using MetaObjects.Core.Object;
using MetaObjects.Core.Field;
using MetaObjects.Core.Validator;
using MetaObjects.Core.Identity;
using MetaObjects.Core.Relationship;
using MetaObjects.Persistence.Origin;
using MetaObjects.Presentation.View;
using MetaObjects.Presentation.Layout;

namespace MetaObjects;

/// <summary>
/// The core metaobjects metamodel provider.
/// Ported 1:1 from <c>typescript/packages/metadata/src/core-types.ts</c>.
/// </summary>
public static class CoreTypes
{
    // -------------------------------------------------------------------------
    // Public entry point
    // -------------------------------------------------------------------------

    /// <summary>
    /// The single provider instance that registers the full core metamodel
    /// vocabulary.  Pass it to <see cref="Provider.ComposeRegistry"/> to obtain
    /// a populated <see cref="TypeRegistry"/>.
    /// </summary>
    public static readonly IMetaDataTypeProvider CoreTypesProvider = new CoreTypesProviderImpl();

    // -------------------------------------------------------------------------
    // wildcard helper — builds a ChildRule that matches any subType and name
    // -------------------------------------------------------------------------

    private static ChildRule Wildcard(string childType) =>
        new ChildRule(
            ChildType: childType,
            ChildSubType: CHILD_RULE_WILDCARD,
            ChildName: CHILD_RULE_WILDCARD);

    // -------------------------------------------------------------------------
    // def() helper — builds a TypeDefinition with the factory wired up
    // -------------------------------------------------------------------------

    private static TypeDefinition Def(
        string type,
        string subType,
        string description,
        List<ChildRule> childRules,
        Func<TypeId, string, MetaData> factory,
        List<AttrSchema> attributes,
        DataType? dataType = null)
    {
        Func<TypeId, string, MetaData> wrappedFactory = (typeId, name) =>
        {
            MetaData node = factory(typeId, name);
            if (dataType is not null)
            {
                node.SetDataType(dataType.Value);
            }
            return node;
        };

        return new TypeDefinition(
            typeId: new TypeId(type, subType),
            description: description,
            childRules: childRules,
            factory: wrappedFactory,
            attributes: attributes,
            dataType: dataType);
    }

    // -------------------------------------------------------------------------
    // Field subtype → DataType map
    // -------------------------------------------------------------------------

    private static readonly Dictionary<string, DataType> FieldDataType = new()
    {
        [SUBTYPE_BASE]            = DataType.String,
        [FIELD_SUBTYPE_STRING]    = DataType.String,
        [FIELD_SUBTYPE_CLASS]     = DataType.String,
        [FIELD_SUBTYPE_INT]       = DataType.Int,
        [FIELD_SUBTYPE_SHORT]     = DataType.Int,
        [FIELD_SUBTYPE_BYTE]      = DataType.Int,
        [FIELD_SUBTYPE_LONG]      = DataType.Long,
        [FIELD_SUBTYPE_CURRENCY]  = DataType.Long,
        [FIELD_SUBTYPE_DOUBLE]    = DataType.Double,
        [FIELD_SUBTYPE_FLOAT]     = DataType.Double,
        [FIELD_SUBTYPE_DECIMAL]   = DataType.Double,
        [FIELD_SUBTYPE_BOOLEAN]   = DataType.Boolean,
        [FIELD_SUBTYPE_DATE]      = DataType.Date,
        [FIELD_SUBTYPE_TIME]      = DataType.Date,
        [FIELD_SUBTYPE_TIMESTAMP] = DataType.Date,
        [FIELD_SUBTYPE_OBJECT]    = DataType.Object,
    };

    // -------------------------------------------------------------------------
    // Attr subtype → DataType map
    // -------------------------------------------------------------------------

    private static readonly Dictionary<string, DataType> AttrDataType = new()
    {
        [SUBTYPE_BASE]               = DataType.String,
        [ATTR_SUBTYPE_STRING]        = DataType.String,
        [ATTR_SUBTYPE_CLASS]         = DataType.String,
        [ATTR_SUBTYPE_STRINGARRAY]   = DataType.String,
        [ATTR_SUBTYPE_INT]           = DataType.Int,
        [ATTR_SUBTYPE_LONG]          = DataType.Long,
        [ATTR_SUBTYPE_DOUBLE]        = DataType.Double,
        [ATTR_SUBTYPE_BOOLEAN]       = DataType.Boolean,
        [ATTR_SUBTYPE_PROPERTIES]    = DataType.Object,
        [ATTR_SUBTYPE_FILTER]        = DataType.Object,
    };

    // -------------------------------------------------------------------------
    // dataTypeFor — fails loudly if the map omits a subtype
    // -------------------------------------------------------------------------

    private static DataType DataTypeFor(
        Dictionary<string, DataType> map,
        string subType,
        string kind)
    {
        if (!map.TryGetValue(subType, out DataType dt))
        {
            throw new InvalidOperationException(
                $"registerCoreTypes: no DataType mapped for {kind} subtype \"{subType}\"");
        }
        return dt;
    }

    // -------------------------------------------------------------------------
    // Validator subtype → concrete factory
    // -------------------------------------------------------------------------

    private static readonly Dictionary<string, Func<TypeId, string, MetaData>> ValidatorClassMap = new()
    {
        [VALIDATOR_SUBTYPE_REQUIRED] = (tid, n) => new MetaRequiredValidator(tid, n),
        [VALIDATOR_SUBTYPE_LENGTH]   = (tid, n) => new MetaLengthValidator(tid, n),
        [VALIDATOR_SUBTYPE_REGEX]    = (tid, n) => new MetaRegexValidator(tid, n),
        [VALIDATOR_SUBTYPE_NUMERIC]  = (tid, n) => new MetaNumericValidator(tid, n),
        [VALIDATOR_SUBTYPE_ARRAY]    = (tid, n) => new MetaArrayValidator(tid, n),
    };

    // -------------------------------------------------------------------------
    // Identity subtype → concrete factory
    // -------------------------------------------------------------------------

    private static readonly Dictionary<string, Func<TypeId, string, MetaData>> IdentityClassMap = new()
    {
        [IDENTITY_SUBTYPE_PRIMARY]   = (tid, n) => new MetaPrimaryIdentity(tid, n),
        [IDENTITY_SUBTYPE_SECONDARY] = (tid, n) => new MetaSecondaryIdentity(tid, n),
    };

    // -------------------------------------------------------------------------
    // Origin subtype → concrete factory
    // -------------------------------------------------------------------------

    private static readonly Dictionary<string, Func<TypeId, string, MetaData>> OriginClassMap = new()
    {
        [ORIGIN_SUBTYPE_PASSTHROUGH] = (tid, n) => new MetaPassthroughOrigin(tid, n),
        [ORIGIN_SUBTYPE_AGGREGATE]   = (tid, n) => new MetaAggregateOrigin(tid, n),
    };

    // -------------------------------------------------------------------------
    // registerCoreTypeDefs — registers all (type, subType) pairs
    // -------------------------------------------------------------------------

    private static void RegisterCoreTypeDefs(TypeRegistry registry)
    {
        // metadata — 1 subtype (the document root: metadata.root)
        registry.Register(
            Def(
                TYPE_METADATA,
                SUBTYPE_ROOT,
                "Root metadata document",
                [
                    Wildcard(TYPE_OBJECT),
                    Wildcard(TYPE_FIELD),
                    Wildcard(TYPE_ATTR),
                    Wildcard(TYPE_VALIDATOR),
                ],
                (tid, n) => new MetaRoot(tid, n),
                []));

        // object — 3 subtypes (base, entity, value)
        List<ChildRule> objectRules =
        [
            Wildcard(TYPE_FIELD),
            Wildcard(TYPE_IDENTITY),
            Wildcard(TYPE_RELATIONSHIP),
            Wildcard(TYPE_VALIDATOR),
            Wildcard(TYPE_LAYOUT),
            Wildcard(TYPE_SOURCE),
            Wildcard(TYPE_ATTR),
        ];
        foreach (string subType in OBJECT_SUBTYPES)
        {
            registry.Register(
                Def(
                    TYPE_OBJECT,
                    subType,
                    $"Object/entity ({subType})",
                    new List<ChildRule>(objectRules),
                    (tid, n) => new MetaObject(tid, n),
                    ObjectSchema.ObjectAttrs.ToList()));
        }

        // field — 16 subtypes (base + 15)
        List<ChildRule> fieldRules =
        [
            Wildcard(TYPE_VALIDATOR),
            Wildcard(TYPE_VIEW),
            Wildcard(TYPE_ATTR),
            Wildcard(TYPE_ORIGIN),
        ];
        foreach (string subType in FIELD_SUBTYPES)
        {
            List<AttrSchema> fieldAttrs =
                subType == FIELD_SUBTYPE_CURRENCY
                    ? [.. FieldSchema.CommonFieldAttrs, FieldSchema.CurrencyFieldAttr]
                    : FieldSchema.CommonFieldAttrs.ToList();

            registry.Register(
                Def(
                    TYPE_FIELD,
                    subType,
                    $"Field of type {subType}",
                    new List<ChildRule>(fieldRules),
                    (tid, n) => new MetaField(tid, n),
                    fieldAttrs,
                    DataTypeFor(FieldDataType, subType, "field")));
        }

        // attr — 9 subtypes (base + 8), no children allowed
        foreach (string subType in ATTR_SUBTYPES)
        {
            registry.Register(
                Def(
                    TYPE_ATTR,
                    subType,
                    $"Attribute of type {subType}",
                    [],
                    (tid, n) => new MetaAttr(tid, n),
                    [],
                    DataTypeFor(AttrDataType, subType, "attr")));
        }

        // validator — 6 subtypes (base + 5); dispatch to subtype-specific class
        List<ChildRule> validatorRules = [Wildcard(TYPE_ATTR)];
        foreach (string subType in VALIDATOR_SUBTYPES)
        {
            Func<TypeId, string, MetaData> nodeFactory =
                ValidatorClassMap.TryGetValue(subType, out var vf)
                    ? vf
                    : (tid, n) => new MetaValidator(tid, n);

            IReadOnlyList<AttrSchema> validatorAttrs =
                ValidatorSchema.ValidatorAttrsMap.TryGetValue(subType, out var va)
                    ? va
                    : [];

            registry.Register(
                Def(
                    TYPE_VALIDATOR,
                    subType,
                    $"Validator ({subType})",
                    new List<ChildRule>(validatorRules),
                    nodeFactory,
                    validatorAttrs.ToList()));
        }

        // view — 14 subtypes (base + 13); only attr children
        foreach (string subType in VIEW_SUBTYPES)
        {
            List<AttrSchema> viewAttrs =
                subType == VIEW_SUBTYPE_CURRENCY
                    ? ViewSchema.CurrencyViewAttrs.ToList()
                    : [];

            registry.Register(
                Def(
                    TYPE_VIEW,
                    subType,
                    $"View ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    (tid, n) => new MetaView(tid, n),
                    viewAttrs));
        }

        // layout — 2 subtypes (base + dataGrid); only attr children
        foreach (string subType in LAYOUT_SUBTYPES)
        {
            List<AttrSchema> layoutAttrs =
                subType == LAYOUT_SUBTYPE_DATA_GRID
                    ? LayoutSchema.DataGridLayoutAttrs.ToList()
                    : [];

            registry.Register(
                Def(
                    TYPE_LAYOUT,
                    subType,
                    $"Layout ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    (tid, n) => new MetaLayout(tid, n),
                    layoutAttrs));
        }

        // source — 3 subtypes (base + dbTable + dbView); only attr children
        foreach (string subType in SOURCE_SUBTYPES)
        {
            registry.Register(
                Def(
                    TYPE_SOURCE,
                    subType,
                    $"Source ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    (tid, n) => new MetaSource(tid, n),
                    []));
        }

        // origin — 3 subtypes (base + passthrough + aggregate); dispatch to subtype class
        foreach (string subType in ORIGIN_SUBTYPES)
        {
            Func<TypeId, string, MetaData> nodeFactory =
                OriginClassMap.TryGetValue(subType, out var originFactory)
                    ? originFactory
                    : (tid, n) => new MetaOrigin(tid, n);

            IReadOnlyList<AttrSchema> originAttrs =
                OriginSchema.OriginAttrsMap.TryGetValue(subType, out var oa)
                    ? oa
                    : [];

            registry.Register(
                Def(
                    TYPE_ORIGIN,
                    subType,
                    $"Origin ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    nodeFactory,
                    originAttrs.ToList()));
        }

        // identity — 2 subtypes (primary + secondary — NO base); dispatch to subtype class
        foreach (string subType in IDENTITY_SUBTYPES)
        {
            Func<TypeId, string, MetaData> nodeFactory =
                IdentityClassMap.TryGetValue(subType, out var idf)
                    ? idf
                    : (tid, n) => new MetaIdentity(tid, n);

            IReadOnlyList<AttrSchema> idAttrs =
                IdentitySchema.IdentityAttrsMap.TryGetValue(subType, out var ia)
                    ? ia
                    : [IdentitySchema.IdentityFieldsAttr];

            registry.Register(
                Def(
                    TYPE_IDENTITY,
                    subType,
                    $"Identity ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    nodeFactory,
                    idAttrs.ToList()));
        }

        // relationship — 4 subtypes (base + association + aggregation + composition)
        foreach (string subType in RELATIONSHIP_SUBTYPES)
        {
            registry.Register(
                Def(
                    TYPE_RELATIONSHIP,
                    subType,
                    $"Relationship ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    (tid, n) => new MetaRelationship(tid, n),
                    RelationshipSchema.RelationshipAttrs.ToList()));
        }

        // Default subTypes for authoring sugar.
        // metadata has exactly one subtype (root) — unambiguous.
        // object defaults to entity, the common case.
        registry.SetDefaultSubType(TYPE_METADATA, SUBTYPE_ROOT);
        registry.SetDefaultSubType(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY);
    }

    // -------------------------------------------------------------------------
    // Private provider implementation
    // -------------------------------------------------------------------------

    private sealed class CoreTypesProviderImpl : IMetaDataTypeProvider
    {
        public string Id => "metaobjects-core-types";
        public string? Description => "Core metaobjects metamodel types and subtypes.";
        public IReadOnlyList<string> Dependencies => [];

        public void RegisterTypes(TypeRegistry registry) =>
            RegisterCoreTypeDefs(registry);
    }
}
