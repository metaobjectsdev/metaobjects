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
 * strings for the FR-010 recover codegen:
 *
 * <ul>
 *   <li>{@link #schemaLiteral(MetaObject, String, String)} — a {@code new RecoverSchema(...)}
 *       literal ready for insertion into a generated output-parser class.</li>
 *   <li>{@link #constructorArgs(MetaObject)} — the comma-separated argument list for the
 *       generated {@code new <Payload>(...)} call, reading each component from a
 *       {@code Map<String,Object> d} via the {@code RecoverMap} helpers.</li>
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
 *       with a {@code /* FR-010: nested recover deferred *}{@code /} comment (bounded
 *       deferral).</li>
 * </ul>
 */
final class RecoverSchemaEmitter {

    private RecoverSchemaEmitter() { /* no instances */ }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Emit a {@code new RecoverSchema(Format.X, "<rootName>", java.util.List.of(...))}
     * literal for all fields on {@code vo}.
     *
     * @param vo       the payload value-object whose fields drive the schema
     * @param format   {@code "xml"} → {@code Format.XML}; anything else → {@code Format.JSON}
     * @param rootName the logical root name embedded in the schema
     * @return Java source snippet, e.g.
     *         {@code new RecoverSchema(Format.JSON, "Foo", java.util.List.of(...))}
     */
    static String schemaLiteral(MetaObject vo, String format, String rootName) {
        String formatEnum = "xml".equalsIgnoreCase(format) ? "Format.XML" : "Format.JSON";

        List<String> fieldSpecs = new ArrayList<>();
        for (MetaField<?> field : vo.getMetaFields()) {
            fieldSpecs.add(fieldSpecLiteral(field));
        }

        StringBuilder sb = new StringBuilder();
        sb.append("new RecoverSchema(").append(formatEnum)
          .append(", \"").append(rootName).append("\", java.util.List.of(");
        for (int i = 0; i < fieldSpecs.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append(fieldSpecs.get(i));
        }
        sb.append("))");
        return sb.toString();
    }

    /**
     * Emit the comma-separated constructor arguments for {@code new <Payload>(...)},
     * reading each field from a {@code Map<String,Object> d} via {@code RecoverMap}.
     *
     * @param vo the payload value-object
     * @return Java source snippet, e.g.
     *         {@code RecoverMap.asString(d, "text"), RecoverMap.asString(d, "confidence")}
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
    private static String fieldSpecLiteral(MetaField<?> field) {
        String name = field.getName();
        boolean required = isRequired(field);

        if (field instanceof EnumField ef) {
            return enumFieldSpec(name, required, ef);
        }

        // Nested object or array-of-objects: bounded deferral.
        if (field instanceof ObjectField) {
            return "FieldSpec.scalar(\"" + name + "\", FieldKind.STRING, " + required
                + ") /* FR-010: nested recover deferred */";
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
    private static String enumFieldSpec(String name, boolean required, EnumField field) {
        // @values — guaranteed non-null by the loader's ValidationPhase.
        @SuppressWarnings("unchecked")
        List<String> values = (List<String>) field.getMetaAttr(EnumField.ATTR_VALUES).getValue();

        // @enumAlias — optional; produce Map.of() when absent.
        String aliasMapLiteral;
        if (field.hasMetaAttr(EnumField.ATTR_ENUM_ALIAS, false)) {
            Properties aliases = (Properties) field.getMetaAttr(EnumField.ATTR_ENUM_ALIAS).getValue();
            if (aliases == null || aliases.isEmpty()) {
                aliasMapLiteral = "java.util.Map.of()";
            } else {
                aliasMapLiteral = buildMapOfLiteral(aliases);
            }
        } else {
            aliasMapLiteral = "java.util.Map.of()";
        }

        // Build the List.of(...) for enum values.
        StringBuilder valuesList = new StringBuilder("java.util.List.of(");
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) valuesList.append(", ");
            valuesList.append('"').append(values.get(i)).append('"');
        }
        valuesList.append(')');

        return "FieldSpec.enumField(\"" + name + "\", " + required + ", "
            + valuesList + ", " + aliasMapLiteral + ")";
    }

    /**
     * Emit a {@code java.util.Map.of(k, v, ...)} literal from a {@link Properties}.
     * Entries are sorted by key for deterministic output.
     */
    private static String buildMapOfLiteral(Properties props) {
        List<String> keys = new ArrayList<>();
        for (Object k : props.keySet()) keys.add(k.toString());
        keys.sort(String::compareTo);

        StringBuilder sb = new StringBuilder("java.util.Map.of(");
        for (int i = 0; i < keys.size(); i++) {
            if (i > 0) sb.append(", ");
            String k = keys.get(i);
            String v = props.getProperty(k);
            sb.append('"').append(k).append("\", \"").append(v).append('"');
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
     * Build the {@code RecoverMap.*} call for a single field's constructor argument.
     */
    @SuppressWarnings("rawtypes")
    private static String constructorArgForField(MetaField<?> field) {
        String name = field.getName();

        // Enum fields: string-backed on the wire.
        if (field instanceof EnumField) {
            return "RecoverMap.asString(d, \"" + name + "\")";
        }

        // Array fields: List<String>.
        if (field.isArray()) {
            return "RecoverMap.asStringList(d, \"" + name + "\")";
        }

        // Nested object: deferred.
        if (field instanceof ObjectField) {
            return "null /* FR-010: nested recover deferred */";
        }

        // Scalar types.
        if (field instanceof IntegerField) return "RecoverMap.asInt(d, \"" + name + "\")";
        if (field instanceof LongField)    return "RecoverMap.asLong(d, \"" + name + "\")";
        if (field instanceof DoubleField)  return "RecoverMap.asDouble(d, \"" + name + "\")";
        if (field instanceof BooleanField) return "RecoverMap.asBool(d, \"" + name + "\")";

        // StringField (and any other unrecognized type): asString.
        return "RecoverMap.asString(d, \"" + name + "\")";
    }

    // -------------------------------------------------------------------------
    // Private helpers — common
    // -------------------------------------------------------------------------

    /**
     * Returns {@code true} when the field carries {@code @required: true}.
     * Uses {@code getValueAsString()} to handle both the Boolean-attribute and
     * String-attribute storage paths (mirrors {@code ExpectedSchemaBuilder.isRequired}).
     */
    private static boolean isRequired(MetaField<?> field) {
        return field.hasMetaAttr(MetaField.ATTR_REQUIRED)
            && "true".equalsIgnoreCase(
                field.getMetaAttr(MetaField.ATTR_REQUIRED).getValueAsString());
    }
}
