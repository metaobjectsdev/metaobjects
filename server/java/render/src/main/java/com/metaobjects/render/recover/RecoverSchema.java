package com.metaobjects.render.recover;

import java.util.List;
import java.util.Objects;

/** Top-level recover descriptor. rootName = the XML root tag / logical JSON root name. */
public record RecoverSchema(Format format, String rootName, List<FieldSpec> fields) {
    public RecoverSchema {
        Objects.requireNonNull(format, "format");
        Objects.requireNonNull(rootName, "rootName");
        fields = fields == null ? List.of() : List.copyOf(fields);
    }
}
