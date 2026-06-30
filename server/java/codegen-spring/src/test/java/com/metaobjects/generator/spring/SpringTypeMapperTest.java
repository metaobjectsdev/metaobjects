package com.metaobjects.generator.spring;

import com.metaobjects.field.BooleanField;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.StringField;
import com.metaobjects.field.TimeField;
import com.metaobjects.field.TimestampField;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

/**
 * Unit tests for {@link SpringTypeMapper}. Mirrors
 * {@code KotlinTypeMapperTest} so the cross-port semantic-type promise stays
 * explicit: a given {@code field.<subtype>} maps to the same conceptual
 * Java/Kotlin type on both ports.
 */
public class SpringTypeMapperTest extends SharedRegistryTestBase {

    @Test
    public void stringFieldMapsToString() {
        assertEquals("String", SpringTypeMapper.javaTypeName(new StringField("name")));
    }

    @Test
    public void longFieldMapsToWrappedLong() {
        // Wrapped Long (not long) so a missing JSON property deserialises to null
        // without flipping a primitive to zero.
        assertEquals("Long", SpringTypeMapper.javaTypeName(new LongField("id")));
    }

    @Test
    public void integerFieldMapsToWrappedInteger() {
        assertEquals("Integer", SpringTypeMapper.javaTypeName(new IntegerField("count")));
    }

    @Test
    public void doubleFieldMapsToWrappedDouble() {
        assertEquals("Double", SpringTypeMapper.javaTypeName(new DoubleField("ratio")));
    }

    @Test
    public void booleanFieldMapsToWrappedBoolean() {
        assertEquals("Boolean", SpringTypeMapper.javaTypeName(new BooleanField("active")));
    }

    @Test
    public void dateFieldMapsToLocalDate() {
        assertEquals("java.time.LocalDate", SpringTypeMapper.javaTypeName(new DateField("birthday")));
    }

    @Test
    public void timestampFieldMapsToLocalDateTime() {
        // Plain `field.timestamp` is "timestamp WITHOUT time zone" — the wire form is a
        // zone-less wall-clock ISO string with NO `Z` (normalization.md). java.time.Instant
        // would force a UTC `Z` and can't even parse a zone-less string, so the no-tz default
        // maps to java.time.LocalDateTime (matches KotlinTypeMapper's plain `timestamp(...)`).
        assertEquals("java.time.LocalDateTime", SpringTypeMapper.javaTypeName(new TimestampField("createdAt")));
    }

    @Test
    public void timestampFieldWithTzOptInMapsToInstant() {
        // Opt-in `@dbColumnType=timestamp_with_tz` is "timestamp WITH time zone" — the wire
        // form is the UTC `Z` instant, i.e. java.time.Instant.
        TimestampField f = new TimestampField("createdAt");
        f.addMetaAttr(com.metaobjects.attr.StringAttribute.create("dbColumnType", "timestamp_with_tz"));
        assertEquals("java.time.Instant", SpringTypeMapper.javaTypeName(f));
    }

    @Test
    public void timestampFieldTzOptInIsCaseInsensitive() {
        TimestampField f = new TimestampField("createdAt");
        f.addMetaAttr(com.metaobjects.attr.StringAttribute.create("dbColumnType", "TIMESTAMP_WITH_TZ"));
        assertEquals("java.time.Instant", SpringTypeMapper.javaTypeName(f));
    }

    @Test
    public void timeFieldMapsToLocalTime() {
        // `field.time` is a wall-clock time-of-day with no date or zone — the wire form
        // is "HH:mm:ss[.fff]" (normalization.md), which round-trips as java.time.LocalTime.
        // Previously the mapper had no TimeField arm and threw IllegalArgumentException
        // for any entity carrying a time field (SP-H Unit 5 fix).
        assertEquals("java.time.LocalTime", SpringTypeMapper.javaTypeName(new TimeField("startsAt")));
    }

    @Test
    public void currencyFieldMapsToWrappedLong() {
        // Wire/JVM type: Long (integer minor units invariant). Same physical
        // representation as LongField; separate test arm pins the semantic.
        assertEquals("Long", SpringTypeMapper.javaTypeName(new CurrencyField("priceCents")));
    }

    @Test
    public void enumFieldMapsToString() {
        // v1 enum representation: String (wire-format match). Real enum-class
        // emission is deferred — see KNOWN_GAPS.md.
        assertEquals("String", SpringTypeMapper.javaTypeName(new EnumField("status")));
    }

    @Test
    public void stringFieldWithJsonbMapsToObject() {
        // A `field.string @dbColumnType=jsonb` is an open JSON bag. At the REST/contract
        // boundary it must surface as a PARSED JSON value, not a double-encoded String —
        // so Jackson can bind a posted JSON object/array/scalar and serialise a stored bag
        // as real JSON. We use Object (Jackson maps arbitrary JSON to Map/List/scalar);
        // matches the TS `z.unknown()` (#97) and Python `Any` (#99) fixes. (#98)
        StringField f = new StringField("payload");
        f.addMetaAttr(com.metaobjects.attr.StringAttribute.create("dbColumnType", "jsonb"));
        assertEquals("Object", SpringTypeMapper.javaTypeName(f));
    }

    @Test
    public void stringFieldWithJsonbMapsToObjectCaseInsensitive() {
        StringField f = new StringField("payload");
        f.addMetaAttr(com.metaobjects.attr.StringAttribute.create("dbColumnType", "JSONB"));
        assertEquals("Object", SpringTypeMapper.javaTypeName(f));
    }

    @Test
    public void stringFieldWithUuidColumnTypeStaysString() {
        // Only the jsonb open-bag escape hatch is a parsed value. Other @dbColumnType
        // values on a string field (e.g. uuid → still string-backed on the wire) stay String.
        StringField f = new StringField("externalRef");
        f.addMetaAttr(com.metaobjects.attr.StringAttribute.create("dbColumnType", "uuid"));
        assertEquals("String", SpringTypeMapper.javaTypeName(f));
    }

    @Test
    public void uuidFieldMapsToUUID() {
        // R6 Plan 2a: field.uuid is a first-class subtype (UuidField) with a native
        // java.util.UUID binding (parallel of KotlinTypeMapperTest's `uuid` arm).
        assertEquals("java.util.UUID",
            SpringTypeMapper.javaTypeName(new com.metaobjects.field.UuidField("externalId")));
    }

    @Test
    public void stringArrayFieldDtoComponentIsListOfString() {
        // dbColumnType slim-and-derive (Phase 1): a `field.string isArray:true` maps to a
        // native text[] column whose DTO component is List<String> (the array-ness is
        // DERIVED from isArray, never declared via @dbColumnType:text_array).
        StringField f = new StringField("tags");
        f.setArray(true);
        assertEquals("java.util.List<String>", SpringDtoGenerator.componentType(f, null));
    }

    @Test
    public void uuidArrayFieldDtoComponentIsListOfUUID() {
        // dbColumnType slim-and-derive (Phase 1): a `field.uuid isArray:true` maps to a
        // native uuid[] column whose DTO component is List<java.util.UUID> (DERIVED from
        // isArray — the removed @dbColumnType:uuid_array). Previously the uuid-array arm
        // was unwired; this pins the cross-port List<UUID> shape.
        com.metaobjects.field.UuidField f = new com.metaobjects.field.UuidField("refs");
        f.setArray(true);
        assertEquals("java.util.List<java.util.UUID>", SpringDtoGenerator.componentType(f, null));
    }

    @Test
    public void unsupportedFieldThrowsIllegalArgumentException() {
        // ObjectField is intentionally not in the mapper (deferred — see SpringDtoGenerator
        // javadoc). The mapper must throw a clear IllegalArgumentException naming both
        // the field class and the field name so the consumer can pinpoint the fix.
        com.metaobjects.field.ObjectField unsupported = new com.metaobjects.field.ObjectField("contact");
        try {
            SpringTypeMapper.javaTypeName(unsupported);
            fail("expected IllegalArgumentException for unsupported field type");
        } catch (IllegalArgumentException e) {
            String msg = e.getMessage();
            org.junit.Assert.assertTrue(
                "expected message to mention ObjectField; got: " + msg,
                msg != null && msg.contains("ObjectField"));
            org.junit.Assert.assertTrue(
                "expected message to mention field name 'contact'; got: " + msg,
                msg != null && msg.contains("contact"));
        }
    }
}
