package com.metaobjects.render.recover;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Public entry point. Runs the 8-stage pipeline; never throws. */
public final class Recover {
    private Recover() {}

    public static RecoverOutcome recover(String text, RecoverSchema schema, RecoverOptions opts) {
        RecoverOptions o = opts == null ? RecoverOptions.defaults() : opts;
        RecoveryReport report = new RecoveryReport();
        Map<String, Object> data = new LinkedHashMap<>();

        String stripped = Strip.strip(text);
        boolean ci = o.tolerance() != Tolerance.STRICT;

        String span = schema.format() == Format.JSON
                ? Locate.json(stripped)
                : Locate.xml(stripped, schema.rootName(), ci);
        Map<String, Object> raw;
        if (span == null) {
            raw = Map.of();
        } else if (schema.format() == Format.JSON) {
            raw = new JsonForgivingReader().read(span);
        } else {
            raw = new XmlForgivingReader().read(span, ci);
        }

        if (raw.isEmpty() && (stripped.isEmpty() || span == null)) {
            report.markEmpty();
        }

        extract(schema.fields(), raw, "", data, report, o, ci);
        return new RecoverOutcome(data, report);
    }

    private static void extract(List<FieldSpec> fields, Map<String, Object> raw, String prefix,
                                Map<String, Object> data, RecoveryReport report, RecoverOptions o, boolean ci) {
        for (FieldSpec f : fields) {
            String path = prefix.isEmpty() ? f.name() : prefix + "." + f.name();
            Object present = lookup(raw, f.name(), ci);
            if (present == null) {
                // FR-011: an absent enum with a declared @default fills the value → DEFAULTED
                // (which satisfies a @required field).
                if (f.kind() == FieldKind.ENUM && f.defaultValue() != null) {
                    data.put(f.name(), f.defaultValue());
                    report.addCoercion(new Coercion(path, "", f.defaultValue(), "default"));
                    report.set(path, FieldRecovery.DEFAULTED);
                    continue;
                }
                report.set(path, f.required() ? FieldRecovery.LOST_REQUIRED : FieldRecovery.LOST_OPTIONAL);
                continue;
            }
            if (present == JsonForgivingReader.TRUNCATED) {   // present-but-garbled (empty/cut-off value)
                report.set(path, FieldRecovery.MALFORMED);
                continue;
            }
            if (f.array()) {
                // An array field: a single non-list value is treated as a one-element array
                // (e.g. a single repeated-XML tag). Each element is coerced/recursed independently.
                List<?> elements = (present instanceof List<?> l) ? l : List.of(present);
                List<Object> out = new ArrayList<>();
                boolean anyMalformed = false;
                for (int idx = 0; idx < elements.size(); idx++) {
                    Object v = extractValue(f, elements.get(idx), path + "[" + idx + "]", report, o, ci);
                    if (v == Coerce.MALFORMED) anyMalformed = true;
                    else out.add(v);
                }
                // NOTE (cross-port contract): a MALFORMED array still places its successfully-coerced
                // elements into data (partial recovery), UNLIKE a MALFORMED scalar which is absent from
                // data. Consumers branching on state must account for partial array data.
                data.put(f.name(), out);
                report.set(path, anyMalformed ? FieldRecovery.MALFORMED : FieldRecovery.RECOVERED);
                continue;
            }
            if (present instanceof List<?>) {           // a list where a singular value was expected
                report.set(path, FieldRecovery.MALFORMED);
                continue;
            }
            Object v = extractValue(f, present, path, report, o, ci);
            if (v == Coerce.MALFORMED) {
                report.set(path, FieldRecovery.MALFORMED);
            } else {
                data.put(f.name(), v);
                // FR-011: a value reached via @coerceDefault (or @default) is DEFAULTED, not RECOVERED.
                report.set(path, classifyCoerced(path, report));
            }
        }
    }

    /**
     * FR-011: classify a successfully-coerced field. DEFAULTED when its terminal (last-logged)
     * coercion for this path is a default-class fallback ({@code coerceDefault} / {@code default});
     * RECOVERED otherwise. Nested objects (which log no coercion of their own) classify as
     * RECOVERED. Mirrors the TS/C# classifyCoerced.
     */
    private static FieldRecovery classifyCoerced(String path, RecoveryReport report) {
        String terminalKind = null;
        for (Coercion c : report.coercions()) {
            if (path.equals(c.fieldPath())) terminalKind = c.kind();
        }
        return ("coerceDefault".equals(terminalKind) || "default".equals(terminalKind))
                ? FieldRecovery.DEFAULTED
                : FieldRecovery.RECOVERED;
    }

    /** Coerce one (non-array) element: nested-object recursion or scalar coercion. Returns Coerce.MALFORMED on failure. */
    private static Object extractValue(FieldSpec f, Object present, String path,
                                       RecoveryReport report, RecoverOptions o, boolean ci) {
        if (f.kind() == FieldKind.OBJECT) {
            if (f.nested() != null && present instanceof Map<?, ?> m) {
                Map<String, Object> nestedData = new LinkedHashMap<>();
                extract(f.nested().fields(), castMap(m), path, nestedData, report, o, ci);
                return nestedData;
            }
            return Coerce.MALFORMED;   // object expected but scalar/non-map present
        }
        String rawStr = present instanceof String s ? s : String.valueOf(present);
        return Coerce.value(rawStr, f, o, path, report);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Map<?, ?> m) { return (Map<String, Object>) m; }

    /** Case-folding lookup honoring tolerance. */
    private static Object lookup(Map<String, Object> raw, String name, boolean ci) {
        if (raw.containsKey(name)) return raw.get(name);
        if (ci) {
            for (var e : raw.entrySet()) if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }
}
