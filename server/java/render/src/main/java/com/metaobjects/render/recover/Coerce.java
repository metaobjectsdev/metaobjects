package com.metaobjects.render.recover;

/** Stage 7: canonicalize a raw scalar string per its FieldSpec. Returns MALFORMED sentinel when present-but-uncoercible. */
public final class Coerce {
    private Coerce() {}

    /** Sentinel: the value was present but could not be coerced to the declared kind/vocabulary. */
    public static final Object MALFORMED = new Object();

    public static Object value(String raw, FieldSpec spec, RecoverOptions opts, String fieldPath, RecoveryReport report) {
        if (raw == null) return MALFORMED;
        if (opts.onField() != null) {
            Object hooked = opts.onField().coerce(fieldPath, raw, spec);
            if (hooked != null) { report.addCoercion(new Coercion(fieldPath, raw, String.valueOf(hooked), "onField")); return hooked; }
        }
        // Per-field runtime normalizer (bounded 20% surface). Keyed by field path, then simple name.
        java.util.function.Function<String, Object> norm = opts.normalizers().get(fieldPath);
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

    private static Object coerceEnum(String raw, FieldSpec spec, RecoverOptions opts,
                                     String path, RecoveryReport report, boolean ci) {
        if (spec.enumValues() != null) {
            for (String v : spec.enumValues()) {
                if (v.equals(raw)) return v;
                if (ci && v.equalsIgnoreCase(raw)) {
                    report.addCoercion(new Coercion(path, raw, v, "case"));
                    return v;
                }
            }
        }
        String schemaTarget = spec.enumAlias() == null ? null : spec.enumAlias().get(raw);
        String runtimeTarget = opts.aliases().get(raw);
        if (runtimeTarget != null) {
            String kind = (schemaTarget != null && !schemaTarget.equals(runtimeTarget))
                    ? "runtime-alias-override" : "alias";
            report.addCoercion(new Coercion(path, raw, runtimeTarget, kind));
            return runtimeTarget;
        }
        if (schemaTarget != null) {
            report.addCoercion(new Coercion(path, raw, schemaTarget, "alias"));
            return schemaTarget;
        }
        return MALFORMED;
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
