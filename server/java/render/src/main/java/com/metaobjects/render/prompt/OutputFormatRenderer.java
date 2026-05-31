package com.metaobjects.render.prompt;

import com.metaobjects.render.Escapers;
import com.metaobjects.render.recover.FieldKind;
import com.metaobjects.render.recover.Format;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class OutputFormatRenderer {

    private static final Set<FieldKind> NUMERIC_KINDS =
            Set.of(FieldKind.INT, FieldKind.LONG, FieldKind.DOUBLE, FieldKind.BOOLEAN);

    private static final String INDENT = "  ";
    private static final int MAX_NEST_DEPTH = 8;

    /** Skeleton render mode: filled example values vs inline {placeholder} content. */
    private enum SkelMode { EXAMPLE, INLINE }

    private OutputFormatRenderer() {}

    public static String render(OutputFormatSpec spec, PromptOverrides overrides) {
        PromptStyle effectiveStyle = overrides.style() != null ? overrides.style() : spec.style();
        return switch (effectiveStyle) {
            case EXAMPLE_ONLY -> renderExampleOnly(spec, overrides);
            case GUIDE        -> renderGuide(spec, overrides);
            case INLINE       -> renderInline(spec, overrides);
        };
    }

    private static String renderInline(OutputFormatSpec spec, PromptOverrides overrides) {
        return spec.format() == Format.XML
                ? renderXmlSkeleton(spec, overrides, SkelMode.INLINE)
                : renderJsonSkeleton(spec, overrides, SkelMode.INLINE);
    }

    private static String inlineContent(PromptField field, PromptOverrides overrides) {
        if (field.kind() == FieldKind.ENUM
                && field.enumValues() != null
                && !field.enumValues().isEmpty()) {
            return String.join(" | ", field.enumValues());
        }
        if (field.kind() == FieldKind.BOOLEAN) {
            return "true | false";
        }
        String instruction = resolveInstruction(field, overrides);
        if (instruction != null) {
            return "{" + instruction + "}";
        }
        return "{" + field.name() + "}";
    }

    /** Returns the effective instruction: override first, then field default, or {@code null}. */
    private static String resolveInstruction(PromptField field, PromptOverrides overrides) {
        String instruction = overrides.instructions().get(field.name());
        return instruction != null ? instruction : field.instruction();
    }

    private static String renderGuide(OutputFormatSpec spec, PromptOverrides overrides) {
        StringBuilder sb = new StringBuilder();
        sb.append("Fill in each field as described below:\n");
        Set<OutputFormatSpec> path = newIdentitySet();
        path.add(spec);
        guideFields(spec, overrides, "", path, 0, sb);
        sb.append("\nRespond exactly like this:\n");
        sb.append(renderExampleOnly(spec, overrides));
        return sb.toString();
    }

    private static void guideFields(OutputFormatSpec spec, PromptOverrides overrides, String prefix,
                                    Set<OutputFormatSpec> path, int depth, StringBuilder sb) {
        for (PromptField field : spec.fields()) {
            String displayName = prefix + field.name();
            guideEntry(field, overrides, displayName, sb);
            if (canExpand(field, path, depth)) {
                OutputFormatSpec nested = field.nested();
                String childPrefix = field.array() ? displayName + "[]." : displayName + ".";
                path.add(nested);
                guideFields(nested, overrides, childPrefix, path, depth + 1, sb);
                path.remove(nested);
            }
        }
    }

    private static void guideEntry(PromptField field, PromptOverrides overrides, String displayName, StringBuilder sb) {
        String req = field.required() ? "required" : "optional";
        sb.append("- ").append(displayName).append(" (").append(req).append(")");
        String instruction = resolveInstruction(field, overrides);
        if (instruction != null) {
            sb.append(": ").append(instruction);
        }
        sb.append("\n");
        if (field.kind() == FieldKind.ENUM && field.enumValues() != null && !field.enumValues().isEmpty()) {
            sb.append("    one of ").append(String.join(", ", field.enumValues())).append("\n");
            Map<String, String> enumDoc = field.enumDoc();
            if (enumDoc != null) {
                for (String val : field.enumValues()) {
                    String doc = enumDoc.get(val);
                    if (doc != null) {
                        sb.append("      ").append(val).append(" = ").append(doc).append("\n");
                    }
                }
            }
        }
        String eg = exampleValueIfDeclared(field, overrides);
        if (eg != null) {
            sb.append("    e.g. ").append(eg).append("\n");
        }
    }

    static String renderExampleOnly(OutputFormatSpec spec, PromptOverrides overrides) {
        return spec.format() == Format.XML
                ? renderXmlSkeleton(spec, overrides, SkelMode.EXAMPLE)
                : renderJsonSkeleton(spec, overrides, SkelMode.EXAMPLE);
    }

    // ---- JSON skeleton (recursive) ----------------------------------------------

    private static String renderJsonSkeleton(OutputFormatSpec spec, PromptOverrides overrides, SkelMode mode) {
        Set<OutputFormatSpec> path = newIdentitySet();
        path.add(spec);
        return jsonObject(spec, overrides, "", mode, path, 0);
    }

    private static String jsonObject(OutputFormatSpec spec, PromptOverrides overrides, String braceIndent,
                                     SkelMode mode, Set<OutputFormatSpec> path, int depth) {
        List<PromptField> fields = spec.fields();
        if (fields.isEmpty()) return "{\n" + braceIndent + "}";
        String fieldIndent = braceIndent + INDENT;
        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        for (int i = 0; i < fields.size(); i++) {
            PromptField field = fields.get(i);
            sb.append(fieldIndent).append("\"").append(field.name()).append("\": ")
              .append(jsonValue(field, overrides, fieldIndent, mode, path, depth));
            if (i < fields.size() - 1) sb.append(",");
            sb.append("\n");
        }
        sb.append(braceIndent).append("}");
        return sb.toString();
    }

    private static String jsonValue(PromptField field, PromptOverrides overrides, String indent,
                                    SkelMode mode, Set<OutputFormatSpec> path, int depth) {
        if (field.array()) return jsonArray(field, overrides, indent, mode, path, depth);
        if (field.kind() == FieldKind.OBJECT) return jsonObjectField(field, overrides, indent, mode, path, depth);
        return jsonLeaf(field, overrides, mode);
    }

    private static String jsonLeaf(PromptField field, PromptOverrides overrides, SkelMode mode) {
        if (mode == SkelMode.INLINE) {
            return "\"" + Escapers.escape(Escapers.FORMAT_JSON, inlineContent(field, overrides)) + "\"";
        }
        String value = exampleValue(field, overrides);
        return isNumericOrBoolean(field.kind(), value)
                ? value
                : "\"" + Escapers.escape(Escapers.FORMAT_JSON, value) + "\"";
    }

    private static boolean canExpand(PromptField field, Set<OutputFormatSpec> path, int depth) {
        return field.kind() == FieldKind.OBJECT && field.nested() != null
                && depth < MAX_NEST_DEPTH && !path.contains(field.nested());
    }

    private static String jsonObjectField(PromptField field, PromptOverrides overrides, String indent,
                                          SkelMode mode, Set<OutputFormatSpec> path, int depth) {
        if (!canExpand(field, path, depth)) return jsonLeaf(field, overrides, mode);
        OutputFormatSpec nested = field.nested();
        path.add(nested);
        String out = jsonObject(nested, overrides, indent, mode, path, depth + 1);
        path.remove(nested);
        return out;
    }

    private static String jsonArray(PromptField field, PromptOverrides overrides, String indent,
                                    SkelMode mode, Set<OutputFormatSpec> path, int depth) {
        String elemIndent = indent + INDENT;
        String elem;
        if (canExpand(field, path, depth)) {
            OutputFormatSpec nested = field.nested();
            path.add(nested);
            elem = jsonObject(nested, overrides, elemIndent, mode, path, depth + 1);
            path.remove(nested);
        } else {
            elem = jsonLeaf(field, overrides, mode);
        }
        return "[\n" + elemIndent + elem + "\n" + indent + "]";
    }

    // ---- XML skeleton (recursive) -----------------------------------------------

    private static String renderXmlSkeleton(OutputFormatSpec spec, PromptOverrides overrides, SkelMode mode) {
        Set<OutputFormatSpec> path = newIdentitySet();
        path.add(spec);
        return "<" + spec.rootName() + ">\n"
                + xmlBody(spec, overrides, INDENT, mode, path, 0)
                + "</" + spec.rootName() + ">";
    }

    private static String xmlBody(OutputFormatSpec spec, PromptOverrides overrides, String indent,
                                  SkelMode mode, Set<OutputFormatSpec> path, int depth) {
        StringBuilder sb = new StringBuilder();
        for (PromptField field : spec.fields()) {
            sb.append(xmlField(field, overrides, indent, mode, path, depth));
        }
        return sb.toString();
    }

    private static String xmlField(PromptField field, PromptOverrides overrides, String indent,
                                   SkelMode mode, Set<OutputFormatSpec> path, int depth) {
        if (canExpand(field, path, depth)) {
            OutputFormatSpec nested = field.nested();
            path.add(nested);
            String body = xmlBody(nested, overrides, indent + INDENT, mode, path, depth + 1);
            path.remove(nested);
            return indent + "<" + field.name() + ">\n" + body + indent + "</" + field.name() + ">\n";
        }
        String content = mode == SkelMode.INLINE ? inlineContent(field, overrides) : exampleValue(field, overrides);
        return indent + "<" + field.name() + ">" + Escapers.escape(Escapers.FORMAT_XML, content)
                + "</" + field.name() + ">\n";
    }

    private static Set<OutputFormatSpec> newIdentitySet() {
        return Collections.newSetFromMap(new IdentityHashMap<>());
    }

    private static String exampleValueIfDeclared(PromptField field, PromptOverrides overrides) {
        String fromOverride = overrides.examples().get(field.name());
        if (fromOverride != null) return fromOverride;
        if (field.example() != null) return field.example();
        return null;
    }

    static String exampleValue(PromptField field, PromptOverrides overrides) {
        String fromOverride = overrides.examples().get(field.name());
        if (fromOverride != null) return fromOverride;
        if (field.example() != null) return field.example();
        if (field.kind() == FieldKind.ENUM
                && field.enumValues() != null
                && !field.enumValues().isEmpty()) {
            return field.enumValues().get(0);
        }
        return "{" + field.name() + "}";
    }

    private static boolean isNumericOrBoolean(FieldKind kind, String value) {
        if (!NUMERIC_KINDS.contains(kind)) return false;
        if (value.equals("true") || value.equals("false")) return true;
        try {
            double d = Double.parseDouble(value);
            return !Double.isNaN(d) && !Double.isInfinite(d);
        } catch (NumberFormatException e) {
            // not a number; fall through to quoted string
        }
        return false;
    }
}
