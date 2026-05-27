package com.metaobjects.generator.spring;

import com.metaobjects.DataTypes;
import com.metaobjects.field.BooleanField;
import com.metaobjects.field.CurrencyField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.PrimitiveField;
import com.metaobjects.field.StringField;
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
    public void timestampFieldMapsToInstant() {
        assertEquals("java.time.Instant", SpringTypeMapper.javaTypeName(new TimestampField("createdAt")));
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
    public void uuidFieldMatchedBySubtypeMapsToUUID() {
        // field.uuid has no dedicated JVM class today — mapper matches on subtype name.
        // Use a minimal anonymous PrimitiveField with subType="uuid" to drive the path
        // (parallel of KotlinTypeMapperTest's `uuid` arm).
        PrimitiveField<String> field = new PrimitiveField<>("uuid", "externalId", DataTypes.STRING) {};
        assertEquals("java.util.UUID", SpringTypeMapper.javaTypeName(field));
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
