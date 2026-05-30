package com.metaobjects.generator.spring;

import com.metaobjects.field.BooleanField;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DecimalField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.FloatField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.StringField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.field.UuidField;

/**
 * Centralised mapping from {@link MetaField} subtype to the Java type used in
 * the generated {@code <Entity>Dto} record component declaration.
 *
 * <p>Tier-1 invariant: the <em>semantic</em> type per field subtype is identical
 * across all language ports (TS / Java / Kotlin / C# / Python). The exact Java
 * type name returned here is the Tier-2 idiomatic JVM rendering — wrapped
 * primitives ({@code Long}, {@code Integer}, {@code Double}, {@code Boolean})
 * are used throughout so a {@code null} value can flow through JSON
 * deserialisation when a request body omits a field. Java {@code record}
 * components have no nullability syntax of their own; the wrapped-types
 * convention is the cleanest way to make "missing field → {@code null}"
 * work without per-component {@code @Nullable} annotations.</p>
 *
 * <p>Coverage parallels {@code KotlinTypeMapper}: 7 primitive types +
 * currency + enum + uuid. UUID is matched on metadata subtype name (no
 * {@code UuidField} JVM class today). Object / class / decimal etc. throw
 * {@link IllegalArgumentException} with a clear message — add support per
 * real consumer ask.</p>
 */
public final class SpringTypeMapper {

    private SpringTypeMapper() { /* no instances */ }

    /**
     * Map a {@link MetaField} to its Java DTO-record-component type as a
     * fully-qualified type expression (e.g. {@code "Long"},
     * {@code "java.time.Instant"}, {@code "java.util.UUID"}).
     *
     * <p>The returned string is inserted verbatim into the generated record
     * component declaration. It never includes generic parameters — a future
     * {@code List<String>} (i.e. {@code isArray=true}) arm will need a
     * separate code path because Java records don't allow varargs-style
     * component declarations.</p>
     *
     * <p>Currency: returns {@code "Long"} — the wire/storage contract is
     * integer minor units (cents for USD, yen for JPY). Float arithmetic for
     * money is forbidden by the cross-port contract; surfacing currency as a
     * distinct mapper arm documents the semantic.</p>
     *
     * <p>Enum: returns {@code "String"} for v1 — the string-backed enum
     * representation matches the wire format ({@code "ACTIVE"}, etc). A real
     * generated Java {@code enum} type would require materialising the
     * {@code @values} set into a top-level declaration, which is deferred
     * (a parallel of {@code KotlinTypeMapper}'s {@code String}-arm fallback).</p>
     */
    public static String javaTypeName(MetaField<?> field) {
        if (field instanceof StringField) return "String";
        if (field instanceof IntegerField) return "Integer";
        if (field instanceof LongField) return "Long";
        if (field instanceof DoubleField) return "Double";
        if (field instanceof FloatField) return "Float";
        if (field instanceof DecimalField) return "java.math.BigDecimal";
        if (field instanceof BooleanField) return "Boolean";
        if (field instanceof DateField) return "java.time.LocalDate";
        if (field instanceof TimestampField) return "java.time.Instant";
        // Currency wire/JVM type: Long (integer minor units cross-port invariant).
        if (field instanceof CurrencyField) return "Long";
        // Enum string-backed (v1) — same fallback as KotlinTypeMapper.
        if (field instanceof EnumField) return "String";
        // UUID — native java.util.UUID binding (R6 Plan 2a).
        if (field instanceof UuidField) return "java.util.UUID";
        throw new IllegalArgumentException(
            "unsupported Spring DTO type mapping for "
                + field.getClass().getSimpleName() + " '" + field.getName() + "'");
    }
}
