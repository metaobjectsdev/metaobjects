package com.metaobjects.render.extract;

import java.util.Objects;

/** A recorded normalization/coercion. kind e.g. "alias", "clamp", "case", "runtime-alias-override". */
public record Coercion(String fieldPath, String from, String to, String kind) {
    public Coercion {
        Objects.requireNonNull(fieldPath, "fieldPath");
        Objects.requireNonNull(kind, "kind");
    }
}
