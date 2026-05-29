package com.metaobjects.render.prompt;

import com.metaobjects.render.Escapers;
import com.metaobjects.render.recover.FieldKind;
import com.metaobjects.render.recover.Format;

import java.util.List;
import java.util.Map;
import java.util.Set;

public final class OutputFormatRenderer {

    private static final Set<FieldKind> NUMERIC_KINDS =
            Set.of(FieldKind.INT, FieldKind.LONG, FieldKind.DOUBLE, FieldKind.BOOLEAN);

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
        return switch (spec.format()) {
            case XML  -> renderXmlInline(spec, overrides);
            case JSON -> renderJsonInline(spec, overrides);
        };
    }

    private static String renderXmlInline(OutputFormatSpec spec, PromptOverrides overrides) {
        StringBuilder sb = new StringBuilder();
        sb.append("<").append(spec.rootName()).append(">\n");
        for (PromptField field : spec.fields()) {
            String content = inlineContent(field, overrides);
            String escaped = Escapers.escape(Escapers.FORMAT_XML, content);
            sb.append("  <").append(field.name()).append(">")
              .append(escaped)
              .append("</").append(field.name()).append(">\n");
        }
        sb.append("</").append(spec.rootName()).append(">");
        return sb.toString();
    }

    private static String renderJsonInline(OutputFormatSpec spec, PromptOverrides overrides) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        List<PromptField> fields = spec.fields();
        for (int i = 0; i < fields.size(); i++) {
            PromptField field = fields.get(i);
            String content = inlineContent(field, overrides);
            boolean isLast = i == fields.size() - 1;
            sb.append("  \"").append(field.name()).append("\": ");
            sb.append("\"").append(Escapers.escape(Escapers.FORMAT_JSON, content)).append("\"");
            if (!isLast) sb.append(",");
            sb.append("\n");
        }
        sb.append("}");
        return sb.toString();
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
        String instruction = overrides.instructions().get(field.name());
        if (instruction == null) instruction = field.instruction();
        if (instruction != null) {
            return "{" + instruction + "}";
        }
        return "{" + field.name() + "}";
    }

    private static String renderGuide(OutputFormatSpec spec, PromptOverrides overrides) {
        StringBuilder sb = new StringBuilder();
        sb.append("Fill in each field as described below:\n");
        for (PromptField field : spec.fields()) {
            String req = field.required() ? "required" : "optional";
            sb.append("- ").append(field.name()).append(" (").append(req).append(")");
            String instruction = overrides.instructions().get(field.name());
            if (instruction == null) instruction = field.instruction();
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
        sb.append("\nRespond exactly like this:\n");
        sb.append(renderExampleOnly(spec, overrides));
        return sb.toString();
    }

    static String renderExampleOnly(OutputFormatSpec spec, PromptOverrides overrides) {
        return switch (spec.format()) {
            case XML  -> renderXmlSkeleton(spec, overrides);
            case JSON -> renderJsonSkeleton(spec, overrides);
        };
    }

    private static String renderXmlSkeleton(OutputFormatSpec spec, PromptOverrides overrides) {
        StringBuilder sb = new StringBuilder();
        sb.append("<").append(spec.rootName()).append(">\n");
        for (PromptField field : spec.fields()) {
            String value = exampleValue(field, overrides);
            String escaped = Escapers.escape(Escapers.FORMAT_XML, value);
            sb.append("  <").append(field.name()).append(">")
              .append(escaped)
              .append("</").append(field.name()).append(">\n");
        }
        sb.append("</").append(spec.rootName()).append(">");
        return sb.toString();
    }

    private static String renderJsonSkeleton(OutputFormatSpec spec, PromptOverrides overrides) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        List<PromptField> fields = spec.fields();
        for (int i = 0; i < fields.size(); i++) {
            PromptField field = fields.get(i);
            // NOTE: FieldKind.OBJECT / nested fields are not expanded here — they render as a
            // "{fieldName}" placeholder. Nested-object expansion is a Plan 3.1 deferral.
            String value = exampleValue(field, overrides);
            boolean isLast = i == fields.size() - 1;
            sb.append("  \"").append(field.name()).append("\": ");
            if (isNumericOrBoolean(field.kind(), value)) {
                sb.append(value);
            } else {
                sb.append("\"").append(Escapers.escape(Escapers.FORMAT_JSON, value)).append("\"");
            }
            if (!isLast) sb.append(",");
            sb.append("\n");
        }
        sb.append("}");
        return sb.toString();
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
