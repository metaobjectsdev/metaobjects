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
import com.metaobjects.field.TimeField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.field.UuidField;
import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.object.MetaObject;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

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
 * {@code UuidField} JVM class today). Object / decimal etc. throw
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
     * <p>Enum: returns {@code "String"} — the string-backed wire / engine-schema /
     * lenient-mirror representation ({@code "ACTIVE"}, etc). The STRICT
     * {@code <Name>Payload} record instead types a {@code field.enum} as the generated
     * Java {@code enum} via {@link #payloadJavaTypeName(MetaField, MetaObject, String)};
     * this arm stays {@code String} so the engine-facing string contract and any
     * non-payload use of the mapper are preserved.</p>
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
        // `field.time` is a wall-clock time-of-day (no date, no zone). Wire form is
        // "HH:mm:ss[.fff]" (normalization.md) → java.time.LocalTime. Mirrors
        // KotlinTypeMapper's `time` arm; previously absent, so any time-bearing entity
        // hit the unsupported-type throw (SP-H Unit 5 fix).
        if (field instanceof TimeField) return "java.time.LocalTime";
        // Timestamp wire contract (normalization.md): plain `field.timestamp` is
        // "timestamp WITHOUT time zone" → wall-clock ISO string with NO `Z`
        // (e.g. "2026-01-01T10:00:00"), which round-trips as java.time.LocalDateTime.
        // The `@dbColumnType=timestamp_with_tz` opt-in is "timestamp WITH time zone"
        // → UTC `Z` form, which is java.time.Instant. Using Instant for the default
        // (no-tz) case is wrong: Instant can neither parse nor emit a zone-less string,
        // so the DTO can't accept the cross-port `createdAt` wire value. Mirrors
        // KotlinTypeMapper's timestamp/timestampWithTimeZone split.
        if (field instanceof TimestampField) {
            return timestampWithTzOptIn(field) ? "java.time.Instant" : "java.time.LocalDateTime";
        }
        // Currency wire/JVM type: Long (integer minor units cross-port invariant).
        if (field instanceof CurrencyField) return "Long";
        // Enum string-backed on the WIRE / SCHEMA / lenient mirror path — stays String.
        // The STRICT payload record types an enum field as the generated Java enum instead;
        // see payloadJavaTypeName(...) (the typed-enums payload-VO change). Keeping this arm
        // String preserves the engine-facing string contract (FieldKind.ENUM is string-backed)
        // and any non-payload use of the mapper.
        if (field instanceof EnumField) return "String";
        // UUID — native java.util.UUID binding (R6 Plan 2a).
        if (field instanceof UuidField) return "java.util.UUID";
        throw new IllegalArgumentException(
            "unsupported Spring DTO type mapping for "
                + field.getClass().getSimpleName() + " '" + field.getName() + "'");
    }

    /**
     * True iff {@code field} carries {@code @dbColumnType=timestamp_with_tz}
     * (case-insensitive) — the opt-in to "timestamp WITH time zone" (UTC `Z`
     * wire form → {@code java.time.Instant}). Mirrors
     * {@code KotlinTypeMapper.timestampWithTzOptIn}. Own-only read; absent /
     * non-attribute → {@code false} (plain no-tz timestamp).
     */
    private static boolean timestampWithTzOptIn(MetaField<?> field) {
        if (!field.hasMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE)) return false;
        Object raw = field.getMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE).getValue();
        return raw != null
            && CoreDBMetaDataProvider.DB_COLUMN_TYPE_TIMESTAMP_TZ.equalsIgnoreCase(String.valueOf(raw).trim());
    }

    // =========================================================================
    // Typed-enum payload support
    // =========================================================================

    /**
     * Map a {@link MetaField} to the type used in the STRICT
     * {@code <Name>Payload} record component, as a Java type expression
     * {@code enumQualifier}-qualified for enums.
     *
     * <p>Identical to {@link #javaTypeName(MetaField)} for every field type EXCEPT
     * {@link EnumField}: a {@code field.enum} payload component is typed as the generated
     * Java {@code enum} ({@link #enumTypeName(MetaObject, MetaField)}, qualified with
     * {@code enumQualifier} so the mapper class — emitted as a sibling of the payload record —
     * can name the record-nested enum), and an enum array as {@code java.util.List<<Qualified>>}.
     * The lenient mirror / engine schema path keeps {@link #javaTypeName(MetaField)} (String),
     * so only the strict payload carries the value-constrained type.</p>
     *
     * @param field         the payload value-object field
     * @param owner         the field's owning value-object (for the {@code <Owner><Field>} name)
     * @param enumQualifier a prefix (e.g. {@code "OrderPayload."}) qualifying the record-nested
     *                      enum from a sibling class, or {@code ""} when referenced from inside
     *                      the record body itself
     */
    public static String payloadJavaTypeName(MetaField<?> field, MetaObject owner, String enumQualifier) {
        if (field instanceof EnumField) {
            String enumType = enumQualifier + enumTypeName(owner, field);
            return field.isArray() ? "java.util.List<" + enumType + ">" : enumType;
        }
        return javaTypeName(field);
    }

    /**
     * The generated Java {@code enum} type name for an enum-subtype payload field — the SAME
     * shared scheme the other ports use ({@code KotlinTypeMapper.enumTypeName} /
     * C# {@code CSharpNaming.EnumTypeName}): when the field {@code extends} an abstract enum
     * super, all extenders collapse onto ONE enum named for the top-most super
     * ({@code Pascal(super.shortName)}); otherwise {@code Pascal(owner.shortName) +
     * Pascal(field.name)}. Members verbatim.
     */
    public static String enumTypeName(MetaObject owner, MetaField<?> field) {
        MetaField<?> superRoot = resolveSuperRoot(field);
        if (superRoot != null) {
            return pascal(SpringNaming.splitFqn(superRoot.getName())[1]);
        }
        return pascal(SpringNaming.splitFqn(owner.getName())[1]) + pascal(field.getName());
    }

    /**
     * Walk a field's {@code extends} (super-field) chain to the top-most ancestor, returning it,
     * or {@code null} when the field has no super. Naming the generated enum after the top-most
     * super makes every extending field share one type. Cycle-guarded via a visited set.
     */
    static MetaField<?> resolveSuperRoot(MetaField<?> field) {
        MetaField<?> current = field.getSuperField();
        if (current == null) return null;
        Set<String> seen = new HashSet<>();
        while (true) {
            MetaField<?> next = current.getSuperField();
            if (next == null) break;
            if (!seen.add(current.getName())) break; // cycle guard
            current = next;
        }
        return current;
    }

    /**
     * Read the EFFECTIVE {@code @values} of an {@link EnumField} (inheriting from an
     * {@code extends}-super when the field carries no own values), as the verbatim member list.
     * Mirrors {@code ExtractSchemaEmitter.enumFieldSpec}'s {@code getMetaAttr(ATTR_VALUES)} read.
     * Returns an empty list when absent (defensive — the loader requires non-empty {@code @values}).
     */
    @SuppressWarnings("unchecked")
    public static List<String> effectiveEnumValues(EnumField field) {
        if (!field.hasMetaAttr(EnumField.ATTR_VALUES)) return List.of();
        Object raw = field.getMetaAttr(EnumField.ATTR_VALUES).getValue();
        return (raw instanceof List) ? (List<String>) raw : List.of();
    }

    /** Uppercase the first character of {@code s}; pass through unchanged when empty/already upper. */
    private static String pascal(String s) {
        if (s == null || s.isEmpty()) return s;
        char c0 = s.charAt(0);
        if (Character.isUpperCase(c0)) return s;
        return Character.toUpperCase(c0) + s.substring(1);
    }
}
