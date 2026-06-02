package com.metaobjects.render.extract;

import java.util.List;
import java.util.Map;

/**
 * One field's extract descriptor. enumValues/enumAlias non-null only for ENUM;
 * min/max non-null only for numeric range constraints; nested non-null only for OBJECT.
 *
 * <p>FR-011 enum extract-hardening fields (enum-only):</p>
 * <ul>
 *   <li>{@code coerceDefault} — fallback member for a present-but-uncoercible value
 *       (terminal pipeline stage → DEFAULTED).</li>
 *   <li>{@code defaultValue} — absent-fill member (the {@code @default} attr; an absent
 *       enum with this set fills the value → DEFAULTED, which satisfies {@code required}).</li>
 *   <li>{@code normalize} — the resolved {@code @normalize} mode string
 *       ({@code none|collapse|strip}); defaults to {@link Normalize#DEFAULT} ("strip").</li>
 * </ul>
 *
 * <p>{@code textContent} marks the field that receives its element's TEXT CONTENT (the
 * {@code @xmlText} marker — see {@link #textContentField}); the extract engine reads it from
 * the {@link XmlForgivingReader#TEXT_KEY} sentinel rather than a same-named child.</p>
 */
public record FieldSpec(
        String name,
        FieldKind kind,
        boolean required,
        boolean array,
        List<String> enumValues,
        Map<String, String> enumAlias,
        Double min,
        Double max,
        ExtractSchema nested,
        String coerceDefault,
        String defaultValue,
        String normalize,
        boolean textContent) {

    public static FieldSpec scalar(String name, FieldKind kind, boolean required) {
        return scalar(name, kind, required, null);
    }

    /**
     * Phase B (generalized {@code @default}): a scalar field carrying an absent-fill
     * {@code @default}. When the field is ABSENT from the model response, tolerant extract
     * coerces this string to {@code kind} and classifies the field {@code DEFAULTED} (which
     * satisfies {@code required}). {@code defaultValue == null} is the no-default case
     * (identical to the back-compat {@link #scalar(String, FieldKind, boolean)} overload).
     */
    public static FieldSpec scalar(String name, FieldKind kind, boolean required, String defaultValue) {
        return new FieldSpec(name, kind, required, false, null, null, null, null, null,
                null, defaultValue, Normalize.DEFAULT, false);
    }

    /**
     * A field that receives its element's TEXT CONTENT — the {@code @xmlText} marker, analogous
     * to JAXB {@code @XmlValue} / Jackson {@code @JacksonXmlText} / .NET {@code [XmlText]}. When the
     * source element carries attributes (and/or children) AND a text body, the lenient XML reader
     * represents it as a map of the attributes plus the body under {@link XmlForgivingReader#TEXT_KEY};
     * a field marked {@code textContent} reads that body (by the {@code #text} sentinel) instead of a
     * same-named child, and the result is stored under the field's own name. Scalar coercion to
     * {@code kind} applies as for a normal scalar. (Meaningless for JSON — never set there.)
     */
    public static FieldSpec textContentField(String name, FieldKind kind, boolean required) {
        return new FieldSpec(name, kind, required, false, null, null, null, null, null,
                null, null, Normalize.DEFAULT, true);
    }

    /**
     * A non-enum SCALAR ARRAY field (e.g. {@code List<String>} / {@code List<Integer>}). Same as
     * {@link #scalar(String, FieldKind, boolean, String)} but with {@code array = true}, so the
     * engine's array branch coerces each element to {@code kind} and stores the element list under
     * {@code name}. (Array-of-enum uses {@link #enumArray} instead — enum elements need the
     * values/alias/coerce pipeline.)
     */
    public static FieldSpec scalarArray(String name, FieldKind kind, boolean required, String defaultValue) {
        return new FieldSpec(name, kind, required, true, null, null, null, null, null,
                null, defaultValue, Normalize.DEFAULT, false);
    }

    /**
     * Build an enum field with its allowed values and optional case/alias map.
     * FR-010 back-compat overload: no coerceDefault/default, default normalize ("strip").
     */
    public static FieldSpec enumField(String name, boolean required,
                                      List<String> values, Map<String, String> aliases) {
        return enumField(name, required, values, aliases, null, Normalize.DEFAULT, null);
    }

    /**
     * Build an enum field with the full FR-011 coercion-pipeline attrs.
     *
     * @param coerceDefault present-but-uncoercible fallback member (or {@code null})
     * @param normalize     the resolved normalization mode ({@code none|collapse|strip});
     *                      {@code null} is treated as {@link Normalize#DEFAULT}
     * @param defaultValue  absent-fill member (or {@code null})
     */
    public static FieldSpec enumField(String name, boolean required,
                                      List<String> values, Map<String, String> aliases,
                                      String coerceDefault, String normalize, String defaultValue) {
        return new FieldSpec(name, FieldKind.ENUM, required, false,
                values == null ? null : List.copyOf(values),
                aliases == null ? Map.of() : Map.copyOf(aliases),
                null, null, null,
                coerceDefault,
                defaultValue,
                normalize == null ? Normalize.DEFAULT : normalize, false);
    }

    /**
     * Phase B (array-of-enum): an enum field that is a {@code List<enum>} ({@code array == true}).
     * Each element is coerced through the SAME enum pipeline a scalar enum uses
     * (exact &rarr; normalize &rarr; {@code @enumAlias} &rarr; {@code @coerceDefault} &rarr; MALFORMED),
     * classified independently by indexed path ({@code tags[0]}, {@code tags[1]}, …). Mirrors
     * {@link #enumField(String, boolean, List, Map, String, String, String)} but with {@code array = true}.
     *
     * @param coerceDefault present-but-uncoercible per-element fallback member (or {@code null})
     * @param normalize     the resolved normalization mode ({@code none|collapse|strip});
     *                      {@code null} is treated as {@link Normalize#DEFAULT}
     * @param defaultValue  absent-fill member for the whole field (or {@code null})
     */
    public static FieldSpec enumArray(String name, boolean required,
                                      List<String> values, Map<String, String> aliases,
                                      String coerceDefault, String normalize, String defaultValue) {
        return new FieldSpec(name, FieldKind.ENUM, required, true,
                values == null ? null : List.copyOf(values),
                aliases == null ? Map.of() : Map.copyOf(aliases),
                null, null, null,
                coerceDefault,
                defaultValue,
                normalize == null ? Normalize.DEFAULT : normalize, false);
    }

    public static FieldSpec range(String name, FieldKind kind, boolean required,
                                  Double min, Double max) {
        return new FieldSpec(name, kind, required, false, null, null, min, max, null,
                null, null, Normalize.DEFAULT, false);
    }

    public static FieldSpec object(String name, boolean required, boolean array, ExtractSchema nested) {
        return new FieldSpec(name, FieldKind.OBJECT, required, array, null, null, null, null, nested,
                null, null, Normalize.DEFAULT, false);
    }
}
