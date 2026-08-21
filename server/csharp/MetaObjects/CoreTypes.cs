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
using MetaObjects.Core.Index;
using MetaObjects.Core.Relationship;
using MetaObjects.Core.Requirement;
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

    /// <summary>
    /// #265 — the library's own default provider set (core + db + ui + prompt), kept as a
    /// field so <see cref="MetaObjects.Loader.MetaDataLoader"/>'s default registry and
    /// <see cref="LibraryProviderIds"/> share ONE enumeration (never hand-listed twice).
    /// Also what the provider-composition-conformance runner composes for its
    /// `composeWithCore` scenarios (real library providers + a named consumer provider) —
    /// mirrors Python's <c>core_types.core_providers</c>. Homed here (a peer of
    /// <see cref="Registry"/>/<see cref="Provider"/>, not <c>Loader/MetaDataLoader.cs</c>)
    /// so the strict-attr-scoping guard below can consult it without introducing a
    /// Registry → Loader back-reference (the pre-existing dependency direction is
    /// strictly Loader → Registry/Provider/CoreTypes).
    /// </summary>
    public static readonly IReadOnlyList<IMetaDataTypeProvider> LibraryProviders =
    [
        CoreTypesProvider,
        // DB-domain field attrs (@column / @db.indexed / @dbColumnType) — Extend over core
        // field types. Mirrors Java's CoreDBMetaDataProvider and TS's dbProvider.
        MetaObjects.Persistence.Db.DbMetaDataProvider.Instance,
        // FR-033 concern providers — re-home the UI / prompt PROJECTIONS out of the core
        // type classes (read spec/metamodel/ui.json + prompt.json): field.* / field.enum /
        // object.value vocabulary that is optional wherever it lands, including the
        // @xmlText marker the former TemplateTypesProvider registered. template.*'s OWN
        // attrs stay on the core template registration (CoreTypes "template" section) —
        // a required attr must never live in a provider that can be composed out. Mirrors
        // the TS ui/prompt provider split (and Java/Python).
        MetaObjects.Presentation.Ui.UiMetaDataProvider.Instance,
        MetaObjects.Template.PromptMetaDataProvider.Instance,
    ];

    /// <summary>
    /// #265 — the ids of the <see cref="LibraryProviders"/> above, derived (never
    /// hand-listed). Consulted by <see cref="TypeRegistry.ApplyStrictAttrScoping"/> (via
    /// <see cref="TypeRegistry.AttrOrigin"/>) to decide whether an attr's provenance is
    /// "library" (still prunable against the strict per-subtype allow-list) or a
    /// consumer's own provider (never pruned).
    /// </summary>
    public static readonly IReadOnlySet<string> LibraryProviderIds =
        LibraryProviders.Select(p => p.Id).ToHashSet();

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
        // ADR-0036 Wave 3 — field.uri / field.inet are string-backed on the wire; the
        // native System.Uri / System.Net.IPAddress bindings are build-time codegen concerns.
        [FIELD_SUBTYPE_URI]       = DataType.String,
        [FIELD_SUBTYPE_INET]      = DataType.String,
        [FIELD_SUBTYPE_DOUBLE]    = DataType.Double,
        [FIELD_SUBTYPE_FLOAT]     = DataType.Double,
        [FIELD_SUBTYPE_DECIMAL]   = DataType.Double,
        [FIELD_SUBTYPE_BOOLEAN]   = DataType.Boolean,
        [FIELD_SUBTYPE_DATE]      = DataType.Date,
        [FIELD_SUBTYPE_TIME]      = DataType.Date,
        [FIELD_SUBTYPE_TIMESTAMP] = DataType.Date,
        [FIELD_SUBTYPE_OBJECT]    = DataType.Object,
        // field.map — an open-keyed map; its data type is Object (same as field.object).
        [FIELD_SUBTYPE_MAP]       = DataType.Object,
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
        [ATTR_SUBTYPE_EXPRESSION]    = DataType.Object,
        [ATTR_SUBTYPE_INT_MAP]       = DataType.Object,
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
    // Index subtype → concrete factory
    // -------------------------------------------------------------------------

    private static readonly Dictionary<string, Func<TypeId, string, MetaData>> IndexClassMap = new()
    {
        [INDEX_SUBTYPE_LOOKUP] = (tid, n) => new MetaIndex(tid, n),
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
                    // Capability requirements are declared beside the entities they describe.
                    Wildcard(TYPE_REQUIREMENT),
                ],
                (tid, n) => new MetaRoot(tid, n),
                []));

        // object — 4 subtypes (base, entity, value, projection)
        List<ChildRule> objectRules =
        [
            Wildcard(TYPE_FIELD),
            Wildcard(TYPE_IDENTITY),
            Wildcard(TYPE_INDEX),
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
            // #207: object.projection additionally carries the row-scope @filter (an
            // attr.filter object lowered to a view-level WHERE). Strict attr scoping
            // (from spec object.json's projection allow-list) keeps it here and prunes
            // the discriminator attrs, which projection does not declare.
            List<AttrSchema> objectAttrs = subType == OBJECT_SUBTYPE_PROJECTION
                ? [.. ObjectSchema.ObjectAttrs, ObjectSchema.ProjectionFilterAttr]
                : ObjectSchema.ObjectAttrs.ToList();

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
                // ADR-0036 Wave 3: @stringFormat (email|hostname) is scoped to field.string.
                // Strict attr scoping (from spec field.json's field.string allow-list) keeps it
                // here and prunes it everywhere else.
                FIELD_SUBTYPE_STRING   => [.. FieldSchema.CommonFieldAttrs, FieldSchema.StringFormatAttr],
                FIELD_SUBTYPE_CURRENCY => [.. FieldSchema.CommonFieldAttrs, FieldSchema.CurrencyFieldAttr],
                // #234: @lenient (opt out of strict URI / IP-literal well-formedness) is scoped to
                // field.uri / field.inet (from spec field.json's per-subtype allow-list).
                FIELD_SUBTYPE_URI      => [.. FieldSchema.CommonFieldAttrs, FieldSchema.LenientAttr],
                FIELD_SUBTYPE_INET     => [.. FieldSchema.CommonFieldAttrs, FieldSchema.LenientAttr],
                // field.map — the open-keyed map. @objectRef is already in CommonFieldAttrs;
                // @valueType is map-specific. Strict attr scoping (from spec field.json's
                // field.map allow-list) then prunes the object-only @storage attr.
                FIELD_SUBTYPE_MAP      => [.. FieldSchema.CommonFieldAttrs, FieldSchema.MapValueTypeAttr],
                // FR-033: field.enum keeps the structural @values / @provided in core; its
                // tolerant-extract overlays (@enumAlias / @enumDoc / @coerceDefault /
                // @normalize) are re-homed to the metaobjects-prompt concern provider
                // (reads prompt.json's field.enum extends).
                FIELD_SUBTYPE_ENUM     => [.. FieldSchema.CommonFieldAttrs, FieldSchema.EnumValuesAttr, FieldSchema.ProvidedAttr, FieldSchema.IntValueMapAttr],
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

        // attr — 10 subtypes (base + 9), no children allowed
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
                    // maxOccurs/defaultName are hardcoded here (matching the values in
                    // spec_metamodel/identity.json, which this port does NOT yet read). Sourcing
                    // them from that JSON — true single-source-of-truth across all ports — is the
                    // config-driven-validation work tracked in issue #51.
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

        // ADR-0042 — a field.object / field.map @objectRef must resolve (a dangling target
        // fails the load, closing the gap that surfaced downstream as a misleading runtime
        // error; #191). The required-attr pass owns absence (ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF);
        // this descriptor fires only when @objectRef is PRESENT but resolves to nothing →
        // ERR_UNRESOLVED_OBJECT_REF. Mirrors the TS core-types.ts registration.
        foreach (string subType in new[] { FIELD_SUBTYPE_OBJECT, FIELD_SUBTYPE_MAP })
        {
            var fdef = registry.Find(TYPE_FIELD, subType);
            if (fdef is not null)
            {
                fdef.References = [new MetaObjects.Validation.ReferenceDescriptor(
                    FIELD_ATTR_OBJECT_REF, TYPE_OBJECT, null, false, "ERR_UNRESOLVED_OBJECT_REF")];
            }
        }

        // index — 1 subtype (lookup). Non-unique lookup indexes for query-performance.
        // Distinct from identity.secondary (which enforces uniqueness). A single
        // MetaIndex class backs the lookup subtype; physical attrs (@orders/@expr/
        // @where/@using) are contributed by the db provider via registry.Extend.
        // NOTE: there is no spec/metamodel/index.json (the index type is defined
        // inline in the TS INDEX_DEFINITION embedded module), so descriptions and
        // whenToUse are provided here directly rather than via ApplySpecDescriptions.
        registry.Register(new TypeDefinition(
            typeId: new TypeId(TYPE_INDEX, INDEX_SUBTYPE_LOOKUP),
            description:
                "A non-unique lookup index on one or more fields. Use for query-performance indexes that do NOT enforce uniqueness — declare identity.secondary for unique constraints instead.",
            childRules: [Wildcard(TYPE_ATTR)],
            factory: (tid, n) => new MetaIndex(tid, n),
            attributes: IndexSchema.IndexAttrsMap.TryGetValue(INDEX_SUBTYPE_LOOKUP, out var idxLookupAttrs)
                ? idxLookupAttrs.ToList()
                : [],
            whenToUse:
                "You need a DB index for query performance (fast lookups/sorts) but NOT uniqueness enforcement. @fields names the indexed columns; the db provider adds @orders / @expr / @where / @using for physical tuning."));

        // requirement — 2 subtypes. The axis is CHECK POLARITY, a genuine behaviour
        // difference (ADR-0037 §2): `functional` is checked by EXISTENCE (nothing
        // implements it -> fail), `architectural` by UNIVERSALITY (something violates
        // it -> fail). Registered rather than hand-parsed because the capability ledger
        // IS a metadata model: a closed status enum and a list of FQN references to
        // model nodes are exactly `allowedValues` plus reference resolution, both of
        // which this registry already owns (requirements-as-metadata ruling amendment 3).
        // A single MetaRequirement class backs both subtypes (mirrors source/template).
        // Descriptions + whenToUse + the structural child graph come from the embedded
        // spec/metamodel/requirement.json via ApplySpecDescriptions — the placeholder
        // description below is overwritten there, never the shipped prose.
        foreach (string subType in REQUIREMENT_SUBTYPES)
        {
            // Hierarchy IS nesting, not a parent attribute: an L1 solution CONTAINS its
            // L2 segments. BOTH subtypes nest — an architectural requirement is flat by
            // DEFAULT rather than by rule, and may opt into a levelled tree so a quality
            // taxonomy can organise the non-functional set the same way a capability
            // taxonomy organises the functional one. Declaring the child rule on
            // `functional` only was an omission, not a design: it made an architectural
            // node nestable under a FUNCTIONAL parent but never under another
            // architectural one.
            List<ChildRule> requirementRules = [Wildcard(TYPE_ATTR), Wildcard(TYPE_REQUIREMENT)];

            registry.Register(
                Def(
                    TYPE_REQUIREMENT,
                    subType,
                    $"Requirement ({subType})",
                    requirementRules,
                    (tid, n) => new MetaRequirement(tid, n),
                    RequirementSchema.RequirementAttrsMap.TryGetValue(subType, out var reqAttrs)
                        ? reqAttrs.ToList()
                        : []));
        }

        // NOTE: @implementedBy is deliberately NOT declared as a loader `references`
        // descriptor. That pass always ERRORS on an unresolved target, and a
        // requirement with status `planned` names nodes that do not exist YET, so declaring
        // nodes that are GONE — declaring it here would make the entries that carry
        // the mechanism's only controlled evidence fail to load. The loader owns what
        // is unconditional (the status enum, shape, levels); `meta verify` owns the
        // status-conditional resolution, where the severity actually depends on data.

        // template — fourth-pillar metatype (FR-004). prompt + output + toolcall;
        // attr-only children. A single MetaTemplate class backs every subtype (mirrors
        // source/requirement); per-subtype attr schemas drive validation (prompt +
        // output both require @payloadRef + @textRef; toolcall requires @payloadRef +
        // @toolName; @format is a closed enum). Reference resolution (@payloadRef) is
        // render-time verify scope, NOT load-time — so no payload-resolution pass here.
        //
        // These attrs are OWN to template, not a projection from elsewhere: a
        // template.prompt with no @payloadRef can't render, a template.toolcall with
        // no @toolName can't be wired to an LLM. They register HERE, in the core
        // provider, always — never in the metaobjects-prompt concern provider, which
        // is optional and composable OUT. An attribute a type cannot be meaningfully
        // itself without must never live in a provider whose absence silently drops
        // the rule; that is exactly what re-homing these to metaobjects-prompt did
        // (dropping the provider took the required-attr check with it, silently).
        // metaobjects-prompt keeps its legitimate PROJECTIONS onto field.* / field.enum
        // / object.value — someone else's type, optional vocabulary, correctly
        // composable out. See TemplateSchema for the per-subtype attr sets (mirrors
        // RequirementSchema, the pre-existing correct pattern for an own-attr type in
        // this port).
        foreach (string subType in TEMPLATE_SUBTYPES)
        {
            registry.Register(
                Def(
                    TYPE_TEMPLATE,
                    subType,
                    $"Template ({subType})",
                    [Wildcard(TYPE_ATTR)],
                    (tid, n) => new MetaTemplate(tid, n),
                    TemplateSchema.TemplateAttrsMap.TryGetValue(subType, out var tplAttrs)
                        ? tplAttrs.ToList()
                        : []));
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
