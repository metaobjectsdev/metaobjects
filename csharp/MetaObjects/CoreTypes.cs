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
            ChildSubType: Constants.CHILD_RULE_WILDCARD,
            ChildName: Constants.CHILD_RULE_WILDCARD);

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
        [Constants.SUBTYPE_BASE]            = DataType.String,
        [Constants.FIELD_SUBTYPE_STRING]    = DataType.String,
        [Constants.FIELD_SUBTYPE_CLASS]     = DataType.String,
        [Constants.FIELD_SUBTYPE_INT]       = DataType.Int,
        [Constants.FIELD_SUBTYPE_SHORT]     = DataType.Int,
        [Constants.FIELD_SUBTYPE_BYTE]      = DataType.Int,
        [Constants.FIELD_SUBTYPE_LONG]      = DataType.Long,
        [Constants.FIELD_SUBTYPE_CURRENCY]  = DataType.Long,
        [Constants.FIELD_SUBTYPE_DOUBLE]    = DataType.Double,
        [Constants.FIELD_SUBTYPE_FLOAT]     = DataType.Double,
        [Constants.FIELD_SUBTYPE_DECIMAL]   = DataType.Double,
        [Constants.FIELD_SUBTYPE_BOOLEAN]   = DataType.Boolean,
        [Constants.FIELD_SUBTYPE_DATE]      = DataType.Date,
        [Constants.FIELD_SUBTYPE_TIME]      = DataType.Date,
        [Constants.FIELD_SUBTYPE_TIMESTAMP] = DataType.Date,
        [Constants.FIELD_SUBTYPE_OBJECT]    = DataType.Object,
    };

    // -------------------------------------------------------------------------
    // Attr subtype → DataType map
    // -------------------------------------------------------------------------

    private static readonly Dictionary<string, DataType> AttrDataType = new()
    {
        [Constants.SUBTYPE_BASE]               = DataType.String,
        [Constants.ATTR_SUBTYPE_STRING]        = DataType.String,
        [Constants.ATTR_SUBTYPE_CLASS]         = DataType.String,
        [Constants.ATTR_SUBTYPE_STRINGARRAY]   = DataType.String,
        [Constants.ATTR_SUBTYPE_INT]           = DataType.Int,
        [Constants.ATTR_SUBTYPE_LONG]          = DataType.Long,
        [Constants.ATTR_SUBTYPE_DOUBLE]        = DataType.Double,
        [Constants.ATTR_SUBTYPE_BOOLEAN]       = DataType.Boolean,
        [Constants.ATTR_SUBTYPE_PROPERTIES]    = DataType.Object,
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
        [Constants.VALIDATOR_SUBTYPE_REQUIRED] = (tid, n) => new MetaRequiredValidator(tid, n),
        [Constants.VALIDATOR_SUBTYPE_LENGTH]   = (tid, n) => new MetaLengthValidator(tid, n),
        [Constants.VALIDATOR_SUBTYPE_REGEX]    = (tid, n) => new MetaRegexValidator(tid, n),
        [Constants.VALIDATOR_SUBTYPE_NUMERIC]  = (tid, n) => new MetaNumericValidator(tid, n),
        [Constants.VALIDATOR_SUBTYPE_ARRAY]    = (tid, n) => new MetaArrayValidator(tid, n),
    };

    // -------------------------------------------------------------------------
    // Identity subtype → concrete factory
    // -------------------------------------------------------------------------

    private static readonly Dictionary<string, Func<TypeId, string, MetaData>> IdentityClassMap = new()
    {
        [Constants.IDENTITY_SUBTYPE_PRIMARY]   = (tid, n) => new MetaPrimaryIdentity(tid, n),
        [Constants.IDENTITY_SUBTYPE_SECONDARY] = (tid, n) => new MetaSecondaryIdentity(tid, n),
    };

    // -------------------------------------------------------------------------
    // Origin subtype → concrete factory
    // -------------------------------------------------------------------------

    private static readonly Dictionary<string, Func<TypeId, string, MetaData>> OriginClassMap = new()
    {
        [Constants.ORIGIN_SUBTYPE_PASSTHROUGH] = (tid, n) => new MetaPassthroughOrigin(tid, n),
        [Constants.ORIGIN_SUBTYPE_AGGREGATE]   = (tid, n) => new MetaAggregateOrigin(tid, n),
    };

    // -------------------------------------------------------------------------
    // registerCoreTypeDefs — registers all (type, subType) pairs
    // -------------------------------------------------------------------------

    private static void RegisterCoreTypeDefs(TypeRegistry registry)
    {
        // metadata — 1 subtype (the document root: metadata.root)
        registry.Register(
            Def(
                Constants.TYPE_METADATA,
                Constants.SUBTYPE_ROOT,
                "Root metadata document",
                [
                    Wildcard(Constants.TYPE_OBJECT),
                    Wildcard(Constants.TYPE_FIELD),
                    Wildcard(Constants.TYPE_ATTR),
                    Wildcard(Constants.TYPE_VALIDATOR),
                ],
                (tid, n) => new MetaRoot(tid, n),
                []));

        // object — 3 subtypes (base, entity, value)
        List<ChildRule> objectRules =
        [
            Wildcard(Constants.TYPE_FIELD),
            Wildcard(Constants.TYPE_IDENTITY),
            Wildcard(Constants.TYPE_RELATIONSHIP),
            Wildcard(Constants.TYPE_VALIDATOR),
            Wildcard(Constants.TYPE_LAYOUT),
            Wildcard(Constants.TYPE_SOURCE),
            Wildcard(Constants.TYPE_ATTR),
        ];
        foreach (string subType in Constants.OBJECT_SUBTYPES)
        {
            string capturedSubType = subType;
            registry.Register(
                Def(
                    Constants.TYPE_OBJECT,
                    capturedSubType,
                    $"Object/entity ({capturedSubType})",
                    new List<ChildRule>(objectRules),
                    (tid, n) => new MetaObject(tid, n),
                    CoreAttrSchemas.ObjectAttrs.ToList()));
        }

        // field — 16 subtypes (base + 15)
        List<ChildRule> fieldRules =
        [
            Wildcard(Constants.TYPE_VALIDATOR),
            Wildcard(Constants.TYPE_VIEW),
            Wildcard(Constants.TYPE_ATTR),
            Wildcard(Constants.TYPE_ORIGIN),
        ];
        foreach (string subType in Constants.FIELD_SUBTYPES)
        {
            string capturedSubType = subType;
            List<AttrSchema> fieldAttrs =
                capturedSubType == Constants.FIELD_SUBTYPE_CURRENCY
                    ? [.. CoreAttrSchemas.CommonFieldAttrs, CoreAttrSchemas.CurrencyFieldAttr]
                    : CoreAttrSchemas.CommonFieldAttrs.ToList();

            registry.Register(
                Def(
                    Constants.TYPE_FIELD,
                    capturedSubType,
                    $"Field of type {capturedSubType}",
                    new List<ChildRule>(fieldRules),
                    (tid, n) => new MetaField(tid, n),
                    fieldAttrs,
                    DataTypeFor(FieldDataType, capturedSubType, "field")));
        }

        // attr — 9 subtypes (base + 8), no children allowed
        foreach (string subType in Constants.ATTR_SUBTYPES)
        {
            string capturedSubType = subType;
            registry.Register(
                Def(
                    Constants.TYPE_ATTR,
                    capturedSubType,
                    $"Attribute of type {capturedSubType}",
                    [],
                    (tid, n) => new MetaAttr(tid, n),
                    [],
                    DataTypeFor(AttrDataType, capturedSubType, "attr")));
        }

        // validator — 6 subtypes (base + 5); dispatch to subtype-specific class
        List<ChildRule> validatorRules = [Wildcard(Constants.TYPE_ATTR)];
        foreach (string subType in Constants.VALIDATOR_SUBTYPES)
        {
            string capturedSubType = subType;
            Func<TypeId, string, MetaData> nodeFactory =
                ValidatorClassMap.TryGetValue(capturedSubType, out var vf)
                    ? vf
                    : (tid, n) => new MetaValidator(tid, n);

            IReadOnlyList<AttrSchema> validatorAttrs =
                CoreAttrSchemas.ValidatorAttrsMap.TryGetValue(capturedSubType, out var va)
                    ? va
                    : [];

            registry.Register(
                Def(
                    Constants.TYPE_VALIDATOR,
                    capturedSubType,
                    $"Validator ({capturedSubType})",
                    new List<ChildRule>(validatorRules),
                    nodeFactory,
                    validatorAttrs.ToList()));
        }

        // view — 14 subtypes (base + 13); only attr children
        foreach (string subType in Constants.VIEW_SUBTYPES)
        {
            string capturedSubType = subType;
            List<AttrSchema> viewAttrs =
                capturedSubType == Constants.VIEW_SUBTYPE_CURRENCY
                    ? CoreAttrSchemas.CurrencyViewAttrs.ToList()
                    : [];

            registry.Register(
                Def(
                    Constants.TYPE_VIEW,
                    capturedSubType,
                    $"View ({capturedSubType})",
                    [Wildcard(Constants.TYPE_ATTR)],
                    (tid, n) => new MetaView(tid, n),
                    viewAttrs));
        }

        // layout — 2 subtypes (base + dataGrid); only attr children
        foreach (string subType in Constants.LAYOUT_SUBTYPES)
        {
            string capturedSubType = subType;
            List<AttrSchema> layoutAttrs =
                capturedSubType == Constants.LAYOUT_SUBTYPE_DATA_GRID
                    ? CoreAttrSchemas.DataGridLayoutAttrs.ToList()
                    : [];

            registry.Register(
                Def(
                    Constants.TYPE_LAYOUT,
                    capturedSubType,
                    $"Layout ({capturedSubType})",
                    [Wildcard(Constants.TYPE_ATTR)],
                    (tid, n) => new MetaLayout(tid, n),
                    layoutAttrs));
        }

        // source — 3 subtypes (base + dbTable + dbView); only attr children
        foreach (string subType in Constants.SOURCE_SUBTYPES)
        {
            string capturedSubType = subType;
            registry.Register(
                Def(
                    Constants.TYPE_SOURCE,
                    capturedSubType,
                    $"Source ({capturedSubType})",
                    [Wildcard(Constants.TYPE_ATTR)],
                    (tid, n) => new MetaSource(tid, n),
                    []));
        }

        // origin — 3 subtypes (base + passthrough + aggregate); dispatch to subtype class
        foreach (string subType in Constants.ORIGIN_SUBTYPES)
        {
            string capturedSubType = subType;
            Func<TypeId, string, MetaData> nodeFactory =
                OriginClassMap.TryGetValue(capturedSubType, out var of)
                    ? of
                    : (tid, n) => new MetaOrigin(tid, n);

            IReadOnlyList<AttrSchema> originAttrs =
                CoreAttrSchemas.OriginAttrsMap.TryGetValue(capturedSubType, out var oa)
                    ? oa
                    : [];

            registry.Register(
                Def(
                    Constants.TYPE_ORIGIN,
                    capturedSubType,
                    $"Origin ({capturedSubType})",
                    [Wildcard(Constants.TYPE_ATTR)],
                    nodeFactory,
                    originAttrs.ToList()));
        }

        // identity — 2 subtypes (primary + secondary — NO base); dispatch to subtype class
        foreach (string subType in Constants.IDENTITY_SUBTYPES)
        {
            string capturedSubType = subType;
            Func<TypeId, string, MetaData> nodeFactory =
                IdentityClassMap.TryGetValue(capturedSubType, out var idf)
                    ? idf
                    : (tid, n) => new MetaIdentity(tid, n);

            IReadOnlyList<AttrSchema> idAttrs =
                CoreAttrSchemas.IdentityAttrsMap.TryGetValue(capturedSubType, out var ia)
                    ? ia
                    : [CoreAttrSchemas.IdentityFieldsAttr];

            registry.Register(
                Def(
                    Constants.TYPE_IDENTITY,
                    capturedSubType,
                    $"Identity ({capturedSubType})",
                    [Wildcard(Constants.TYPE_ATTR)],
                    nodeFactory,
                    idAttrs.ToList()));
        }

        // relationship — 4 subtypes (base + association + aggregation + composition)
        foreach (string subType in Constants.RELATIONSHIP_SUBTYPES)
        {
            string capturedSubType = subType;
            registry.Register(
                Def(
                    Constants.TYPE_RELATIONSHIP,
                    capturedSubType,
                    $"Relationship ({capturedSubType})",
                    [Wildcard(Constants.TYPE_ATTR)],
                    (tid, n) => new MetaRelationship(tid, n),
                    CoreAttrSchemas.RelationshipAttrs.ToList()));
        }

        // Default subTypes for authoring sugar.
        // metadata has exactly one subtype (root) — unambiguous.
        // object defaults to entity, the common case.
        registry.SetDefaultSubType(Constants.TYPE_METADATA, Constants.SUBTYPE_ROOT);
        registry.SetDefaultSubType(Constants.TYPE_OBJECT, Constants.OBJECT_SUBTYPE_ENTITY);
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
