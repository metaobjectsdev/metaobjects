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
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.TemplateConstants;

import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

/**
 * Pure helper that turns a value-object (VO) {@link MetaObject} + its
 * {@code template.output} node into a Java source literal for an
 * {@code OutputFormatSpec} — the artifact-1 prompt descriptor used by the
 * FR-010 prompt-fragment codegen.
 *
 * <p>The public entry point is
 * {@link #specLiteral(MetaObject, MetaTemplate, String)}, which emits a
 * {@code new OutputFormatSpec(Format.X, "<rootName>", PromptStyle.<S>,
 * java.util.List.of(<PromptField...>))} source snippet ready for embedding
 * in a generated Java class.
 *
 * <p>Field-kind mapping (mirrors {@link SpringTypeMapper} / {@link RecoverSchemaEmitter}):
 * <ul>
 *   <li>{@link EnumField} → {@code FieldKind.ENUM}</li>
 *   <li>{@link StringField} → {@code FieldKind.STRING}</li>
 *   <li>{@link IntegerField} → {@code FieldKind.INT}</li>
 *   <li>{@link LongField} → {@code FieldKind.LONG}</li>
 *   <li>{@link DoubleField} → {@code FieldKind.DOUBLE}</li>
 *   <li>{@link BooleanField} → {@code FieldKind.BOOLEAN}</li>
 *   <li>Nested {@link ObjectField} → {@code FieldKind.OBJECT}, nested arg {@code null}
 *       (Plan 3.1 deferral — FR-010: nested prompt deferred).</li>
 * </ul>
 *
 * <p>This class is package-private; the Spring prompt-fragment generator will delegate here.
 * Isolating this logic makes it unit-testable without running the full generator pipeline.
 */
final class OutputFormatSpecEmitter {

    private OutputFormatSpecEmitter() { /* no instances */ }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Emit a {@code new OutputFormatSpec(Format.X, "<rootName>", PromptStyle.<S>,
     * java.util.List.of(...))} literal for all fields on {@code vo}.
     *
     * <p>{@code @format} from the template: {@code "xml"} → {@code Format.XML};
     * anything else → {@code Format.JSON}.</p>
     *
     * <p>{@code @promptStyle}: {@code "guide"} → {@code PromptStyle.GUIDE} (default),
     * {@code "inline"} → {@code PromptStyle.INLINE},
     * {@code "exampleOnly"} → {@code PromptStyle.EXAMPLE_ONLY}.</p>
     *
     * @param vo       the payload value-object whose fields drive the spec
     * @param template the {@code template.output} node carrying {@code @format} and
     *                 {@code @promptStyle}
     * @param rootName the logical root name embedded in the spec
     * @return Java source snippet, e.g.
     *         {@code new OutputFormatSpec(Format.JSON, "Foo", PromptStyle.GUIDE, java.util.List.of(...))}
     */
    static String specLiteral(MetaObject vo, MetaTemplate template, String rootName) {
        String formatEnum = resolveFormatEnum(template);
        String promptStyleEnum = resolvePromptStyleEnum(template);

        List<String> fieldLiterals = new ArrayList<>();
        for (MetaField<?> field : vo.getMetaFields()) {
            fieldLiterals.add(promptFieldLiteral(field));
        }

        return "new OutputFormatSpec(" + formatEnum + ", \""
            + rootName + "\", " + promptStyleEnum + ", java.util.List.of("
            + String.join(", ", fieldLiterals) + "))";
    }

    // -------------------------------------------------------------------------
    // Private helpers — template attr resolution
    // -------------------------------------------------------------------------

    /** Resolve {@code @format} to a {@code Format.*} enum literal. */
    private static String resolveFormatEnum(MetaTemplate template) {
        return "xml".equalsIgnoreCase(template.getFormat()) ? "Format.XML" : "Format.JSON";
    }

    /**
     * Resolve {@code @promptStyle} to a {@code PromptStyle.*} enum literal.
     * Default (absent or unrecognized) → {@code PromptStyle.GUIDE}.
     */
    private static String resolvePromptStyleEnum(MetaTemplate template) {
        String raw = null;
        if (template.hasMetaAttr(TemplateConstants.ATTR_PROMPT_STYLE, false)) {
            raw = template.getMetaAttr(TemplateConstants.ATTR_PROMPT_STYLE, false).getValueAsString();
        }
        if (raw == null) return "PromptStyle.GUIDE";
        return switch (raw) {
            case TemplateConstants.PROMPT_STYLE_INLINE       -> "PromptStyle.INLINE";
            case TemplateConstants.PROMPT_STYLE_EXAMPLE_ONLY -> "PromptStyle.EXAMPLE_ONLY";
            default                                          -> "PromptStyle.GUIDE";
        };
    }

    // -------------------------------------------------------------------------
    // Private helpers — field literal
    // -------------------------------------------------------------------------

    /**
     * Build a {@code new PromptField(...)} call for a single field.
     *
     * <p>Constructor shape:
     * {@code new PromptField(name, FieldKind, required, array,
     * enumValues-or-null, enumDoc-map-or-null, example-or-null,
     * instruction-or-null, nested-or-null)}
     */
    @SuppressWarnings("rawtypes")
    private static String promptFieldLiteral(MetaField<?> field) {
        String name = field.getName();
        boolean required = isRequired(field);
        boolean array = field.isArray();

        // Nested object — bounded deferral (Plan 3.1).
        if (field instanceof ObjectField) {
            return "new PromptField(\"" + name + "\", FieldKind.OBJECT, "
                + required + ", " + array
                + ", null, null, null, null, null) /* FR-010: nested prompt deferred */";
        }

        // Enum field — include values + optional enumDoc.
        if (field instanceof EnumField ef) {
            return enumPromptFieldLiteral(name, required, array, ef);
        }

        // Scalar — resolve @example and @instruction.
        String kindName = scalarKind(field);
        if (kindName == null) {
            kindName = "STRING"; // Unknown type: fall back to STRING.
        }
        String exampleLit    = optStringAttr(field, MetaField.ATTR_EXAMPLE);
        String instructionLit = optStringAttr(field, MetaField.ATTR_INSTRUCTION);

        return "new PromptField(\"" + name + "\", FieldKind." + kindName + ", "
            + required + ", " + array
            + ", null, null, " + exampleLit + ", " + instructionLit + ", null)";
    }

    /**
     * Build a {@code new PromptField(...)} call for an enum field, including
     * the values list and optional enumDoc map.
     */
    private static String enumPromptFieldLiteral(
            String name, boolean required, boolean array, EnumField field) {

        // @values — guaranteed non-null by the loader's ValidationPhase.
        @SuppressWarnings("unchecked")
        List<String> values = (List<String>) field.getMetaAttr(EnumField.ATTR_VALUES).getValue();
        List<String> quoted = new ArrayList<>(values.size());
        for (String v : values) quoted.add("\"" + v + "\"");
        String valuesLit = "java.util.List.of(" + String.join(", ", quoted) + ")";

        // @enumDoc — optional; null when absent or empty.
        Properties enumDoc = null;
        if (field.hasMetaAttr(EnumField.ATTR_ENUM_DOC, false)) {
            Object v = field.getMetaAttr(EnumField.ATTR_ENUM_DOC, false).getValue();
            if (v instanceof Properties p && !p.isEmpty()) {
                enumDoc = p;
            }
        }
        String enumDocLit = enumDoc != null ? buildMapOfEntriesLiteral(enumDoc) : "null";

        String exampleLit    = optStringAttr(field, MetaField.ATTR_EXAMPLE);
        String instructionLit = optStringAttr(field, MetaField.ATTR_INSTRUCTION);

        return "new PromptField(\"" + name + "\", FieldKind.ENUM, "
            + required + ", " + array
            + ", " + valuesLit + ", " + enumDocLit
            + ", " + exampleLit + ", " + instructionLit + ", null)";
    }

    // -------------------------------------------------------------------------
    // Private helpers — attribute reads
    // -------------------------------------------------------------------------

    /**
     * Return a Java string literal for an optional String attribute, or {@code "null"}.
     * The value is escaped via {@link #javaStringLiteral(String)} so that
     * example/instruction free-text containing quotes or newlines embeds safely
     * in Java source.
     */
    private static String optStringAttr(MetaField<?> field, String attrName) {
        if (!field.hasMetaAttr(attrName, false)) return "null";
        String v = field.getMetaAttr(attrName, false).getValueAsString();
        return v == null ? "null" : "\"" + javaStringLiteral(v) + "\"";
    }

    /**
     * Returns {@code true} when the field carries {@code @required: true}.
     * Mirrors {@link RecoverSchemaEmitter#isRequired}.
     */
    private static boolean isRequired(MetaField<?> field) {
        return field.hasMetaAttr(MetaField.ATTR_REQUIRED)
            && "true".equalsIgnoreCase(
                field.getMetaAttr(MetaField.ATTR_REQUIRED).getValueAsString());
    }

    /**
     * Return the {@code FieldKind} enum member name for a scalar field, or
     * {@code null} when the field type is not a known scalar.
     * Mirrors the {@code instanceof} order in {@link SpringTypeMapper#javaTypeName}.
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
    // Private helpers — source literal builders
    // -------------------------------------------------------------------------

    /**
     * Emit a {@code java.util.Map.ofEntries(java.util.Map.entry(k, v), ...)} literal
     * from a {@link Properties}. Entries are sorted by key for deterministic output.
     * Values are escaped via {@link #javaStringLiteral(String)}.
     *
     * <p>{@code java.util.Map.of} only has overloads up to 10 key-value pairs; using
     * {@code Map.ofEntries} removes that arity cap and allows any number of entries.
     * Mirrors {@link RecoverSchemaEmitter#buildMapOfLiteral}.</p>
     */
    private static String buildMapOfEntriesLiteral(Properties props) {
        List<String> keys = new ArrayList<>();
        for (Object k : props.keySet()) keys.add(k.toString());
        keys.sort(String::compareTo);

        StringBuilder sb = new StringBuilder("java.util.Map.ofEntries(");
        for (int i = 0; i < keys.size(); i++) {
            if (i > 0) sb.append(", ");
            String k = keys.get(i);
            String v = props.getProperty(k);
            sb.append("java.util.Map.entry(\"")
              .append(javaStringLiteral(k)).append("\", \"")
              .append(javaStringLiteral(v)).append("\")");
        }
        sb.append(')');
        return sb.toString();
    }

    /**
     * Escape a string value for safe embedding as a Java string literal body
     * (i.e. between double-quote delimiters). Escapes backslashes, double quotes,
     * and common control characters (tab, newline, carriage-return).
     *
     * <p>RecoverSchemaEmitter left equivalent escaping as a TODO for alias keys
     * (enum member symbols are identifier-safe, so the risk was low). Here,
     * {@code @example} and {@code @instruction} are free-text authored by
     * developers and are significantly more likely to contain quotes or
     * newlines, so escaping is applied eagerly.</p>
     */
    static String javaStringLiteral(String value) {
        if (value == null) return "";
        StringBuilder sb = new StringBuilder(value.length() + 4);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\' -> sb.append("\\\\");
                case '"'  -> sb.append("\\\"");
                case '\t' -> sb.append("\\t");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                default   -> sb.append(c);
            }
        }
        return sb.toString();
    }
}
