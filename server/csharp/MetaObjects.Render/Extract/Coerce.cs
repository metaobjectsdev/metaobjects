using System.Globalization;

namespace MetaObjects.Render.Extract;

/// <summary>
/// Stage 7: canonicalize a raw scalar string per its <see cref="FieldSpec"/>.
/// Returns <see cref="Malformed"/> sentinel when the value is present but cannot be coerced
/// to the declared kind or vocabulary.
/// </summary>
public static class Coerce
{
    /// <summary>
    /// Sentinel: the value was present but could not be coerced to the declared kind/vocabulary.
    /// Callers must use <c>ReferenceEquals(result, Coerce.Malformed)</c> for identity checks.
    /// </summary>
    public static readonly object Malformed = new();

    /// <summary>
    /// Canonicalize <paramref name="raw"/> to the native type described by <paramref name="spec"/>.
    /// </summary>
    /// <param name="raw">The raw string from the document. Null is treated as MALFORMED.</param>
    /// <param name="spec">Field descriptor.</param>
    /// <param name="opts">Runtime extraction options (hook, normalizers, aliases, tolerance).</param>
    /// <param name="fieldPath">Dot-separated field path (used as coercion record key).</param>
    /// <param name="report">Accumulator for coercion notes.</param>
    /// <returns>
    /// The coerced value (boxed long / double / bool / string) or <see cref="Malformed"/>.
    /// </returns>
    public static object? Value(
        string? raw,
        FieldSpec spec,
        ExtractOptions opts,
        string fieldPath,
        ExtractionReport report)
    {
        if (raw == null) return Malformed;

        // OnField hook takes priority.
        if (opts.OnField != null)
        {
            object? hooked = opts.OnField(fieldPath, raw, spec);
            if (hooked != null)
            {
                report.AddCoercion(new Coercion(fieldPath, raw, hooked.ToString(), "onField"));
                return hooked;
            }
        }

        // Per-field runtime normalizer: keyed by field path, then by simple name.
        if (!opts.Normalizers.TryGetValue(fieldPath, out var norm))
            opts.Normalizers.TryGetValue(spec.Name, out norm);
        if (norm != null)
        {
            object? normalized = norm(raw);
            if (normalized != null)
            {
                report.AddCoercion(new Coercion(fieldPath, raw, normalized.ToString(), "normalizer"));
                return normalized;
            }
        }

        bool ci = opts.Tolerance != Tolerance.Strict;

        return spec.Kind switch
        {
            FieldKind.Enum    => CoerceEnum(raw, spec, opts, fieldPath, report, ci),
            FieldKind.Int     => CoerceInt(raw, spec, fieldPath, report, ci),
            FieldKind.Long    => CoerceInt(raw, spec, fieldPath, report, ci),
            FieldKind.Double  => CoerceDouble(raw, spec, fieldPath, report, ci),
            FieldKind.Decimal => CoerceDecimal(raw),
            FieldKind.Boolean => CoerceBool(raw, ci),
            _                 => raw,
        };
    }

    /// <summary>
    /// Phase B (generalized <c>@default</c>): coerce a non-enum default string to a field's
    /// scalar kind, with NO side effects (no normalizer/onField hooks, no clamp logging) — the
    /// value originates from metadata, not the model response. Returns the coerced value or the
    /// <see cref="Malformed"/> sentinel. INT/LONG accept an integer or a truncatable finite number;
    /// DOUBLE accepts any finite number; BOOLEAN accepts <c>true|false|yes|no|1|0</c>; STRING (and
    /// any other kind) passes through verbatim. Mirrors the parse semantics of <see cref="Value"/>
    /// without its range-clamp / report machinery.
    /// </summary>
    public static object? Scalar(string? raw, FieldSpec spec)
    {
        if (raw == null) return Malformed;
        switch (spec.Kind)
        {
            case FieldKind.Int:
            case FieldKind.Long:
            {
                string t = raw.Trim();
                if (long.TryParse(t, NumberStyles.Integer, CultureInfo.InvariantCulture, out long n))
                    return n;
                if (double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out double d))
                    return double.IsFinite(d) ? (object)(long)d : Malformed;
                return Malformed;
            }
            case FieldKind.Double:
            {
                if (double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double d))
                    return double.IsFinite(d) ? (object)d : Malformed;
                return Malformed;
            }
            case FieldKind.Decimal:
                return CoerceDecimal(raw);
            case FieldKind.Boolean:
            {
                string t = raw.Trim().ToLowerInvariant();
                return t switch
                {
                    "true" or "yes" or "1" => (object)true,
                    "false" or "no" or "0" => (object)false,
                    _ => Malformed,
                };
            }
            default:
                return raw;   // STRING / ENUM / OBJECT — verbatim
        }
    }

    // ---- private helpers ----

    /// <summary>
    /// FR-011 enum coercion pipeline: exact → normalize → @enumAlias → (reserved fuzzy) →
    /// @coerceDefault → MALFORMED. Resolution mode is <see cref="FieldSpec.Normalize"/> (default
    /// <see cref="NormalizeMode.Strip"/>); under STRICT tolerance (<paramref name="ci"/> == false)
    /// normalization is forced to <see cref="NormalizeMode.None"/> (exact-only), preserving the
    /// case-sensitive STRICT contract. Mirrors the TS coerceEnum.
    /// </summary>
    private static object CoerceEnum(
        string raw,
        FieldSpec spec,
        ExtractOptions opts,
        string path,
        ExtractionReport report,
        bool ci)
    {
        NormalizeMode mode = ci ? spec.Normalize : NormalizeMode.None;

        // 1. exact match.
        if (spec.EnumValues != null)
        {
            foreach (string v in spec.EnumValues)
                if (v == raw) return v;
        }

        // 2. normalized match (skipped when mode == None).
        if (mode != NormalizeMode.None && spec.EnumValues != null)
        {
            string normRaw = Normalize.Enum(raw, mode);
            foreach (string v in spec.EnumValues)
            {
                if (Normalize.Enum(v, mode) == normRaw)
                {
                    report.AddCoercion(new Coercion(path, raw, v, "normalize"));
                    return v;
                }
            }
        }

        // 3. @enumAlias — runtime aliases win over schema; alias keys normalized by the mode.
        var aliasTarget = LookupAlias(raw, spec, opts, mode);
        if (aliasTarget != null)
        {
            string? schemaTarget = LookupAliasIn(raw, spec.EnumAlias, mode);
            string kind =
                aliasTarget.Value.FromRuntime && schemaTarget != null && schemaTarget != aliasTarget.Value.Target
                    ? "runtime-alias-override"
                    : "alias";
            report.AddCoercion(new Coercion(path, raw, aliasTarget.Value.Target, kind));
            return aliasTarget.Value.Target;
        }

        // 4. reserved fuzzy slot — NOT implemented (see FR-011 spec "Out of scope").

        // 5. @coerceDefault — present-but-uncoercible fallback to a valid member → DEFAULTED.
        if (spec.CoerceDefault != null && spec.EnumValues != null && spec.EnumValues.Contains(spec.CoerceDefault))
        {
            report.AddCoercion(new Coercion(path, raw, spec.CoerceDefault, "coerceDefault"));
            return spec.CoerceDefault;
        }

        // 6. MALFORMED.
        return Malformed;
    }

    /// <summary>
    /// Resolve <paramref name="raw"/> against the merged alias maps (runtime wins), comparing keys
    /// under <paramref name="mode"/>. Returns the target member + whether the winning hit came from
    /// the runtime map. Mirrors TS lookupAlias.
    /// </summary>
    private static (string Target, bool FromRuntime)? LookupAlias(
        string raw, FieldSpec spec, ExtractOptions opts, NormalizeMode mode)
    {
        string? runtime = LookupAliasIn(raw, opts.Aliases, mode);
        if (runtime != null) return (runtime, true);
        string? schema = LookupAliasIn(raw, spec.EnumAlias, mode);
        if (schema != null) return (schema, false);
        return null;
    }

    /// <summary>Find <paramref name="raw"/> in an alias map, matching keys exactly first then under <paramref name="mode"/> normalization.</summary>
    private static string? LookupAliasIn(string raw, IReadOnlyDictionary<string, string>? aliases, NormalizeMode mode)
    {
        if (aliases == null) return null;
        if (aliases.TryGetValue(raw, out string? exact)) return exact;
        if (mode == NormalizeMode.None) return null;
        string normRaw = Normalize.Enum(raw, mode);
        foreach (var kv in aliases)
            if (Normalize.Enum(kv.Key, mode) == normRaw) return kv.Value;
        return null;
    }

    private static object CoerceInt(string raw, FieldSpec spec, string path, ExtractionReport report, bool lenient)
    {
        string trimmed = raw.Trim();

        // Try integer parse first (matches Java's Long.parseLong).
        if (long.TryParse(trimmed, NumberStyles.Integer, CultureInfo.InvariantCulture, out long n))
        {
            return Clamp((double)n, spec, path, report, asLong: true, lenient);
        }

        // Fallback: try double parse (matches Java's Double.parseDouble fallback).
        // Use Number style without AllowThousands to match Java's strict numeric format.
        if (double.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out double d))
        {
            return Clamp(d, spec, path, report, asLong: true, lenient);
        }

        return Malformed;
    }

    private static object CoerceDouble(string raw, FieldSpec spec, string path, ExtractionReport report, bool lenient)
    {
        // Use Float style (no thousands separator) with InvariantCulture to match
        // Java's Double.parseDouble behavior. NaN and Infinity parse successfully under
        // NumberStyles.Float, so the finite guard in Clamp() is essential.
        if (double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double d))
        {
            return Clamp(d, spec, path, report, asLong: false, lenient);
        }
        return Malformed;
    }

    // DECIMAL (field.decimal): parse precision-exact as System.Decimal — NOT through
    // double (which would lose precision). InvariantCulture; no range clamp (decimal
    // fields carry no min/max). Present-but-unparseable → MALFORMED.
    private static object CoerceDecimal(string raw)
    {
        if (decimal.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out decimal d))
            return d;
        return Malformed;
    }

    /// <summary>
    /// Apply the field's @min/@max range (sourced from its NumericValidator). Under LENIENT tolerance
    /// an out-of-range value is CLAMPED to the bound (recorded as a "clamp" coercion); under STRICT
    /// tolerance it is <see cref="Malformed"/> (the validator's "value out of range" contract — surfaced
    /// via ExtractionResult.OrThrow). Cross-port: ports must match the lenient-clamp / strict-reject split.
    /// </summary>
    private static object Clamp(double n, FieldSpec spec, string path, ExtractionReport report, bool asLong, bool lenient)
    {
        // Non-finite values (NaN, ±Infinity) → MALFORMED. Load-bearing cross-port parity fix.
        if (!double.IsFinite(n)) return Malformed;

        double c = n;
        if (spec.Min != null && c < spec.Min.Value) c = spec.Min.Value;
        if (spec.Max != null && c > spec.Max.Value) c = spec.Max.Value;

        // ReSharper disable once CompareOfFloatsByEqualityOperator
        if (c != n)
        {
            if (!lenient) return Malformed;   // STRICT: out-of-range is invalid, not silently clamped
            report.AddCoercion(new Coercion(path, n.ToString(CultureInfo.InvariantCulture),
                c.ToString(CultureInfo.InvariantCulture), "clamp"));
        }

        return asLong ? (object)(long)c : c;
    }

    private static object CoerceBool(string raw, bool ci)
    {
        string t = ci ? raw.Trim().ToLowerInvariant() : raw.Trim();
        return t switch
        {
            "true" or "yes" or "1"  => (object)true,
            "false" or "no" or "0"  => (object)false,
            _                       => Malformed,
        };
    }
}
