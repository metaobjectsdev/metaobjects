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
 * <p>{@code isArray} is the field's EFFECTIVE array-ness (a resolving read when built from real
 * metadata). It is distinct from {@code fields != null}: an array of scalars is
 * {@code isArray} with no {@code fields}; a single nested object has {@code fields} and is not
 * {@code isArray}. Together they decide whether {@code -last} is available inside a section over
 * this field (see {@link Verify}).
 *
 * <p>Mirrors {@code server/csharp/MetaObjects.Render/Verify.cs}
 * {@code PayloadField} record.
 */
public record PayloadField(String name, List<PayloadField> fields, boolean isArray) {

    public PayloadField {
        Objects.requireNonNull(name, "name");
    }

    /** Convenience factory: a single (non-array) scalar field. */
    public static PayloadField scalar(String name) {
        return new PayloadField(name, null, false);
    }

    /** Convenience factory: a scalar field, an array of scalars when {@code isArray}. */
    public static PayloadField scalar(String name, boolean isArray) {
        return new PayloadField(name, null, isArray);
    }

    /** Convenience factory: a single (non-array) nested-object field. */
    public static PayloadField object(String name, List<PayloadField> children) {
        return new PayloadField(name, List.copyOf(children), false);
    }

    /** Convenience factory: a nested-object field, an array of objects when {@code isArray}. */
    public static PayloadField object(String name, List<PayloadField> children, boolean isArray) {
        return new PayloadField(name, List.copyOf(children), isArray);
    }
}
