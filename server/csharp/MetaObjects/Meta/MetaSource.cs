// MetaSource — concrete node class for type=source nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/persistence/source/meta-source.ts
// and the Java sibling com.metaobjects.source.MetaSource.
//
// Source v2 (ADR-0007): paradigm subtype "rdb" with @table/@kind/@role/@schema.
// Read-only-ness is derived from @kind (view/materializedView/storedProc/tableFunction
// are read-only; table is writable).

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>source.*</c> nodes.
/// Declares where an object's data lives. Source v2 uses
/// <c>@table</c> (physical name), <c>@kind</c> (table/view/...), <c>@role</c>
/// (primary/replica/...), and <c>@schema</c> (optional DB schema).
/// </summary>
public class MetaSource(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>The physical SQL table or view name (value of <c>@table</c>).</summary>
    public string? TableName
    {
        get
        {
            var v = OwnAttr(SOURCE_ATTR_TABLE);
            return v is string s && s != "" ? s : null;
        }
    }

    /// <summary>
    /// The effective <c>@kind</c> for this source — the declared value, or
    /// <see cref="DEFAULT_SOURCE_KIND"/> ("table") when absent.
    /// </summary>
    public string EffectiveKind
    {
        get
        {
            var v = OwnAttr(SOURCE_ATTR_KIND);
            return v is string s && s != "" ? s : DEFAULT_SOURCE_KIND;
        }
    }

    /// <summary>
    /// The multi-source role — the declared <c>@role</c>, or
    /// <see cref="DEFAULT_SOURCE_ROLE"/> ("primary") when absent.
    /// </summary>
    public string Role
    {
        get
        {
            var v = OwnAttr(SOURCE_ATTR_ROLE);
            return v is string s && s != "" ? s : DEFAULT_SOURCE_ROLE;
        }
    }

    /// <summary>Optional database schema namespace (the <c>@schema</c> attr).</summary>
    public string? Schema
    {
        get
        {
            var v = OwnAttr(SOURCE_ATTR_SCHEMA);
            return v is string s && s != "" ? s : null;
        }
    }

    /// <summary>
    /// True when this source's effective kind is read-only (view, materializedView,
    /// storedProc, tableFunction). Derived from <see cref="EffectiveKind"/>.
    /// </summary>
    public bool IsReadOnly() => SOURCE_READ_ONLY_KINDS.Contains(EffectiveKind);

    /// <summary>True when this source is writable (i.e. not read-only).</summary>
    public bool IsWritable() => !IsReadOnly();
}
