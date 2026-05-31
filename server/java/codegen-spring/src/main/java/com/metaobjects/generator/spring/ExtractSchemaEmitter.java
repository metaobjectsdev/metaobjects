package com.metaobjects.generator.spring;

import com.metaobjects.field.BooleanField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

/**
 * Pure helper that turns a value-object (VO) {@link MetaObject} into Java source
 * strings for the FR-010 extract codegen:
 *
 * <ul>
 *   <li>{@link #schemaLiteral(MetaObject, String, String)} — a {@code new ExtractSchema(...)}
 *       literal ready for insertion into a generated output-parser class.</li>
 *   <li>{@link #constructorArgs(MetaObject)} — the comma-separated argument list for the
 *       generated {@code new <Payload>(...)} call, reading each component from a
 *       {@code Map<String,Object> d} via the {@code ExtractMap} helpers.</li>
 * </ul>
 *
 * <p>Isolating this logic makes both paths unit-testable without running the full
 * generator pipeline. This class is package-private; the Spring output-parser generator
 * will delegate here.</p>
 *
 * <p>Field-kind mapping (mirrors {@link SpringTypeMapper}):
 * <ul>
 *   <li>{@link EnumField} → {@code FieldKind.ENUM} via {@code FieldSpec.enumField}</li>
 *   <li>{@link StringField} → {@code FieldKind.STRING}</li>
 *   <li>{@link IntegerField} → {@code FieldKind.INT}</li>
 *   <li>{@link LongField} → {@code FieldKind.LONG}</li>
 *   <li>{@link DoubleField} → {@code FieldKind.DOUBLE}</li>
 *   <li>{@link BooleanField} → {@code FieldKind.BOOLEAN}</li>
 *   <li>Nested {@link ObjectField} / non-scalar array → {@code FieldKind.STRING}
 *       with a {@code /* FR-010: nested extract deferred *}{@code /} comment (bounded
 *       deferral).</li>
 * </ul>
 */
final class ExtractSchemaEmitter {

    private ExtractSchemaEmitter() { /* no instances */ }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Emit a {@code new ExtractSchema(Format.X, "<rootName>", java.util.List.of(...))}
     * literal for all fields on {@code vo}.
     *
     * @param vo       the payload value-object whose fields drive the schema
     * @param format   {@code "xml"} → {@code Format.XML}; anything else → {@code Format.JSON}
     * @param rootName the logical root name embedded in the schema
     * @return Java source snippet, e.g.
     *         {@code new ExtractSchema(Format.JSON, "Foo", java.util.List.of(...))}
     */
    static String schemaLiteral(MetaObject vo, String format, String rootName) {
        String formatEnum = "xml".equalsIgnoreCase(format) ? "Format.XML" : "Format.JSON";

        List<String> fieldSpecs = new ArrayList<>();
        for (MetaField<?> field : vo.getMetaFields()) {
            fieldSpecs.add(fieldSpecLiteral(field, vo));
        }

        return "new ExtractSchema(" + formatEnum + ", \"" + rootName + "\", java.util.List.of("
            + String.join(", ", fieldSpecs) + "))";
    }

    /**
     * Emit the comma-separated constructor arguments for {@code new <Payload>(...)},
     * reading each field from a {@code Map<String,Object> d} via {@code ExtractMap}.
     *
     * @param vo the payload value-object
     * @return Java source snippet, e.g.
     *         {@code ExtractMap.asString(d, "text"), ExtractMap.asString(d, "confidence")}
     */
    static String constructorArgs(MetaObject vo) {
        List<String> args = new ArrayList<>();
        for (MetaField<?> field : vo.getMetaFields()) {
            args.add(constructorArgForField(field));
        }
        return String.join(", ", args);
    }

    // -------------------------------------------------------------------------
    // Private helpers — schema literal
    // -------------------------------------------------------------------------

    /**
     * Build a {@code FieldSpec.*(...)} call for a single field.
     */
    @SuppressWarnings("rawtypes")
    private static String fieldSpecLiteral(MetaField<?> field, MetaObject owner) {
        String name = field.getName();
        boolean required = isRequired(field);

        if (field instanceof EnumField ef) {
            return enumFieldSpec(name, required, ef, owner);
        }

        // Nested object or array-of-objects: bounded deferral.
        if (field instanceof ObjectField) {
            return "FieldSpec.scalar(\"" + name + "\", FieldKind.STRING, " + required
                + ") /* FR-010: nested extract deferred */";
        }

        // Scalar fallback — same instanceof chain as SpringTypeMapper.
        String kindName = scalarKind(field);
        if (kindName == null) {
            // Unknown field type — fall back to STRING.
            return "FieldSpec.scalar(\"" + name + "\", FieldKind.STRING, " + required
                + ") /* FR-010: unsupported field type, defaulting to STRING */";
        }
        return "FieldSpec.scalar(\"" + name + "\", FieldKind." + kindName + ", " + required + ")";
    }

    /**
     * Build a {@code FieldSpec.enumField(...)} call, including enum values and the
     * alias map (empty map when no {@code @enumAlias} is present).
     */
    private static String enumFieldSpec(String name, boolean required, EnumField field, MetaObject owner) {
        // @values — guaranteed non-null by the loader's ValidationPhase.
        @SuppressWarnings("unchecked")
        List<String> values = (List<String>) field.getMetaAttr(EnumField.ATTR_VALUES).getValue();

        // @enumAlias — optional; produce Map.of() when absent or empty.
        var aliasAttr = field.hasMetaAttr(EnumField.ATTR_ENUM_ALIAS, false)
            ? field.getMetaAttr(EnumField.ATTR_ENUM_ALIAS)
            : null;
        Properties aliases = aliasAttr != null ? (Properties) aliasAttr.getValue() : null;
        String aliasMapLiteral = (aliases != null && !aliases.isEmpty())
            ? buildMapOfLiteral(aliases)
            : "java.util.Map.of()";

        // Build the List.of(...) for enum values.
        List<String> quoted = new ArrayList<>(values.size());
        for (String v : values) quoted.add("\"" + v + "\"");
        String valuesList = "java.util.List.of(" + String.join(", ", quoted) + ")";

        // FR-011: resolve the three new enum args (field → object.value → "strip" for normalize).
        // Keep the back-compat 4-arg form when nothing is set; otherwise emit the 7-arg form
        // (name, required, values, aliases, coerceDefault, normalize, defaultValue).
        String coerceDefault = ownAttrString(field, EnumField.ATTR_COERCE_DEFAULT);
        String defaultValue = ownAttrString(field, EnumField.ATTR_DEFAULT);
        String normalize = resolveNormalize(field, owner);

        if (coerceDefault == null && defaultValue == null && NORMALIZE_DEFAULT.equals(normalize)) {
            return "FieldSpec.enumField(\"" + name + "\", " + required + ", "
                + valuesList + ", " + aliasMapLiteral + ")";
        }

        String cdLit = coerceDefault == null ? "null" : "\"" + escapeJava(coerceDefault) + "\"";
        String normLit = "\"" + normalize + "\"";
        String dvLit = defaultValue == null ? "null" : "\"" + escapeJava(defaultValue) + "\"";

        return "FieldSpec.enumField(\"" + name + "\", " + required + ", "
            + valuesList + ", " + aliasMapLiteral + ", " + cdLit + ", " + normLit + ", " + dvLit + ")";
    }

    /** FR-011 default {@code @normalize} mode ("strip") — mirrors {@link EnumField#NORMALIZE_DEFAULT}. */
    private static final String NORMALIZE_DEFAULT = EnumField.NORMALIZE_DEFAULT;

    /**
     * FR-011: resolve the enum normalization mode for a field — field-level {@code @normalize},
     * else the owning {@code object.value}'s {@code @normalize} (the per-object default), else the
     * global default ("strip"). {@code owner} may be {@code null} (resolution then skips the object
     * tier). Mirrors the TS resolveNormalize and the C# Fr010FieldMapping.ResolveNormalize.
     */
    static String resolveNormalize(MetaField<?> field, MetaObject owner) {
        String fieldMode = ownAttrString(field, EnumField.ATTR_NORMALIZE);
        if (fieldMode != null) return fieldMode;
        String objMode = owner == null ? null : ownAttrString(owner, EnumField.ATTR_NORMALIZE);
        if (objMode != null) return objMode;
        return NORMALIZE_DEFAULT;
    }

    /** The own (non-inherited) string value of an attr on a node, or {@code null} when absent/empty. */
    private static String ownAttrString(com.metaobjects.MetaData node, String attr) {
        if (!node.hasMetaAttr(attr, false)) return null;
        String s = node.getMetaAttr(attr, false).getValueAsString();
        return (s == null || s.isEmpty()) ? null : s;
    }

    /** Escape a value for embedding inside a Java double-quoted string literal. */
    private static String escapeJava(String value) {
        StringBuilder sb = new StringBuilder(value.length() + 4);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"':  sb.append("\\\""); break;
                case '\t': sb.append("\\t"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                default:   sb.append(c);
            }
        }
        return sb.toString();
    }

    /**
     * Emit a {@code java.util.Map.ofEntries(java.util.Map.entry(k, v), ...)} literal
     * from a {@link Properties}. Entries are sorted by key for deterministic output.
     *
     * <p>{@code java.util.Map.of} only has overloads up to 10 key-value pairs; using
     * {@code Map.ofEntries} removes that arity cap and allows any number of entries.</p>
     */
    private static String buildMapOfLiteral(Properties props) {
        List<String> keys = new ArrayList<>();
        for (Object k : props.keySet()) keys.add(k.toString());
        keys.sort(String::compareTo);

        StringBuilder sb = new StringBuilder("java.util.Map.ofEntries(");
        for (int i = 0; i < keys.size(); i++) {
            if (i > 0) sb.append(", ");
            String k = keys.get(i);
            String v = props.getProperty(k);
            sb.append("java.util.Map.entry(\"").append(k).append("\", \"").append(v).append("\")");
        }
        sb.append(')');
        return sb.toString();
    }

    /**
     * Return the {@code FieldKind} enum member name for a scalar field (matches the
     * {@code instanceof} order in {@link SpringTypeMapper#javaTypeName}), or
     * {@code null} when the field type is not a known scalar.
     */
    @SuppressWarnings("rawtypes")
    private static String scalarKind(MetaField<?> field) {
        if (field instanceof StringField)  return "STRING";
        if (field instanceof IntegerField) return "INT";
        if (field instanceof LongField)    return "LONG";
        if (field instanceof DoubleField)  return "DOUBLE";
        if (field instanceof BooleanField) return "BOOLEAN";
        return null;
    }

    // -------------------------------------------------------------------------
    // Private helpers — constructor args
    // -------------------------------------------------------------------------

    /**
     * Build the {@code ExtractMap.*} call for a single field's constructor argument.
     */
    @SuppressWarnings("rawtypes")
    private static String constructorArgForField(MetaField<?> field) {
        String name = field.getName();

        // Enum fields: string-backed on the wire.
        if (field instanceof EnumField) {
            // enum-array is List<String> on the wire; scalar enum is a String.
            return field.isArray()
                ? "ExtractMap.asStringList(d, \"" + name + "\")"
                : "ExtractMap.asString(d, \"" + name + "\")";
        }

        // Nested object / array-of-objects: deferred in the self-contained path (the
        // record component type is a nested payload or List<NestedPayload>, which the
        // scalar ExtractMap readers can't produce). The runtime-delegating extract
        // overload populates these — see SpringOutputParserGenerator. Emit a typed
        // null so the generated constructor still compiles.
        if (field instanceof ObjectField) {
            return "null /* FR-010: nested extract deferred — use extractLenient(loader, text) */";
        }

        // Scalar array fields: List<String>.
        if (field.isArray()) {
            return "ExtractMap.asStringList(d, \"" + name + "\")";
        }

        // Scalar types.
        if (field instanceof IntegerField) return "ExtractMap.asInt(d, \"" + name + "\")";
        if (field instanceof LongField)    return "ExtractMap.asLong(d, \"" + name + "\")";
        if (field instanceof DoubleField)  return "ExtractMap.asDouble(d, \"" + name + "\")";
        if (field instanceof BooleanField) return "ExtractMap.asBool(d, \"" + name + "\")";

        // StringField (and any other unrecognized type): asString.
        return "ExtractMap.asString(d, \"" + name + "\")";
    }

    // -------------------------------------------------------------------------
    // Private helpers — common
    // -------------------------------------------------------------------------

    /**
     * Returns {@code true} when the field carries {@code @required: true}.
     * Uses {@code getValueAsString()} to handle both the Boolean-attribute and
     * String-attribute storage paths.
     */
    private static boolean isRequired(MetaField<?> field) {
        return field.hasMetaAttr(MetaField.ATTR_REQUIRED)
            && "true".equalsIgnoreCase(
                field.getMetaAttr(MetaField.ATTR_REQUIRED).getValueAsString());
    }
}
