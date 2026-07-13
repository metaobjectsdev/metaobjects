package com.metaobjects.render.extract;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Public entry point. Runs the 8-stage pipeline; never throws. */
public final class Extract {
    private Extract() {}

    public static ExtractionOutcome extract(String text, ExtractSchema schema, ExtractOptions opts) {
        ExtractOptions o = opts == null ? ExtractOptions.defaults() : opts;
        ExtractionReport report = new ExtractionReport();
        Map<String, Object> data = new LinkedHashMap<>();

        String stripped = Strip.strip(text);
        boolean ci = o.tolerance() != Tolerance.STRICT;

        // XML rootless (opts.rootless): the payload's fields ARE the top-level elements — there is
        // no enclosing root to locate — so parse the whole stripped text's top-level elements
        // directly. Otherwise locate the <rootName> span as before. JSON is unaffected.
        String span;
        Map<String, Object> raw;
        if (schema.format() == Format.JSON) {
            span = Locate.json(stripped);
            raw = span == null ? Map.of() : new JsonForgivingReader().read(span);
        } else if (o.rootless()) {
            span = stripped.isEmpty() ? null : stripped;
            raw = span == null ? Map.of() : new XmlForgivingReader().readRootless(stripped, ci);
        } else {
            span = Locate.xml(stripped, schema.rootName(), ci);
            raw = span == null ? Map.of() : new XmlForgivingReader().read(span, ci);
        }

        if (raw.isEmpty() && (stripped.isEmpty() || span == null)) {
            report.markEmpty();
        }

        extract(schema.fields(), raw, "", data, report, o, ci);
        return new ExtractionOutcome(data, report);
    }

    private static void extract(List<FieldSpec> fields, Map<String, Object> raw, String prefix,
                                Map<String, Object> data, ExtractionReport report, ExtractOptions o, boolean ci) {
        for (FieldSpec f : fields) {
            String path = prefix.isEmpty() ? f.name() : prefix + "." + f.name();
            // A @xmlText field reads the element's text body (carried under the #text sentinel
            // when the element also has attributes), not a same-named child element.
            Object present = f.textContent()
                    ? raw.get(XmlForgivingReader.TEXT_KEY)
                    : lookup(raw, f.name(), ci);
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
                        report.set(path, FieldExtraction.DEFAULTED);
                        // A default SATISFIES @required, so this field will never appear in
                        // lostRequired() — which is what the generated guards (and
                        // dataOrThrow) key on. Record it separately so "the document did not
                        // answer a required field" stays askable.
                        if (f.required()) report.markDefaultedRequired(path);
                        continue;
                    }
                }
                report.set(path, f.required() ? FieldExtraction.LOST_REQUIRED : FieldExtraction.LOST_OPTIONAL);
                continue;
            }
            if (present == JsonForgivingReader.TRUNCATED) {   // present-but-garbled (empty/cut-off value)
                report.set(path, FieldExtraction.MALFORMED);
                continue;
            }
            if (present == JsonForgivingReader.NULL_LITERAL) {  // explicit JSON null → field is null
                // The JSON null literal is the caller's explicit "no value": leave the field null
                // (do NOT apply @default — an explicit null is a value, not an omission), matching
                // a standard JSON bind. Without this the bare `null` token leaks as the string "null".
                report.set(path, f.required() ? FieldExtraction.LOST_REQUIRED : FieldExtraction.LOST_OPTIONAL);
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
                // enum: EXTRACTED / DEFAULTED (via @coerceDefault) / MALFORMED. Non-enum scalar
                // arrays keep their existing behavior (raw element list, no per-element states).
                boolean enumElements = f.kind() == FieldKind.ENUM;
                for (int idx = 0; idx < elements.size(); idx++) {
                    String elemPath = path + "[" + idx + "]";
                    Object v = extractValue(f, elements.get(idx), elemPath, report, o, ci);
                    if (v == Coerce.MALFORMED) {
                        anyMalformed = true;
                        if (enumElements) report.set(elemPath, FieldExtraction.MALFORMED);
                    } else {
                        out.add(v);
                        if (enumElements) report.set(elemPath, classifyCoerced(elemPath, report));
                    }
                }
                // NOTE (cross-port contract): a MALFORMED array still places its successfully-coerced
                // elements into data (partial extraction), UNLIKE a MALFORMED scalar which is absent from
                // data. Consumers branching on state must account for partial array data.
                data.put(f.name(), out);
                report.set(path, anyMalformed ? FieldExtraction.MALFORMED : FieldExtraction.EXTRACTED);
                continue;
            }
            if (present instanceof List<?>) {           // a list where a singular value was expected
                report.set(path, FieldExtraction.MALFORMED);
                continue;
            }
            Object v = extractValue(f, present, path, report, o, ci);
            if (v == Coerce.MALFORMED) {
                report.set(path, FieldExtraction.MALFORMED);
            } else {
                data.put(f.name(), v);
                // FR-011: a value reached via @coerceDefault (or @default) is DEFAULTED, not EXTRACTED.
                report.set(path, classifyCoerced(path, report));
            }
        }
    }

    /**
     * FR-011: classify a successfully-coerced field. DEFAULTED when its terminal (last-logged)
     * coercion for this path is a default-class fallback ({@code coerceDefault} / {@code default});
     * EXTRACTED otherwise. Nested objects (which log no coercion of their own) classify as
     * EXTRACTED. Mirrors the TS/C# classifyCoerced.
     */
    private static FieldExtraction classifyCoerced(String path, ExtractionReport report) {
        String terminalKind = null;
        for (Coercion c : report.coercions()) {
            if (path.equals(c.fieldPath())) terminalKind = c.kind();
        }
        return ("coerceDefault".equals(terminalKind) || "default".equals(terminalKind))
                ? FieldExtraction.DEFAULTED
                : FieldExtraction.EXTRACTED;
    }

    /** Coerce one (non-array) element: nested-object recursion or scalar coercion. Returns Coerce.MALFORMED on failure. */
    private static Object extractValue(FieldSpec f, Object present, String path,
                                       ExtractionReport report, ExtractOptions o, boolean ci) {
        if (present == JsonForgivingReader.NULL_LITERAL) {
            // A JSON null array element (e.g. [1, null, 3]) carries no value → drop it as malformed
            // rather than letting String.valueOf stringify the sentinel.
            return Coerce.MALFORMED;
        }
        if (f.kind() == FieldKind.OBJECT) {
            if (f.nested() != null && present instanceof Map<?, ?> m) {
                Map<String, Object> nestedData = new LinkedHashMap<>();
                extract(f.nested().fields(), castMap(m), path, nestedData, report, o, ci);
                return nestedData;
            }
            return Coerce.MALFORMED;   // object expected but scalar/non-map present
        }
        // A text element that also carried XML attributes is represented by XmlForgivingReader
        // as a map with the body under TEXT_KEY. A scalar field reads that text (attributes are
        // ignored for scalars — preserving pre-attribute-support behaviour).
        if (present instanceof Map<?, ?> mp && mp.containsKey(XmlForgivingReader.TEXT_KEY)) {
            present = mp.get(XmlForgivingReader.TEXT_KEY);
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
