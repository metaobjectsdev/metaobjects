package com.metaobjects.generator.kotlin

import com.metaobjects.field.BooleanField
import com.metaobjects.field.DateField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimestampField
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.DOUBLE
import com.squareup.kotlinpoet.INT
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.STRING
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class KotlinTypeMapperTest {

    @Test fun `string field maps to String`() {
        val f = StringField("name")
        assertEquals(STRING, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `int field maps to Int`() {
        val f = IntegerField("count")
        assertEquals(INT, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `long field maps to Long`() {
        val f = LongField("id")
        assertEquals(LONG, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `double field maps to Double`() {
        val f = DoubleField("ratio")
        assertEquals(DOUBLE, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `boolean field maps to Boolean`() {
        val f = BooleanField("active")
        assertEquals(BOOLEAN, KotlinTypeMapper.kotlinTypeName(f))
    }

    @Test fun `date field maps to java time LocalDate`() {
        val f = DateField("birthday")
        val tn = KotlinTypeMapper.kotlinTypeName(f) as ClassName
        assertEquals("java.time", tn.packageName)
        assertEquals("LocalDate", tn.simpleName)
    }

    @Test fun `timestamp field maps to java time Instant`() {
        val f = TimestampField("createdAt")
        val tn = KotlinTypeMapper.kotlinTypeName(f) as ClassName
        assertEquals("java.time", tn.packageName)
        assertEquals("Instant", tn.simpleName)
    }

    @Test fun `string field maps to varchar exposed column`() {
        val f = StringField("name")
        val spec = KotlinTypeMapper.exposedColumnSpec(f)
        assertTrue(spec.contains("varchar"), "expected varchar in: $spec")
        assertTrue(spec.contains("\"name\""), "expected column name in: $spec")
    }

    @Test fun `long field maps to long exposed column`() {
        val f = LongField("id")
        val spec = KotlinTypeMapper.exposedColumnSpec(f)
        assertEquals("long(\"id\")", spec)
    }

    @Test fun `int field maps to integer exposed column`() {
        val f = IntegerField("count")
        assertEquals("integer(\"count\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `boolean field maps to bool exposed column`() {
        val f = BooleanField("active")
        assertEquals("bool(\"active\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `double field maps to double exposed column`() {
        val f = DoubleField("ratio")
        assertEquals("double(\"ratio\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `date field maps to date exposed column`() {
        val f = DateField("birthday")
        assertEquals("date(\"birthday\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `timestamp field maps to timestampWithTimeZone exposed column`() {
        val f = TimestampField("createdAt")
        assertEquals("timestampWithTimeZone(\"createdAt\")", KotlinTypeMapper.exposedColumnSpec(f))
    }
}
