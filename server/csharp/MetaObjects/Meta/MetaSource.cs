// MetaSource — concrete node class for type=source nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/persistence/source/meta-source.ts
// and the Java sibling com.metaobjects.source.MetaSource.
//
// Source v2 (ADR-0007): paradigm subtype "rdb" with per-kind physical-name
// aliases (@table/@view/@materializedView/@proc/@function — FR-016 / ADR-0018)
// + @kind/@role/@schema. Read-only-ness is derived from @kind (view/
// materializedView/storedProc/tableFunction are read-only; table is writable).

using MetaObjects.Persistence.Source;

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>source.*</c> nodes.
/// Declares where an object's data lives. Source v2 uses kind-aware physical-name
/// aliases (<c>@table</c>/<c>@view</c>/<c>@materializedView</c>/<c>@proc</c>/<c>@function</c>),
/// <c>@kind</c> (table/view/...), <c>@role</c> (primary/replica/...), and
/// <c>@schema</c> (optional DB schema). See <see cref="PhysicalName"/> for the
/// FR-016 four-step resolution rule that codegen / migrate / runtime should use.
/// </summary>
// ADR-0039: source attr getters use the RESOLVING Attr() accessor — a source attr
// may be inherited from an abstract base via extends (reconciled with the resolving
// MetaIdentity getters).
public class MetaSource(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>
    /// Physical SQL table/view name from the legacy <c>@table</c> attr. Kept as a
    /// back-compat accessor that reads ONLY the <c>@table</c> slot — callers should
    /// use <see cref="PhysicalName"/> for the FR-016 four-step rule.
    /// ADR-0039: resolving — inheritable via extends.
    /// </summary>
    public string? TableName
    {
        get
        {
            var v = Attr(SOURCE_ATTR_TABLE);
            return v is string s && s != "" ? s : null;
        }
    }

    /// <summary>
    /// The effective <c>@kind</c> for this source — the declared value, or
    /// <see cref="DEFAULT_SOURCE_KIND"/> ("table") when absent.
    /// ADR-0039: resolving — inheritable via extends.
    /// </summary>
    public string EffectiveKind
    {
        get
        {
            var v = Attr(SOURCE_ATTR_KIND);
            return v is string s && s != "" ? s : DEFAULT_SOURCE_KIND;
        }
    }

    /// <summary>
    /// The multi-source role — the declared <c>@role</c>, or
    /// <see cref="DEFAULT_SOURCE_ROLE"/> ("primary") when absent.
    /// ADR-0039: resolving — inheritable via extends.
    /// </summary>
    public string Role
    {
        get
        {
            var v = Attr(SOURCE_ATTR_ROLE);
            return v is string s && s != "" ? s : DEFAULT_SOURCE_ROLE;
        }
    }

    /// <summary>Optional database schema namespace (the <c>@schema</c> attr).
    /// ADR-0039: resolving — inheritable via extends.</summary>
    public string? Schema
    {
        get
        {
            var v = Attr(SOURCE_ATTR_SCHEMA);
            return v is string s && s != "" ? s : null;
        }
    }

    /// <summary>
    /// FR-024/#208 — the hand-written SQL body for this source's DB object, when
    /// declared via <c>@sql</c>. The tool registers + fingerprints + drift-checks this
    /// body but never authors or parses it.
    /// ADR-0039: resolving — an inherited source's @sql lives on the super node
    /// (follows the @role/EffectiveKind precedent, not the @dbColumnType own-only
    /// exception).
    /// </summary>
    public string? SqlBody
    {
        get
        {
            var v = Attr(SOURCE_ATTR_SQL);
            return v is string s && s != "" ? s : null;
        }
    }

    /// <summary>
    /// FR-024/#208 — true when this source's DB object is managed elsewhere
    /// (Flyway / a hand-migration owns its DDL); <c>meta migrate</c> does not
    /// create/drop/drift-check it.
    /// ADR-0039: resolving — inheritable via extends.
    /// </summary>
    public bool IsUnmanaged => Attr(SOURCE_ATTR_UNMANAGED) is true;

    /// <summary>
    /// FR-015 — name (or FQN) of the <c>object.value</c> describing this callable
    /// source's input shape (the <c>@parameterRef</c> attr). Null when absent
    /// (a zero-argument callable, or a non-callable source). The referenced
    /// value-object's field children are the call-site arguments, in declaration order.
    /// </summary>
    public string? ParameterRef
    {
        get
        {
            // ADR-0039: resolving — inheritable via extends.
            var v = Attr(SOURCE_ATTR_PARAMETER_REF);
            return v is string s && s != "" ? s : null;
        }
    }

    /// <summary>
    /// FR-015 — true when this source's effective kind is a callable
    /// (<c>storedProc</c> / <c>tableFunction</c>): it is invoked with arguments and
    /// returns rows, rather than being a plain table/view.
    /// </summary>
    public bool IsCallable() =>
        EffectiveKind == SOURCE_KIND_STORED_PROC || EffectiveKind == SOURCE_KIND_TABLE_FUNCTION;

    /// <summary>
    /// True when this source's effective kind is read-only (view, materializedView,
    /// storedProc, tableFunction). Derived from <see cref="EffectiveKind"/>.
    /// </summary>
    public bool IsReadOnly() => SOURCE_READ_ONLY_KINDS.Contains(EffectiveKind);

    /// <summary>True when this source is writable (i.e. not read-only).</summary>
    public bool IsWritable() => !IsReadOnly();

    /// <summary>
    /// Resolved physical SQL name for this source, following the FR-016 / ADR-0018
    /// four-step rule:
    /// <list type="number">
    ///   <item>Kind-matching alias (e.g. <c>@proc</c> when <c>@kind: "storedProc"</c>).</item>
    ///   <item>Legacy <c>@table</c> for non-table kind (pre-1.0 fallback).</item>
    ///   <item>Source's bare structural <c>name</c> via <c>snake_case</c>.</item>
    ///   <item>Owning entity's name via <c>pluralize(snake_case)</c>.</item>
    /// </list>
    /// <para>
    /// Callers needing the legacy raw <c>@table</c> slot only should use
    /// <see cref="TableName"/>; codegen / migrate / runtime should use
    /// <see cref="PhysicalName"/>.
    /// </para>
    /// </summary>
    public string PhysicalName
    {
        get
        {
            string kind = EffectiveKind;

            // Step 1: kind-matching alias.
            string? canonicalAttr = null;
            if (SourceConstants.PHYSICAL_NAME_ATTR_BY_KIND.TryGetValue(kind, out var attr))
            {
                canonicalAttr = attr;
                // ADR-0039: resolving — physical-name alias inheritable via extends.
                if (Attr(attr) is string s && s != "") return s;
            }

            // Step 2: legacy @table for non-table kind.
            if (canonicalAttr != SOURCE_ATTR_TABLE)
            {
                // ADR-0039: resolving — inheritable via extends.
                if (Attr(SOURCE_ATTR_TABLE) is string legacy && legacy != "") return legacy;
            }

            // Step 3: source's structural `name` via snake_case (no pluralization —
            // the source's name IS the logical name).
            if (Name != "")
            {
                return SourceNaming.ToSnakeCase(Name);
            }

            // Step 4: owning entity's name via pluralize(snake_case). The MetaData
            // parent of a source is always the entity that declared it.
            var owner = Parent;
            if (owner is not null && owner.Name != "")
            {
                return SourceNaming.Pluralize(SourceNaming.ToSnakeCase(owner.Name));
            }

            return "";
        }
    }
}
