package com.metaobjects.render.recover;

import java.util.Map;
import java.util.function.Function;

/** Stage 7: canonicalize a raw scalar string per its FieldSpec. Returns MALFORMED sentinel when present-but-uncoercible. */
public final class Coerce {
    private Coerce() {}

    /** Sentinel: the value was present but could not be coerced to the declared kind/vocabulary. */
    public static final Object MALFORMED = new Object();

    public static Object value(String raw, FieldSpec spec, RecoverOptions opts, String fieldPath, RecoveryReport report) {
        if (raw == null) return MALFORMED;
        if (opts.onField() != null) {
            Object hooked = opts.onField().coerce(fieldPath, raw, spec);
            if (hooked != null) {
                report.addCoercion(new Coercion(fieldPath, raw, String.valueOf(hooked), "onField"));
                return hooked;
            }
        }
        // Per-field runtime normalizer (bounded 20% surface). Keyed by field path, then simple name.
        Function<String, Object> norm = opts.normalizers().get(fieldPath);
        if (norm == null) norm = opts.normalizers().get(spec.name());
        if (norm != null) {
            Object normalized = norm.apply(raw);
            if (normalized != null) {
                report.addCoercion(new Coercion(fieldPath, raw, String.valueOf(normalized), "normalizer"));
                return normalized;
            }
        }
        boolean ci = opts.tolerance() != Tolerance.STRICT;
        return switch (spec.kind()) {
            case ENUM -> coerceEnum(raw, spec, opts, fieldPath, report, ci);
            case INT, LONG -> coerceInt(raw, spec, fieldPath, report);
            case DOUBLE -> coerceDouble(raw, spec, fieldPath, report);
            case BOOLEAN -> coerceBool(raw, ci);
            default -> raw;
        };
    }

    /**
     * Phase B (generalized {@code @default}): coerce a non-enum default string to a field's
     * scalar kind, with NO side effects (no normalizer/onField hooks, no clamp logging) — the
     * value originates from metadata, not the model response. Returns the coerced value or the
     * {@link #MALFORMED} sentinel. INT/LONG accept an integer or a truncatable number; DOUBLE
     * accepts any finite number; BOOLEAN accepts {@code true|false|yes|no|1|0}; STRING (and any
     * other kind) passes through verbatim. Mirrors the parse semantics of {@link #value} without
     * its range-clamp / report machinery.
     */
    public static Object scalar(String raw, FieldSpec spec) {
        if (raw == null) return MALFORMED;
        return switch (spec.kind()) {
            case INT, LONG -> {
                String t = raw.trim();
                try { yield Long.parseLong(t); }
                catch (NumberFormatException e) {
                    try {
                        double d = Double.parseDouble(t);
                        yield Double.isFinite(d) ? (Object) (long) d : MALFORMED;
                    } catch (NumberFormatException e2) { yield MALFORMED; }
                }
            }
            case DOUBLE -> {
                try {
                    double d = Double.parseDouble(raw.trim());
                    yield Double.isFinite(d) ? (Object) d : MALFORMED;
                } catch (NumberFormatException e) { yield MALFORMED; }
            }
            case BOOLEAN -> {
                String t = raw.trim().toLowerCase();
                yield switch (t) {
                    case "true", "yes", "1" -> Boolean.TRUE;
                    case "false", "no", "0" -> Boolean.FALSE;
                    default -> MALFORMED;
                };
            }
            default -> raw;   // STRING / ENUM / OBJECT — verbatim
        };
    }

    /**
     * FR-011 enum coercion pipeline: exact &rarr; normalize &rarr; {@code @enumAlias} &rarr;
     * (reserved fuzzy) &rarr; {@code @coerceDefault} &rarr; MALFORMED. Resolution mode is
     * {@link FieldSpec#normalize()} (default {@code strip}); under STRICT tolerance
     * ({@code ci == false}) normalization is forced to {@code none} (exact-only), preserving the
     * case-sensitive STRICT contract. Mirrors the TS/C# coerceEnum.
     */
    private static Object coerceEnum(String raw, FieldSpec spec, RecoverOptions opts,
                                     String path, RecoveryReport report, boolean ci) {
        String mode = ci ? spec.normalize() : Normalize.NONE;

        // 1. exact match.
        if (spec.enumValues() != null) {
            for (String v : spec.enumValues()) {
                if (v.equals(raw)) return v;
            }
        }

        // 2. normalized match (skipped when mode == none).
        if (!Normalize.NONE.equals(mode) && spec.enumValues() != null) {
            String normRaw = Normalize.enumValue(raw, mode);
            for (String v : spec.enumValues()) {
                if (Normalize.enumValue(v, mode).equals(normRaw)) {
                    report.addCoercion(new Coercion(path, raw, v, "normalize"));
                    return v;
                }
            }
        }

        // 3. @enumAlias — runtime aliases win over schema; alias keys matched under the mode.
        String runtimeTarget = lookupAliasIn(raw, opts.aliases(), mode);
        if (runtimeTarget != null) {
            String schemaTarget = lookupAliasIn(raw, spec.enumAlias(), mode);
            String kind = (schemaTarget != null && !schemaTarget.equals(runtimeTarget))
                    ? "runtime-alias-override" : "alias";
            report.addCoercion(new Coercion(path, raw, runtimeTarget, kind));
            return runtimeTarget;
        }
        String schemaTarget = lookupAliasIn(raw, spec.enumAlias(), mode);
        if (schemaTarget != null) {
            report.addCoercion(new Coercion(path, raw, schemaTarget, "alias"));
            return schemaTarget;
        }

        // 4. reserved fuzzy slot — NOT implemented (FR-011 spec "Out of scope").

        // 5. @coerceDefault — present-but-uncoercible fallback to a valid member → DEFAULTED.
        if (spec.coerceDefault() != null && spec.enumValues() != null
                && spec.enumValues().contains(spec.coerceDefault())) {
            report.addCoercion(new Coercion(path, raw, spec.coerceDefault(), "coerceDefault"));
            return spec.coerceDefault();
        }

        // 6. MALFORMED.
        return MALFORMED;
    }

    /**
     * Find {@code raw} in an alias map, matching keys exactly first then under {@code mode}
     * normalization. Returns the target member, or {@code null} when no key matches.
     */
    private static String lookupAliasIn(String raw, Map<String, String> aliases, String mode) {
        if (aliases == null || aliases.isEmpty()) return null;
        String exact = aliases.get(raw);
        if (exact != null) return exact;
        if (Normalize.NONE.equals(mode)) return null;
        String normRaw = Normalize.enumValue(raw, mode);
        for (Map.Entry<String, String> e : aliases.entrySet()) {
            if (Normalize.enumValue(e.getKey(), mode).equals(normRaw)) return e.getValue();
        }
        return null;
    }

    private static Object coerceInt(String raw, FieldSpec spec, String path, RecoveryReport report) {
        try {
            long n = Long.parseLong(raw.trim());
            return clamp((double) n, spec, path, report, true);
        } catch (NumberFormatException e) {
            try { return clamp(Double.parseDouble(raw.trim()), spec, path, report, true); }
            catch (NumberFormatException e2) { return MALFORMED; }
        }
    }

    private static Object coerceDouble(String raw, FieldSpec spec, String path, RecoveryReport report) {
        // NOTE (cross-port): Java's Double.parseDouble accepts type suffixes ("42f"/"42d") and
        // "Infinity"/"NaN"; non-finite results are rejected by clamp(). Port authors: match the
        // finite-only + numeric classification, not Java's exact suffix tolerance.
        try { return clamp(Double.parseDouble(raw.trim()), spec, path, report, false); }
        catch (NumberFormatException e) { return MALFORMED; }
    }

    private static Object clamp(double n, FieldSpec spec, String path, RecoveryReport report, boolean asLong) {
        if (!Double.isFinite(n)) return MALFORMED;   // NaN, ±Infinity → MALFORMED (cross-port classification parity)
        double c = n;
        if (spec.min() != null && c < spec.min()) c = spec.min();
        if (spec.max() != null && c > spec.max()) c = spec.max();
        if (c != n) report.addCoercion(new Coercion(path, String.valueOf(n), String.valueOf(c), "clamp"));
        return asLong ? (Object) (long) c : (Object) c;
    }

    private static Object coerceBool(String raw, boolean ci) {
        String t = ci ? raw.trim().toLowerCase() : raw.trim();
        return switch (t) {
            case "true", "yes", "1" -> Boolean.TRUE;
            case "false", "no", "0" -> Boolean.FALSE;
            default -> MALFORMED;
        };
    }
}
