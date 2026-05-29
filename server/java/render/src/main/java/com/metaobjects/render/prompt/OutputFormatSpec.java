package com.metaobjects.render.prompt;

import com.metaobjects.render.recover.Format;
import java.util.List;
import java.util.Objects;

/**
 * Precondition: {@code rootName} must be identifier-safe (valid XML element name / JSON key).
 * The renderer does not escape it.
 */
public record OutputFormatSpec(Format format, String rootName, PromptStyle style, List<PromptField> fields) {
    public OutputFormatSpec {
        Objects.requireNonNull(format, "format");
        Objects.requireNonNull(rootName, "rootName");
        style = style == null ? PromptStyle.GUIDE : style;
        fields = fields == null ? List.of() : List.copyOf(fields);
    }
}
