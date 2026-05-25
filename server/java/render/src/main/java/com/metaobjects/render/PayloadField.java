package com.metaobjects.render;

import java.util.List;
import java.util.Objects;

/**
 * A field node in a template-verification payload tree — a plain mirror of
 * an {@code object.value} view-object's field walk, decoupled from the
 * metadata package so the render engine remains a zero-core-dependency module.
 *
 * <p>{@code fields} present (non-null) → a context-pushing field (object or
 * array-of-object). {@code fields} null → a scalar field (string / number /
 * boolean / scalar array).
 *
 * <p>Mirrors {@code server/csharp/MetaObjects.Render/Verify.cs}
 * {@code PayloadField} record.
 */
public record PayloadField(String name, List<PayloadField> fields) {

    public PayloadField {
        Objects.requireNonNull(name, "name");
    }

    /** Convenience factory: a scalar field with no nested children. */
    public static PayloadField scalar(String name) {
        return new PayloadField(name, null);
    }

    /** Convenience factory: a context-pushing object/array-of-object field. */
    public static PayloadField object(String name, List<PayloadField> children) {
        return new PayloadField(name, List.copyOf(children));
    }
}
