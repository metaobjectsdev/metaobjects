// MetaField — concrete node class for type=field nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-field.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>field.*</c> nodes.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// Implements <see cref="IDataTypeAware"/> — the coarse value-type classification is
/// supplied by the registry at node construction via <c>SetDataType()</c>.
/// </summary>
public class MetaField(TypeId typeId, string name) : MetaData(typeId, name), IDataTypeAware
{
    /// <summary>The coarse value-type classification for this field's subtype.</summary>
    public DataType DataType => DataTypeValue ?? global::MetaObjects.DataType.String;

    /// <summary>The target object name for an object-typed field (the <c>@objectRef</c> attr).</summary>
    public string? ObjectRef
    {
        get
        {
            var v = OwnAttr(FIELD_ATTR_OBJECT_REF);
            return v is string s ? s : null;
        }
    }

    /// <summary>Column name override (the <c>@dbColumn</c> attr).</summary>
    public string? DbColumn
    {
        get
        {
            var v = OwnAttr(FIELD_ATTR_DB_COLUMN);
            return v is string s ? s : null;
        }
    }

    /// <summary>Raw default attr value (the <c>@default</c> attr).</summary>
    public object? Default => OwnAttr(FIELD_ATTR_DEFAULT);

    /// <summary>
    /// The default value for this field, converted to the field's own DataType.
    /// Returns <see langword="null"/> when <c>@default</c> is not set on this field.
    /// Mirrors TS <c>MetaField.defaultValue()</c> — uses the DataConverter for type coercion.
    /// </summary>
    public object? DefaultValue()
    {
        return Cached("defaultValue", () =>
        {
            var raw = OwnAttr(FIELD_ATTR_DEFAULT);
            if (raw is null) return null;
            return DataConverter.ConvertToDataType(DataType, raw);
        });
    }

    /// <summary>Maximum string or array length (the <c>@maxLength</c> attr).</summary>
    public long? MaxLength
    {
        get
        {
            var v = OwnAttr(FIELD_ATTR_MAX_LENGTH);
            return v is long l ? l : null;
        }
    }

    /// <summary>Numeric precision (the <c>@precision</c> attr).</summary>
    public long? Precision
    {
        get
        {
            var v = OwnAttr(FIELD_ATTR_PRECISION);
            return v is long l ? l : null;
        }
    }

    /// <summary>Numeric scale (the <c>@scale</c> attr).</summary>
    public long? Scale
    {
        get
        {
            var v = OwnAttr(FIELD_ATTR_SCALE);
            return v is long l ? l : null;
        }
    }

    /// <summary>True if <c>@unique: true</c> is set on the field itself (column-level unique).</summary>
    public bool Unique => OwnAttr(FIELD_ATTR_UNIQUE) is true;

    /// <summary>
    /// True if the field is required (NOT NULL).
    /// Checks both <c>@required: true</c> attr and <c>validator.required</c> children.
    /// Mirrors TS <c>MetaField.isRequired</c> getter.
    /// </summary>
    public bool IsRequired
    {
        get
        {
            if (OwnAttr(FIELD_ATTR_REQUIRED) is true) return true;
            return Validators().Any(v => v.IsRequired());
        }
    }

    // -------------------------------------------------------------------------
    // Validators
    // -------------------------------------------------------------------------

    /// <summary>All effective validators (own + inherited via extends).</summary>
    public IReadOnlyList<MetaValidator> Validators()
    {
        return Cached("validators", () =>
            (IReadOnlyList<MetaValidator>)Children()
                .Where(c => c is MetaValidator)
                .Cast<MetaValidator>()
                .ToArray());
    }

    /// <summary>Own validators only — excludes validators inherited via extends.</summary>
    public IReadOnlyList<MetaValidator> OwnValidators()
    {
        return Cached("ownValidators", () =>
            (IReadOnlyList<MetaValidator>)OwnChildren()
                .Where(c => c is MetaValidator)
                .Cast<MetaValidator>()
                .ToArray());
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// <summary>All effective views (own + inherited via extends).</summary>
    public IReadOnlyList<MetaView> Views()
    {
        return Cached("views", () =>
            (IReadOnlyList<MetaView>)Children()
                .Where(c => c is MetaView)
                .Cast<MetaView>()
                .ToArray());
    }

    /// <summary>Own views only — excludes views inherited via extends.</summary>
    public IReadOnlyList<MetaView> OwnViews()
    {
        return Cached("ownViews", () =>
            (IReadOnlyList<MetaView>)OwnChildren()
                .Where(c => c is MetaView)
                .Cast<MetaView>()
                .ToArray());
    }

    /// <summary>The typed supertype field if <c>extends:</c> resolved, else <see langword="null"/>.</summary>
    public MetaField? ResolveSuper() => SuperData as MetaField;
}
