package com.metaobjects.render.recover;

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

        Map<String, Object> raw;
        if (schema.format() == Format.JSON) {
            String span = Locate.json(stripped);
            raw = span == null ? Map.of() : new JsonForgivingReader().read(span);
        } else {
            String span = Locate.xml(stripped, schema.rootName(), ci);
            raw = span == null ? Map.of() : new XmlForgivingReader().read(span, ci);
        }

        if (raw.isEmpty() && (stripped.isEmpty() || (schema.format() == Format.JSON ? Locate.json(stripped) == null
                : Locate.xml(stripped, schema.rootName(), ci) == null))) {
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
                report.set(path, f.required() ? FieldRecovery.LOST_REQUIRED : FieldRecovery.LOST_OPTIONAL);
                continue;
            }
            if (f.kind() == FieldKind.OBJECT && present instanceof Map<?, ?> nestedRaw && f.nested() != null) {
                Map<String, Object> nestedData = new LinkedHashMap<>();
                @SuppressWarnings("unchecked")
                Map<String, Object> nr = (Map<String, Object>) nestedRaw;
                extract(f.nested().fields(), nr, path, nestedData, report, o, ci);
                data.put(f.name(), nestedData);
                report.set(path, FieldRecovery.RECOVERED);
                continue;
            }
            String rawStr = present instanceof String s ? s : String.valueOf(present);
            Object coerced = Coerce.value(rawStr, f, o, path, report);
            if (coerced == Coerce.MALFORMED) {
                report.set(path, FieldRecovery.MALFORMED);
            } else {
                data.put(f.name(), coerced);
                report.set(path, FieldRecovery.RECOVERED);
            }
        }
    }

    /** Case-folding lookup honoring tolerance. */
    private static Object lookup(Map<String, Object> raw, String name, boolean ci) {
        if (raw.containsKey(name)) return raw.get(name);
        if (ci) {
            for (var e : raw.entrySet()) if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }
}
