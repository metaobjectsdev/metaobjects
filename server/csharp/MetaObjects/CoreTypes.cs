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
using MetaObjects.Persistence.Source;
using MetaObjects.Presentation.View;
using MetaObjects.Presentation.Layout;
using MetaObjects.Template;

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
        DataType? dataType = null,
        int maxOccurs = 0,
        string? defaultName = null)
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
            dataType: dataType,
            maxOccurs: maxOccurs,
            defaultName: defaultName);
    }

    // -------------------------------------------------------------------------
    // Field subtype → DataType map
    // -------------------------------------------------------------------------

    private static readonly Dictionary<string, DataType> FieldDataType = new()
    {
        [SUBTYPE_BASE]            = DataType.String,
        [FIELD_SUBTYPE_STRING]    = DataType.String,
        [FIELD_SUBTYPE_INT]       = DataType.Int,
        [FIELD_SUBTYPE_LONG]      = DataType.Long,
        [FIELD_SUBTYPE_CURRENCY]  = DataType.Long,
        [FIELD_SUBTYPE_ENUM]      = DataType.String,
        // R6 Plan 2a — field.uuid is string-backed on the wire (lowercase-canonical
        // UUID string); the native System.Guid binding is a build-time codegen concern.
        [FIELD_SUBTYPE_UUID]      = DataType.String,
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
        [IDENTITY_SUBTYPE_REFERENCE] = (tid, n) => new MetaReferenceIdentity(tid, n),
    };

    // -------------------------------------------------------------------------
    // Origin subtype → concrete factory
    // -------------------------------------------------------------------------

    private static readonly Dictionary<string, Func<TypeId, string, MetaData>> OriginClassMap = new()
    {
        [ORIGIN_SUBTYPE_PASSTHROUGH] = (tid, n) => new MetaPassthroughOrigin(tid, n),
        [ORIGIN_SUBTYPE_AGGREGATE]   = (tid, n) => new MetaAggregateOrigin(tid, n),
        [ORIGIN_SUBTYPE_COLLECTION]  = (tid, n) => new MetaCollectionOrigin(tid, n),
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
                    Wildcard(TYPE_TEMPLATE),
                ],
                (tid, n) => new MetaRoot(tid, n),
                []));

        // object — 4 subtypes (base, entity, value, projection)
        List<ChildRule> objectRules =
        [
            Wildcard(TYPE_FIELD),
            Wildcard(TYPE_IDENTITY),
            Wildcard(TYPE_RELATIONSHIP),
            Wildcard(TYPE_VALIDATOR),
            Wildcard(TYPE_LAYOUT),
            Wildcard(TYPE_SOURCE),
            Wildcard(TYPE_ATTR),
            // template.* under object.entity — a declared prompt/output lives WITH
            // its entity (AI LLM-call trace persistence; the trace entity carries a
            // nested template.prompt). Mirrors Java optionalChild("template","*","*").
            Wildcard(TYPE_TEMPLATE),
        ];
        // FR-024: object.projection is a derived read-only representation of
        // entities — it carries fields/identities/sources but never declares
        // relationships (derivation is expressed via @via) and never co-locates
        // templates. Mirrors the TS reference projectionRules exactly.
        List<ChildRule> projectionRules =
        [
            Wildcard(TYPE_FIELD),
            Wildcard(TYPE_IDENTITY),
            Wildcard(TYPE_VALIDATOR),
            Wildcard(TYPE_LAYOUT),
            Wildcard(TYPE_SOURCE),
            Wildcard(TYPE_ATTR),
        ];
        foreach (string subType in OBJECT_SUBTYPES)
        {
            // FR-033: object.value's @normalize (the object-level default normalization
            // mode for its enum fields' tolerant extract) is re-homed to the
            // metaobjects-prompt concern provider (reads prompt.json's object.value
            // extends), so core no longer appends it here.
            List<AttrSchema> objectAttrs = ObjectSchema.ObjectAttrs.ToList();

            List<ChildRule> rules = subType == OBJECT_SUBTYPE_PROJECTION
                ? new List<ChildRule>(projectionRules)
                : new List<ChildRule>(objectRules);

            registry.Register(
                Def(
                    TYPE_OBJECT,
                    subType,
                    $"Object/entity ({subType})",
                    rules,
                    (tid, n) => new MetaObject(tid, n),
                    objectAttrs));
        }

        // field — 18 subtypes (base + 17)
        List<ChildRule> fieldRules =
        [
            Wildcard(TYPE_VALIDATOR),
            Wildcard(TYPE_VIEW),
            Wildcard(TYPE_ATTR),
            Wildcard(TYPE_ORIGIN),
        ];
        foreach (string subType in FIELD_SUBTYPES)
        {
            List<AttrSchema> fieldAttrs = subType switch
            {
                FIELD_SUBTYPE_CURRENCY => [.. FieldSchema.CommonFieldAttrs, FieldSchema.CurrencyFieldAttr],
                // FR-033: field.enum keeps the structural @values / @provided in core; its
                // tolerant-extract overlays (@enumAlias / @enumDoc / @coerceDefault /
                // @normalize) are re-homed to the metaobjects-prompt concern provider
                // (reads prompt.json's field.enum extends).
                FIELD_SUBTYPE_ENUM     => [.. FieldSchema.CommonFieldAttrs, FieldSchema.EnumValuesAttr, FieldSchema.ProvidedAttr],
                _                      => FieldSchema.CommonFieldAttrs.ToList(),
            };

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

        // view — 14 subtypes (base + 13); only attr children. FR-033: view.currency's
        // @locale is re-homed to the metaobjects-ui concern provider (reads ui.json's
        // view.currency extends), so core registers no view attrs here.
        foreach (string subType in VIEW_SUBTYPES)
        {
            List<AttrSchema> viewAttrs = [];

            registry.Register(
                Def(
                    TYPE_VIEW,
                    subType,
                    $"View ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    (tid, n) => new MetaView(tid, n),
                    viewAttrs));
        }

        // layout — 2 subtypes (base + dataGrid); only attr children. FR-033: every
        // layout.dataGrid attr (@pageSize / @defaultSortField / @defaultSortOrder /
        // @filterable / @filter / @columns) is re-homed to the metaobjects-ui concern
        // provider (reads ui.json's layout.dataGrid extends), so core registers no
        // layout attrs here.
        foreach (string subType in LAYOUT_SUBTYPES)
        {
            List<AttrSchema> layoutAttrs = [];

            registry.Register(
                Def(
                    TYPE_LAYOUT,
                    subType,
                    $"Layout ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    (tid, n) => new MetaLayout(tid, n),
                    layoutAttrs));
        }

        // source — 2 subtypes (base + rdb); only attr children. ADR-0007: source.rdb
        // declares @table/@kind/@role/@schema; read-only-ness derives from @kind.
        foreach (string subType in SOURCE_SUBTYPES)
        {
            // Attr schemas are declared on the concrete rdb subtype (mirrors TS/Java).
            List<AttrSchema> sourceAttrs = subType == SOURCE_SUBTYPE_RDB
                ? SourceSchema.RdbSourceAttrs.ToList()
                : [];

            registry.Register(
                Def(
                    TYPE_SOURCE,
                    subType,
                    $"Source ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    (tid, n) => new MetaSource(tid, n),
                    sourceAttrs));
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

            // identity.primary is a singleton (exactly one per object): a name-less
            // primary is named from config ("primary") and two primaries trip the
            // maxOccurs enforcement pass (ERR_TOO_MANY_OCCURRENCES). Config-driven —
            // declared on the type, not special-cased in the loader.
            bool isPrimary = subType == IDENTITY_SUBTYPE_PRIMARY;

            registry.Register(
                Def(
                    TYPE_IDENTITY,
                    subType,
                    $"Identity ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    nodeFactory,
                    idAttrs.ToList(),
                    maxOccurs: isPrimary ? 1 : 0,
                    defaultName: isPrimary ? subType : null));
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

        // Declare the core cross-references ON their TypeDefinitions — the loader's
        // registry-derived validation resolves them (a dangling target fails the load).
        // Mirrors the TS/Java realization (config-on-the-type).
        foreach (string subType in RELATIONSHIP_SUBTYPES)
        {
            var rdef = registry.Find(TYPE_RELATIONSHIP, subType);
            if (rdef is not null)
            {
                rdef.References = [new MetaObjects.Validation.ReferenceDescriptor(
                    RELATIONSHIP_ATTR_OBJECT_REF, TYPE_OBJECT, null, false, "ERR_INVALID_RELATIONSHIP")];
            }
        }
        var idRefDef = registry.Find(TYPE_IDENTITY, IDENTITY_SUBTYPE_REFERENCE);
        if (idRefDef is not null)
        {
            idRefDef.References = [new MetaObjects.Validation.ReferenceDescriptor(
                IDENTITY_REFERENCE_ATTR_REFERENCES, TYPE_OBJECT, null, true, "ERR_INVALID_REFERENCE")];
        }

        // template — fourth-pillar metatype (FR-004). prompt + output; attr-only
        // children. A single MetaTemplate class backs both subtypes (mirrors source);
        // per-subtype attr schemas drive validation (both require @payloadRef +
        // @textRef; @format is a closed enum). Reference resolution (@payloadRef) is
        // render-time verify scope, NOT load-time — so no payload-resolution pass here.
        // FR-033: the per-subtype template attrs (@payloadRef / @textRef / @format /
        // @maxChars / @kind / @promptStyle / @toolName / …) are re-homed to the
        // metaobjects-prompt concern provider (reads prompt.json's template.* extends).
        // Core registers only the template TYPE definitions; their attrs are owned by
        // metaobjects-prompt.
        foreach (string subType in TEMPLATE_SUBTYPES)
        {
            registry.Register(
                Def(
                    TYPE_TEMPLATE,
                    subType,
                    $"Template ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    (tid, n) => new MetaTemplate(tid, n),
                    []));
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
