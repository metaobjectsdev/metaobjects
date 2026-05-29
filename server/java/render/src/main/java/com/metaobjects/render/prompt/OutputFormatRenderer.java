package com.metaobjects.render.prompt;

import com.metaobjects.render.Escapers;
import com.metaobjects.render.recover.FieldKind;
import com.metaobjects.render.recover.Format;

import java.util.List;
import java.util.Set;

public final class OutputFormatRenderer {

    private static final Set<FieldKind> NUMERIC_KINDS =
            Set.of(FieldKind.INT, FieldKind.LONG, FieldKind.DOUBLE, FieldKind.BOOLEAN);

    private OutputFormatRenderer() {}

    public static String render(OutputFormatSpec spec, PromptOverrides overrides) {
        PromptStyle effectiveStyle = overrides.style() != null ? overrides.style() : spec.style();
        return switch (effectiveStyle) {
            case EXAMPLE_ONLY -> renderExampleOnly(spec, overrides);
            case GUIDE, INLINE -> throw new UnsupportedOperationException(
                    "Style not yet implemented: " + effectiveStyle);
        };
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
            Double.parseDouble(value);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }
}
