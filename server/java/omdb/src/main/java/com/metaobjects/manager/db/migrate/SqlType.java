package com.metaobjects.manager.db.migrate;

/**
 * Canonical, dialect-neutral SQL type — the cross-language spine (port of migrate-ts SqlType).
 * Both the expected-snapshot builder (metadata->type) and the introspector (db->type) produce this;
 * the differ compares canonical-to-canonical (record equals == sqlTypeEquals); emit re-renders to
 * dialect SQL.
 *
 * Per spec §5.2.
 */
public sealed interface SqlType
        permits SqlType.Text, SqlType.Int, SqlType.Real, SqlType.Numeric, SqlType.Bool,
                SqlType.Timestamp, SqlType.Date, SqlType.Json, SqlType.Blob, SqlType.Uuid {

    /** maxLength == null means unbounded (TEXT). */
    record Text(Integer maxLength) implements SqlType {}

    /** bits: 32 (INTEGER) or 64 (BIGINT). Named Int to avoid shadowing java.lang.Integer. */
    record Int(int bits) implements SqlType {}

    record Real() implements SqlType {}

    record Numeric(Integer precision, Integer scale) implements SqlType {}

    record Bool() implements SqlType {}

    record Timestamp(boolean withTimezone) implements SqlType {}

    record Date() implements SqlType {}

    record Json() implements SqlType {}

    record Blob() implements SqlType {}

    record Uuid() implements SqlType {}

    /**
     * Returns true if changing column type from {@code from} to {@code to} is provably non-lossy.
     * Port of migrate-ts {@code isWidening}. Conservative on purpose — false negatives just mean
     * the user has to explicitly allow the change; false positives could silently corrupt data.
     *
     * Returns false for identical types (caller should not emit a change-column-type in that case;
     * this is defensive).
     *
     * Per spec §6.5.
     */
    static boolean isWidening(SqlType from, SqlType to) {
        if (from.equals(to)) return false;
        if (from.getClass() != to.getClass()) return false;        // cross-kind: lossy

        if (from instanceof Text f && to instanceof Text t) {
            if (f.maxLength() == null) return false;               // unbounded -> bounded: lossy
            if (t.maxLength() == null) return true;                // bounded -> unbounded: widening
            return t.maxLength() >= f.maxLength();                 // bounded both: widening iff new >= old
        }
        if (from instanceof Int f && to instanceof Int t) {
            return t.bits() >= f.bits();
        }
        if (from instanceof Numeric f && to instanceof Numeric t) {
            int fp = f.precision() == null ? 0 : f.precision();
            int fs = f.scale()     == null ? 0 : f.scale();
            int tp = t.precision() == null ? 0 : t.precision();
            int ts = t.scale()     == null ? 0 : t.scale();
            // widening iff precision expands, scale unchanged, and integer-part expands
            return tp >= fp && ts == fs && (tp - ts) >= (fp - fs);
        }

        // Real/Bool/Date/Json/Blob/Uuid/Timestamp: any same-kind difference is not widening
        return false;
    }
}
