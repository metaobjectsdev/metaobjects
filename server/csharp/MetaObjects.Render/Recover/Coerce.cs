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

    private static object CoerceEnum(
        string raw,
        FieldSpec spec,
        RecoverOptions opts,
        string path,
        RecoveryReport report,
        bool ci)
    {
        if (spec.EnumValues != null)
        {
            foreach (string v in spec.EnumValues)
            {
                if (v == raw) return v;
                if (ci && string.Equals(v, raw, StringComparison.OrdinalIgnoreCase))
                {
                    report.AddCoercion(new Coercion(path, raw, v, "case"));
                    return v;
                }
            }
        }

        string? schemaTarget = spec.EnumAlias != null && spec.EnumAlias.TryGetValue(raw, out var sa) ? sa : null;
        opts.Aliases.TryGetValue(raw, out string? runtimeTarget);

        if (runtimeTarget != null)
        {
            string kind = (schemaTarget != null && schemaTarget != runtimeTarget)
                ? "runtime-alias-override"
                : "alias";
            report.AddCoercion(new Coercion(path, raw, runtimeTarget, kind));
            return runtimeTarget;
        }

        if (schemaTarget != null)
        {
            report.AddCoercion(new Coercion(path, raw, schemaTarget, "alias"));
            return schemaTarget;
        }

        return Malformed;
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
