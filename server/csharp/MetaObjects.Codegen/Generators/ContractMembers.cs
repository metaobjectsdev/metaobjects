// The attributes and type references a generated member carries, shared by every generator that
// writes a model member: the entity, value-object and TPH classes (EntityGenerator) and the create
// and update records (ContractTypesGenerator). One copy, so a create record validates and binds the
// wire exactly as the entity it creates does.
//
// What lives here: the validation DataAnnotations a field's validators and attributes imply
// ([MaxLength], [StringLength], [Range], [RegularExpression], [EmailAddress], array counts), the
// per-property wire converters (decimal, duration, strict uri/inet), and the type a property names
// for an enum or a map value. Each method is what EntityGenerator wrote inline before, moved
// unchanged. Eject hands it over with either generator, as a companion.

using MetaObjects.Codegen.Writer;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Validator.ValidatorConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>The attributes and type references a generated model member carries (see the file header).</summary>
public static class ContractMembers
{
    // FR-019 — the C# enum type a property of <field> is typed by:
    //   • shared (root-level abstract, non-@provided) → the materialized type, global::-qualified
    //     in its package's namespace (rc.19 R65).
    //   • @provided → <cfg.ProvidedEnumNamespace>.<Name> (codegen error if unset).
    //   • inline (the common case) → the per-object nested <Entity><Field> type name.
    public static string EnumPropertyTypeName(MetaObject owner, MetaField field, GenConfig config)
    {
        if (Fr019SharedEnum.SharedEnumForField(field) is { } shared)
            return Fr019SharedEnum.SharedEnumTypeReference(shared, config);
        return CSharpNaming.EnumTypeName(owner, field);
    }

    // #234 — true iff FIELD is a (single, non-array) STRICT field.uri / field.inet — the fields
    // carrying the generated [JsonConverter] + backing MetaNetValidation. A @lenient uri/inet is a
    // plain string with no converter, so it does not count. Single SSOT predicate for both the
    // per-entity emit gate and the per-property attribute guard (mirrors the Java/Kotlin ports'
    // own isStrictNetField).
    public static bool IsStrictNetField(MetaField field) =>
        !field.ResolvedIsArray()
        && (field.SubType == FIELD_SUBTYPE_URI || field.SubType == FIELD_SUBTYPE_INET)
        && !CSharpNaming.IsLenientNet(field);

    // #234 — write the [JsonConverter(typeof(…))] binding a strict field.uri / field.inet property
    // to the same-namespace generated MetaNetValidation converter. Nothing for a @lenient uri/inet
    // (a plain string) or any other field. An @isArray uri/inet (element-wise converter) is a
    // follow-up (no validation-conformance case).
    public static void WriteNetConverterAttribute(CsWriter w, MetaField field)
    {
        if (!IsStrictNetField(field)) return; // strict predicate guarantees a non-array uri/inet
        if (field.SubType == FIELD_SUBTYPE_URI)
            w.Line("[JsonConverter(typeof(MetaNetValidation.AbsoluteUriJsonConverter))]");
        else if (field.SubType == FIELD_SUBTYPE_INET)
            w.Line("[JsonConverter(typeof(MetaNetValidation.IPAddressJsonConverter))]");
    }

    // true iff FIELD is a field.duration (single or @isArray): a System.TimeSpan property carrying
    // the per-property ISO-8601 converter.
    public static bool IsDurationField(MetaField field) =>
        field.SubType == FIELD_SUBTYPE_DURATION && CSharpNaming.DbColumnTypeClrOverride(field) is null;

    // Under `wire.durations: iso` the per-property converter writes and reads ISO-8601 (host JSON
    // options cannot drop a property attribute). One attribute serves TimeSpan, TimeSpan? and
    // IList<TimeSpan>. Under the default `native` there is no attribute: System.Text.Json's own
    // TimeSpan form ("01:30:00") is the wire form, both ways.
    public static void WriteDurationConverterAttribute(CsWriter w, MetaField field, WireFormat wire)
    {
        if (wire.Durations == DurationWireForm.Iso && IsDurationField(field)) w.Line("[DurationWire.Iso]");
    }

    // true iff FIELD surfaces as a CLR decimal (single or @isArray) and so carries the
    // per-property wire converter. A jsonb override keeps the JsonDocument type, not decimal.
    public static bool IsDecimalWireField(MetaField field) =>
        field.SubType == FIELD_SUBTYPE_DECIMAL && CSharpNaming.DbColumnTypeClrOverride(field) is null;

    // The per-property converter: host JSON options cannot drop it. `required` decides which
    // closed type the property has (decimal, decimal?, IList<decimal>). Under the default
    // `wire.decimals: native` (ADR-0019 Amendment 2) it writes what System.Text.Json writes, a
    // JSON number, and keeps only the input rules; `string` writes the canonical string.
    public static void WriteDecimalConverterAttribute(CsWriter w, MetaField field, bool nullable, WireFormat wire)
    {
        if (!IsDecimalWireField(field)) return;
        if (wire.Decimals == DecimalWireForm.Native)
        {
            w.Line(field.Precision is long p
                ? $"[DecimalWire.Number({p}, {field.Scale ?? 0})]"
                : "[DecimalWire.Number]");
            return;
        }
        // W3: a declared @precision and @scale bound the input; the attribute carries both.
        if (field.Precision is long precision)
        {
            w.Line($"[DecimalWire.Declared({precision}, {field.Scale ?? 0})]");
            return;
        }
        var converter = field.ResolvedIsArray() ? "DecimalListJsonConverter"
            : nullable ? "NullableDecimalJsonConverter" : "DecimalJsonConverter";
        w.Line($"[System.Text.Json.Serialization.JsonConverter(typeof(DecimalWire.{converter}))]");
    }

    // String length + pattern DataAnnotations for a string scalar, combining the field
    // @maxLength attr with validator.length (@min/@max) and validator.regex (@pattern).
    //
    // Length: when both a validator.length @min AND a maximum (@maxLength or validator.length
    // @max) apply, emit a single [StringLength(max, MinimumLength = min)] — the form
    // TryValidateObject enforces on BOTH ends. Validator-@min-only → [MinLength]; max-only →
    // [MaxLength] (preserving the existing @maxLength semantics).
    //
    // FR-036 A3 — when @maxLength AND validator.length @max both apply, the effective max is
    // the STRICTEST (min of the two), not one-wins.
    //
    // FR-036 A1 — <paramref name="requiredMinFloor"/> is the implicit non-empty floor for a
    // @required string (1), applied ONLY when no validator.length @min was authored at all.
    // An explicitly authored @min is always AUTHORITATIVE over the floor (#224 / ADR-0044):
    // when present it is used as-is (never raised to the floor), and an authored @min: 0
    // opts back to presence-only, emitting no minimum constraint whatsoever. When the floor
    // does apply (no @min authored), it becomes a standalone [MinLength] alongside the
    // [MaxLength] (so the max attribute is undisturbed).
    public static void WriteStringValidatorAttributes(
        CsWriter w, MetaField field, long requiredMinFloor = 0)
    {
        // ADR-0036 Wave 3 — @stringFormat narrows a plain string to a closed validated
        // format. The canonical matcher per format lives HERE (codegen), never author
        // validator.regex (cross-language regex engines diverge). The field stays a plain
        // string: email → [EmailAddress]; hostname → the canonical RFC-1123 [RegularExpression].
        // ADR-0039: resolving — @stringFormat may be inherited via extends (TS reads field.attr).
        switch (field.Attr(FIELD_ATTR_STRING_FORMAT) as string)
        {
            case STRING_FORMAT_EMAIL:
                w.Line("[EmailAddress]");
                break;
            case STRING_FORMAT_HOSTNAME:
                w.Line($"[RegularExpression(@\"{CSharpNaming.HostnameRegex}\")]");
                break;
        }

        long? validatorMin = null;
        long? max = field.MaxLength;
        foreach (var v in field.Validators())
        {
            if (v.SubType == VALIDATOR_SUBTYPE_LENGTH)
            {
                if (v.Min is long lmin)
                    validatorMin = validatorMin is long curMin ? System.Math.Max(curMin, lmin) : lmin;
                // FR-036 A3 — strictest-wins: effective max = min(@maxLength, validator.length @max).
                if (v.Max is long lmax)
                    max = max is long curMax ? System.Math.Min(curMax, lmax) : lmax;
            }
            else if (v.SubType == VALIDATOR_SUBTYPE_REGEX
                     && v is MetaRegexValidator { Pattern: { } pattern })
            {
                // FR-036 Pin-2 — ALWAYS anchor the emitted pattern as a FULL match ^(?:…)$.
                // .NET's RegularExpressionAttribute is valid only when the match starts at
                // index 0 AND spans the whole value; for an UNanchored ordered-alternation
                // whose earlier branch is a prefix of a later one (e.g. (a|ab) vs "ab") the
                // engine matches the shorter branch ("a", length 1 ≠ 2) and REJECTS a string
                // the anchored TS/Python (^(?:…)$) and Java/Kotlin (Matcher.matches) ports
                // ACCEPT. Wrapping forces the engine to backtrack to a full match. Redundant
                // on an already-anchored authored pattern (^(?:^…$)$ matches identically).
                w.Line($"[RegularExpression(\"^(?:{EscapeAttrString(pattern)})$\")]");
            }
        }

        long? min = validatorMin;
        if (requiredMinFloor > 0)
        {
            // FR-036 A1 — the @required non-empty floor applies ONLY when no
            // validator.length @min was authored at all. An explicitly authored
            // @min is always AUTHORITATIVE over the implicit floor (#224 /
            // ADR-0044): @min: 0 opts back to presence-only and, per the
            // cross-port emission pin, emits NO minimum constraint at all (no
            // [MinLength(0)] / MinimumLength = 0) — cleanest, deterministic
            // output across ports. An authored @min > 0 already satisfies
            // (exceeds) the floor and needs no further clamping.
            min = validatorMin switch
            {
                null => requiredMinFloor,
                0 => null,
                _ => validatorMin,
            };
        }

        if (min is long mn && max is long mx)
        {
            // A validator.length @min + a max → a single [StringLength] gating both ends.
            // A pure required-floor min (no validator @min) keeps [MaxLength] and adds a
            // standalone [MinLength], leaving the max attribute unchanged.
            if (validatorMin is not null)
                w.Line($"[StringLength({mx}, MinimumLength = {mn})]");
            else
            {
                w.Line($"[MaxLength({mx})]");
                w.Line($"[MinLength({mn})]");
            }
        }
        else if (min is long mn2)
            w.Line($"[MinLength({mn2})]");
        else if (max is long mx2)
            w.Line($"[MaxLength({mx2})]");
    }

    // Numeric value bounds for a non-string scalar: validator.numeric (@min/@max) →
    // [Range(min, max)]. Both bounds present in the canonical corpus; when only one is
    // declared the other defaults to the type's extreme so the single bound still gates.
    public static void WriteNumericValidatorAttributes(CsWriter w, MetaField field)
    {
        foreach (var v in field.Validators())
        {
            if (v.SubType != VALIDATOR_SUBTYPE_NUMERIC) continue;
            if (v.Min is null && v.Max is null) continue;
            long lo = v.Min ?? long.MinValue;
            long hi = v.Max ?? long.MaxValue;
            w.Line($"[Range({lo}, {hi})]");
            return;
        }
    }

    // Element-count bounds for an array field: validator.array (@min/@max) →
    // [MinLength(min)] + [MaxLength(max)] on the List<T> property.
    public static void WriteArrayValidatorAttributes(CsWriter w, MetaField field)
    {
        foreach (var v in field.Validators())
        {
            if (v.SubType != VALIDATOR_SUBTYPE_ARRAY) continue;
            if (v.Min is long amin) w.Line($"[MinLength({amin})]");
            if (v.Max is long amax) w.Line($"[MaxLength({amax})]");
            return;
        }
    }

    // Escapes a regex pattern or default for embedding in a C# string-literal attribute argument.
    // A raw newline, any other control character, or a Unicode line separator would end the
    // literal and emit source that does not compile.
    public static string EscapeAttrString(string s)
    {
        var sb = new System.Text.StringBuilder(s.Length + 8);
        foreach (var c in s)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case (char)10: sb.Append("\\n"); break; // the escape for a line feed, not a line break
                case (char)13: sb.Append("\\r"); break; // the escape for a carriage return
                case '\t': sb.Append("\\t"); break;
                default:
                    if (char.IsControl(c) || c is '\u2028' or '\u2029')
                        sb.Append("\\u").Append(((int)c).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
                    else
                        sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    // A map's value object is named as the owner's file sees it: global::-qualified when another
    // object shares its short name (both namespaces' `using`s are in scope; CS0104 otherwise).
    public static string MapValueTypeRef(MetaField field, MetaData owner, GenContext ctx) =>
        field.ObjectRef is { Length: > 0 } && ValueObjectNames.ResolveFieldRef(field, ctx.Root) is { } vo
            ? ValueObjectNames.ShortRef(vo, ctx.Root, ctx.Config, ValueObjectNames.Namespace(owner, ctx.Config))
            : CSharpNaming.MapValueType(field, ctx.Root);
}
