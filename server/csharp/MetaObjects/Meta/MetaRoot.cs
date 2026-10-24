// MetaRoot — concrete node class for the type=metadata root node.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-root.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for the <c>metadata.root</c> node.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
public class MetaRoot(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>
    /// The project's physical-naming rules (<c>naming</c> in <c>.metaobjects/config.json</c>,
    /// ADR-0058). Set by the project-aware load (<see cref="MetaObjects.Config.MetadataLocation"/>),
    /// read by every name resolver through <see cref="PhysicalNaming.Of"/>. A tree loaded with
    /// no project — or built via <c>MetaDataLoader.FromUris</c> with no project-aware
    /// wrapper — keeps the default. <c>FromDirectory</c> reads the project's config itself.
    /// </summary>
    public PhysicalNaming PhysicalNaming { get; set; } = PhysicalNaming.Default;

    /// <summary>
    /// The project's wire-format setting (<c>wire</c> in <c>.metaobjects/config.json</c>,
    /// ADR-0019 Amendment 2), set by the same project-aware load as <see cref="PhysicalNaming"/>
    /// and read by codegen through <see cref="MetaObjects.Meta.WireFormat.Of"/>. A tree loaded with
    /// no project keeps the native default.
    /// </summary>
    public WireFormat WireFormat { get; set; } = WireFormat.Default;

    /// <summary>Object entities defined at this root level.</summary>
    public IReadOnlyList<MetaObject> Objects()
    {
        return Cached("objects", () =>
            (IReadOnlyList<MetaObject>)OwnChildren()
                .Where(c => c is MetaObject)
                .Cast<MetaObject>()
                .ToArray());
    }

    /// <summary>Abstract / package-level fields defined at root (rare; e.g. shared id fields).</summary>
    public IReadOnlyList<MetaField> Fields()
    {
        return Cached("fields", () =>
            (IReadOnlyList<MetaField>)OwnChildren()
                .Where(c => c is MetaField)
                .Cast<MetaField>()
                .ToArray());
    }

    /// <summary>Templates (<c>template.*</c>) defined at this root level (own children only).</summary>
    public IReadOnlyList<MetaData> RootTemplates()
    {
        return Cached("templates", () =>
            (IReadOnlyList<MetaData>)OwnChildren()
                .Where(c => c.Type == TYPE_TEMPLATE)
                .ToArray());
    }

    /// <summary>
    /// Find an object by name, or by a canonical reference (ADR-0059): a value with a package
    /// separator (<c>acme::Program</c>, <c>::Program</c>) binds the object whose resolution key
    /// matches exactly. A bare name matches a root-level child by name, as before.
    /// </summary>
    public MetaObject? FindObject(string name)
    {
        return Cached($"findObject:{name}", () =>
        {
            if (name.Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal))
                return NamingRefs.LookupCanonical(this, name, TYPE_OBJECT) as MetaObject;
            var child = OwnChildByTypeAndName(TYPE_OBJECT, name);
            return child as MetaObject;
        });
    }
}
