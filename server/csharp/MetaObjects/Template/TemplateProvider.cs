// TemplateTypesProvider — the template/output (serialization) IMetaDataTypeProvider.
// Registers the @xmlText field marker (XML text-content extraction) by EXTENDING the
// core-registered field types. @xmlText is an output/extract concern, NOT a core field
// property, so it lives here — mirroring Java's TemplateTypesMetaDataProvider field
// extension and the C# DbMetaDataProvider (DbProvider.cs) pattern.

using MetaObjects.Core.Attr;
using MetaObjects.Core.Field;

namespace MetaObjects.Template;

/// <summary>
/// Template/output domain provider: registers the <c>@xmlText</c> boolean field marker
/// (XML text-content extraction; template.output @format=xml) on every field subtype via
/// <see cref="TypeRegistry.Extend"/>. Depends on the core types being registered first.
/// </summary>
public sealed class TemplateTypesProvider : IMetaDataTypeProvider
{
    /// <summary>The shared singleton — composed into the default registry alongside the core provider.</summary>
    public static readonly IMetaDataTypeProvider Instance = new TemplateTypesProvider();

    /// <summary>
    /// <c>@xmlText</c> — when true, the field receives its element's XML TEXT CONTENT during
    /// tolerant extract (JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of
    /// a same-named child. On every field subtype. No effect for @format: json.
    /// </summary>
    public static readonly AttrSchema XmlTextSchema = new AttrSchema(
        Name: TemplateConstants.FIELD_ATTR_XML_TEXT,
        ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
        Required: false,
        Description:
            "When true, this field receives its element's XML TEXT CONTENT during tolerant extract " +
            "(JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. " +
            "No effect for @format: json.");

    public string Id => "metaobjects-template";

    public string? Description =>
        "Template/output domain — @xmlText field marker for XML text-content extraction (template.output @format=xml).";

    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        // Extend every field subtype with the @xmlText extract marker (mirrors TS's FIELD_SUBTYPES
        // loop and Java's field.base optionalAttribute — C# registers per-subtype since it has no
        // concrete field.base type def).
        foreach (string subType in FieldConstants.FIELD_SUBTYPES)
        {
            registry.Extend(
                MetaObjects.Shared.BaseTypes.TYPE_FIELD,
                subType,
                attributes: [XmlTextSchema]);
        }
    }
}
