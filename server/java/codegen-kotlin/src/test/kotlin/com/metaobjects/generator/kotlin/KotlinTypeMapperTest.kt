package com.metaobjects.generator.kotlin

import com.metaobjects.DataTypes
import com.metaobjects.field.BooleanField
import com.metaobjects.field.CurrencyField
import com.metaobjects.field.DateField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.EnumField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.PrimitiveField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimestampField
import com.metaobjects.metadata.ktx.loadString
import com.squareup.kotlinpoet.BOOLEAN
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.DOUBLE
import com.squareup.kotlinpoet.INT
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.STRING
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class KotlinTypeMapperTest {

    companion object {
        // Force full SPI/registry initialization before any direct MetaField instantiation,
        // which would otherwise short-circuit the FieldTypesMetaDataProvider registration chain.
        init { TestRegistryBootstrap.ensureInitialized() }
    }


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

    // === Currency / Enum / UUID coverage ===

    @Test fun `currency field maps to Long and long exposed column`() {
        val f = CurrencyField("priceCents")
        // Wire/JVM type: Long (integer minor units invariant).
        assertEquals(LONG, KotlinTypeMapper.kotlinTypeName(f))
        // Exposed column reuses long() — same physical storage as LongField.
        assertEquals("long(\"priceCents\")", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun `enum field maps to String and varchar(64) exposed column`() {
        val f = EnumField("status")
        // v1 enum representation: String + VARCHAR; full enum-class emission deferred.
        assertEquals(STRING, KotlinTypeMapper.kotlinTypeName(f))
        assertEquals("varchar(\"status\", 64)", KotlinTypeMapper.exposedColumnSpec(f))
    }

    @Test fun enumTypeNameComputesClassName() {
        // Load a small fixture so we have a real MetaObject Player with field.enum status.
        // The naming rule under test is <EntityShortName><FieldPascalCase> in the entity's package.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Player", "children": [
                { "field.long": { "name": "id" } },
                { "field.enum": { "name": "status",
                    "@values": ["ACTIVE", "INACTIVE", "BANNED"] } }
            ] } }
          ] }
        }""".trimIndent()
        val loader = loadString("enum-name", fx)
        val entity = loader.metaObjects.first { it.name == "acme::demo::Player" }
        val field = entity.metaFields.first { it.name == "status" } as EnumField

        val name = KotlinTypeMapper.enumTypeName(field, entity)
        assertEquals("acme.demo", name?.packageName)
        assertEquals("PlayerStatus", name?.simpleName)

        // Non-enum fields → null (caller falls through to kotlinTypeName).
        val idField = entity.metaFields.first { it.name == "id" }
        assertNull(KotlinTypeMapper.enumTypeName(idField, entity))
    }

    @Test fun `uuid field (matched by subtype) maps to java util UUID and uuid exposed column`() {
        // `field.uuid` has no dedicated Java class today — mapper matches by subtype name.
        // Use a minimal anonymous PrimitiveField with subType="uuid" to drive the path.
        val f = object : PrimitiveField<String>("uuid", "externalId", DataTypes.STRING) {}
        val tn = KotlinTypeMapper.kotlinTypeName(f) as ClassName
        assertEquals("java.util", tn.packageName)
        assertEquals("UUID", tn.simpleName)
        assertEquals("uuid(\"externalId\")", KotlinTypeMapper.exposedColumnSpec(f))
    }
}
