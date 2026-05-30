using System.Globalization;

namespace MetaObjects.Render.Recover;

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
    /// <param name="opts">Runtime recovery options (hook, normalizers, aliases, tolerance).</param>
    /// <param name="fieldPath">Dot-separated field path (used as coercion record key).</param>
    /// <param name="report">Accumulator for coercion notes.</param>
    /// <returns>
    /// The coerced value (boxed long / double / bool / string) or <see cref="Malformed"/>.
    /// </returns>
    public static object? Value(
        string? raw,
        FieldSpec spec,
        RecoverOptions opts,
        string fieldPath,
        RecoveryReport report)
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
            FieldKind.Int     => CoerceInt(raw, spec, fieldPath, report),
            FieldKind.Long    => CoerceInt(raw, spec, fieldPath, report),
            FieldKind.Double  => CoerceDouble(raw, spec, fieldPath, report),
            FieldKind.Boolean => CoerceBool(raw, ci),
            _                 => raw,
        };
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
        RecoverOptions opts,
        string path,
        RecoveryReport report,
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
        string raw, FieldSpec spec, RecoverOptions opts, NormalizeMode mode)
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

    private static object CoerceInt(string raw, FieldSpec spec, string path, RecoveryReport report)
    {
        string trimmed = raw.Trim();

        // Try integer parse first (matches Java's Long.parseLong).
        if (long.TryParse(trimmed, NumberStyles.Integer, CultureInfo.InvariantCulture, out long n))
        {
            return Clamp((double)n, spec, path, report, asLong: true);
        }

        // Fallback: try double parse (matches Java's Double.parseDouble fallback).
        // Use Number style without AllowThousands to match Java's strict numeric format.
        if (double.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out double d))
        {
            return Clamp(d, spec, path, report, asLong: true);
        }

        return Malformed;
    }

    private static object CoerceDouble(string raw, FieldSpec spec, string path, RecoveryReport report)
    {
        // Use Float style (no thousands separator) with InvariantCulture to match
        // Java's Double.parseDouble behavior. NaN and Infinity parse successfully under
        // NumberStyles.Float, so the finite guard in Clamp() is essential.
        if (double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double d))
        {
            return Clamp(d, spec, path, report, asLong: false);
        }
        return Malformed;
    }

    private static object Clamp(double n, FieldSpec spec, string path, RecoveryReport report, bool asLong)
    {
        // Non-finite values (NaN, ±Infinity) → MALFORMED. Load-bearing cross-port parity fix.
        if (!double.IsFinite(n)) return Malformed;

        double c = n;
        if (spec.Min != null && c < spec.Min.Value) c = spec.Min.Value;
        if (spec.Max != null && c > spec.Max.Value) c = spec.Max.Value;

        // ReSharper disable once CompareOfFloatsByEqualityOperator
        if (c != n)
            report.AddCoercion(new Coercion(path, n.ToString(CultureInfo.InvariantCulture),
                c.ToString(CultureInfo.InvariantCulture), "clamp"));

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
