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

    /// <summary>The target object name for an object-typed field (the <c>@objectRef</c> attr).
    /// ADR-0039: resolving — a concrete field.object may inherit <c>@objectRef</c> via extends.</summary>
    public string? ObjectRef
    {
        get
        {
            var v = Attr(FIELD_ATTR_OBJECT_REF);
            return v is string s ? s : null;
        }
    }

    /// <summary>
    /// Scalar value subtype of a <c>field.map</c> (the <c>@valueType</c> attr):
    /// one of string/int/long/double/float/decimal/boolean/date/time/timestamp/uuid,
    /// or null when the map is value-object-valued (set via <c>@objectRef</c>) or absent.
    /// </summary>
    public string? ValueType
    {
        get
        {
            // ADR-0039: resolving — a concrete field.map may inherit @valueType via extends.
            var v = Attr(FIELD_ATTR_VALUE_TYPE);
            return v is string s ? s : null;
        }
    }

    /// <summary>
    /// Storage strategy for an object-typed field (the <c>@storage</c> attr):
    /// <c>flattened</c> / <c>jsonb</c> / <c>subdocument</c>, or null when absent
    /// (a relational target treats absent as single-jsonb-column, per back-compat).
    /// </summary>
    public string? Storage
    {
        get
        {
            // ADR-0039: resolving — @storage may be inherited via extends (abstract object base).
            var v = Attr(FIELD_ATTR_STORAGE);
            return v is string s ? s : null;
        }
    }

    /// <summary>Column name override (source-v2 attr <c>@column</c>).
    /// ADR-0039: resolving — inheritable via extends.</summary>
    public string? DbColumn
    {
        get
        {
            var v = Attr(FIELD_ATTR_COLUMN);
            return v is string s ? s : null;
        }
    }

    /// <summary>
    /// R6 Plan 2b — physical DB column-type override (own-only <c>@dbColumnType</c>):
    /// <c>uuid</c> / <c>jsonb</c>, or null when absent. Own-only
    /// (a physical attr is never inherited via <c>extends:</c>), matching the loader's
    /// pairing-validation policy. The logical subtype and its native binding are unaffected.
    /// </summary>
    public string? DbColumnType
    {
        get
        {
            var v = OwnAttr(FIELD_ATTR_DB_COLUMN_TYPE);
            return v is string s ? s : null;
        }
    }

    /// <summary>Raw default attr value (the <c>@default</c> attr).
    /// ADR-0039: resolving — a concrete field may inherit <c>@default</c> from an abstract base.</summary>
    public object? Default => Attr(FIELD_ATTR_DEFAULT);

    /// <summary>
    /// The default value for this field, converted to the field's own DataType.
    /// Returns <see langword="null"/> when <c>@default</c> is not set on this field.
    /// Mirrors TS <c>MetaField.defaultValue()</c> — uses the DataConverter for type coercion.
    /// </summary>
    public object? DefaultValue()
    {
        return Cached("defaultValue", () =>
        {
            // ADR-0039: resolving — inherit @default from an abstract base via extends.
            var raw = Attr(FIELD_ATTR_DEFAULT);
            if (raw is null) return null;
            return DataConverter.ConvertToDataType(DataType, raw);
        });
    }

    /// <summary>Maximum string or array length (the <c>@maxLength</c> attr).
    /// ADR-0039: resolving — a concrete field inherits <c>@maxLength</c> from an abstract base.</summary>
    public long? MaxLength
    {
        get
        {
            var v = Attr(FIELD_ATTR_MAX_LENGTH);
            return v is long l ? l : null;
        }
    }

    /// <summary>Numeric precision (the <c>@precision</c> attr).
    /// ADR-0039: resolving — inheritable via extends (abstract decimal base).</summary>
    public long? Precision
    {
        get
        {
            var v = Attr(FIELD_ATTR_PRECISION);
            return v is long l ? l : null;
        }
    }

    /// <summary>Numeric scale (the <c>@scale</c> attr).
    /// ADR-0039: resolving — inheritable via extends (abstract decimal base).</summary>
    public long? Scale
    {
        get
        {
            var v = Attr(FIELD_ATTR_SCALE);
            return v is long l ? l : null;
        }
    }

    /// <summary>True if <c>@unique: true</c> is the effective value on the field (column-level unique).
    /// ADR-0039: resolving — inheritable via extends.</summary>
    public bool Unique => Attr(FIELD_ATTR_UNIQUE) is true;

    /// <summary>
    /// FR-013 — true when <c>@readOnly: true</c> is the effective value. A read-only field is
    /// read-after-insert-only: codegen emits a getter only (no public setter), and
    /// the persistence layer omits the column from INSERT / UPDATE. Default false.
    /// ADR-0039: resolving — a concrete field may inherit <c>@readOnly</c> from an abstract
    /// base via extends (TS codegen reads <c>field.attr(FIELD_ATTR_READ_ONLY)</c>); the own-only
    /// read lives in the loader's declared-layer validation pass, not this codegen/runtime getter.
    /// </summary>
    public bool ReadOnly => Attr(FIELD_ATTR_READ_ONLY) is true;

    /// <summary>
    /// Issue #203 — the effective <c>@autoSet</c> semantics for a timestamp-like field
    /// (<c>"onCreate"</c> or <c>"onUpdate"</c>), or <see langword="null"/> when unset. The
    /// generated CRUD owns these columns and stamps <c>now()</c>: insert stamps every
    /// onCreate AND onUpdate column; update stamps onUpdate only (never rewriting an
    /// onCreate/created-at column). ADR-0039: resolving — a concrete field may inherit
    /// <c>@autoSet</c> from an abstract base (e.g. a shared <c>BaseEntity.createdAt</c>).
    /// </summary>
    public string? AutoSet => Attr(FIELD_ATTR_AUTO_SET) as string;

    /// <summary>
    /// Own member symbols of an enum-subtype field (the <c>@values</c> attr),
    /// or <see langword="null"/> when not set on this node (e.g. a concrete field
    /// that inherits via <c>extends:</c>). ADR-0039: intentionally OWN-only — the
    /// resolving companion is <see cref="EffectiveEnumValues"/>, which every
    /// effective read (codegen / extract) must use.
    /// </summary>
    public IReadOnlyList<string>? EnumValues => OwnAttr(FIELD_ATTR_VALUES) switch
    {
        IReadOnlyList<string> ss => ss,
        IReadOnlyList<object?> os => os.OfType<string>().ToList(),
        _ => null,
    };

    /// <summary>
    /// Effective enum member symbols: own <c>@values</c> first, then the
    /// inherited (super) values. Returns <see langword="null"/> when neither
    /// this field nor any super carries <c>@values</c>.
    /// </summary>
    public IReadOnlyList<string>? EffectiveEnumValues =>
        EnumValues ?? (ResolveSuper()?.EnumValues);

    /// <summary>
    /// True if the field is required (NOT NULL).
    /// Checks both <c>@required: true</c> attr and <c>validator.required</c> children.
    /// Mirrors TS <c>MetaField.isRequired</c> getter.
    /// ADR-0039: resolving — both the <c>@required</c> attr and the validator set
    /// (via <see cref="Validators"/>) are the effective (own + inherited) forms.
    /// </summary>
    public bool IsRequired
    {
        get
        {
            if (Attr(FIELD_ATTR_REQUIRED) is true) return true;
            return Validators().Any(v => v.IsRequired());
        }
    }

    // -------------------------------------------------------------------------
    // Value SPI (object model) — read/write this field's value on a backing object
    // -------------------------------------------------------------------------

    /// <summary>
    /// Read this field's value from a backing object. <paramref name="name"/>
    /// defaults to this field's own <see cref="MetaData.Name"/> (override to read a
    /// differently keyed slot).
    ///
    /// Dispatches on backing kind, AOT-safe (no reflection):
    ///   - <see cref="ValueObject"/> → reads through its map.
    ///   - <see cref="ITypedFieldAccessor"/> → delegates to the type's own
    ///     reflection-free typed accessor (the bound-type lane).
    ///
    /// Any other object kind throws — production never falls back to
    /// <c>PropertyInfo</c> reflection (ADR-0001 / .NET-AOT). A bound type must
    /// expose <see cref="ITypedFieldAccessor"/> to participate in the SPI.
    /// </summary>
    public object? GetValue(object obj, string? name = null)
    {
        var key = name ?? Name;
        return obj switch
        {
            ValueObject vo => vo.Get(key),
            ITypedFieldAccessor a => a.GetFieldValue(key),
            _ => throw new InvalidOperationException(
                $"Cannot read field '{key}' from backing type '{obj.GetType().Name}': " +
                "it is neither a ValueObject nor an ITypedFieldAccessor. Production is " +
                "reflection-free (AOT-safe); a bound type must implement ITypedFieldAccessor."),
        };
    }

    /// <summary>
    /// Write <paramref name="value"/> into a backing object under <paramref name="name"/>
    /// (defaults to this field's own <see cref="MetaData.Name"/>). No coercion here;
    /// nested objects / arrays are stored as-given (the consumer recurses for nested
    /// OBJECT fields: resolve the child via <see cref="ObjectRef"/> + NewInstance and
    /// SetValue it). Same AOT-safe dispatch as <see cref="GetValue"/>.
    /// </summary>
    public void SetValue(object obj, object? value, string? name = null)
    {
        var key = name ?? Name;
        switch (obj)
        {
            case ValueObject vo:
                vo.Set(key, value);
                return;
            case ITypedFieldAccessor a:
                a.SetFieldValue(key, value);
                return;
            default:
                throw new InvalidOperationException(
                    $"Cannot write field '{key}' to backing type '{obj.GetType().Name}': " +
                    "it is neither a ValueObject nor an ITypedFieldAccessor. Production is " +
                    "reflection-free (AOT-safe); a bound type must implement ITypedFieldAccessor.");
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
