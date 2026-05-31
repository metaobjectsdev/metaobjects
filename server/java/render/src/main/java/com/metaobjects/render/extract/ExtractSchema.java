package com.metaobjects.render.extract;

import java.util.List;
import java.util.Objects;

/** Top-level extract descriptor. rootName = the XML root tag / logical JSON root name. */
public record ExtractSchema(Format format, String rootName, List<FieldSpec> fields) {
    public ExtractSchema {
        Objects.requireNonNull(format, "format");
        Objects.requireNonNull(rootName, "rootName");
        fields = fields == null ? List.of() : List.copyOf(fields);
    }
}
