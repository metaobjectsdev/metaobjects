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
                // FR-011 / Phase B: an absent field with a declared @default fills the value
                // → DEFAULTED (which satisfies a @required field). Generalized to all field
                // kinds: an enum default is its member string as-is; a non-enum default is
                // coerced to the field's kind via Coerce (so @default "0" on field.int yields
                // integer 0). A non-coercible non-enum default is treated as no default.
                if (f.defaultValue() != null) {
                    Object coerced = (f.kind() == FieldKind.ENUM)
                            ? f.defaultValue()
                            : Coerce.scalar(f.defaultValue(), f);
                    if (coerced != Coerce.MALFORMED) {
                        data.put(f.name(), coerced);
                        report.addCoercion(new Coercion(path, "", f.defaultValue(), "default"));
                        report.set(path, FieldRecovery.DEFAULTED);
                        continue;
                    }
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
                // Phase B (array-of-enum): an enum element flows through the SAME enum coercion
                // pipeline a scalar enum uses (extractValue → Coerce.value → coerceEnum), and is
                // CLASSIFIED per element by indexed path (tags[0], tags[1], …) exactly as a scalar
                // enum: RECOVERED / DEFAULTED (via @coerceDefault) / MALFORMED. Non-enum scalar
                // arrays keep their existing behavior (raw element list, no per-element states).
                boolean enumElements = f.kind() == FieldKind.ENUM;
                for (int idx = 0; idx < elements.size(); idx++) {
                    String elemPath = path + "[" + idx + "]";
                    Object v = extractValue(f, elements.get(idx), elemPath, report, o, ci);
                    if (v == Coerce.MALFORMED) {
                        anyMalformed = true;
                        if (enumElements) report.set(elemPath, FieldRecovery.MALFORMED);
                    } else {
                        out.add(v);
                        if (enumElements) report.set(elemPath, classifyCoerced(elemPath, report));
                    }
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
