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

    /// <summary>Find an object by name.</summary>
    public MetaObject? FindObject(string name)
    {
        return Cached($"findObject:{name}", () =>
        {
            var child = OwnChildByTypeAndName(TYPE_OBJECT, name);
            return child as MetaObject;
        });
    }
}
