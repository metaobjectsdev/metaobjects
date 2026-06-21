package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Codegen parity for the `field.map` subtype — an open-keyed `Map<String, V>` stored in a
 * single jsonb column. Keys are always String; the value type is the `@valueType` scalar
 * or the `@objectRef` value-object. Cross-port parity: TS column-mapper emits
 * `Record<string, V>` + a jsonb column for `field.map`.
 *
 *  - data class property: `@valueType: string` → `Map<String, String>`;
 *    `@objectRef: SomeVo` → `Map<String, SomeVo>`.
 *  - Exposed table column: a single `jsonb(...)` column (never flattened, never a native array).
 */
class KotlinFieldMapCodegenTest {

    // === Data-class property type (KotlinEntityGenerator) =====================

    @Test fun scalarValueTypeMapEmitsMapOfStringToScalar() {
        // field.map @valueType=string → `Map<String, String>` property on the entity.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Product", "children": [
                { "field.long": { "name": "id" } },
                { "field.map":  { "name": "labels", "@valueType": "string" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kmap-scalar-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("map-scalar", fx))

            val productKt = outDir.resolve("acme/demo/Product.kt")
            assertTrue(Files.exists(productKt),
                "expected $productKt; files=${Files.walk(outDir).toList()}")

            val src = Files.readString(productKt)
            assertTrue("val labels: Map<String, String>?" in src,
                "expected `val labels: Map<String, String>?` in:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun objectRefMapEmitsMapOfStringToVo() {
        // field.map @objectRef=Money → `Map<String, Money>` property; the VO data class is
        // resolved through the loader (KotlinEntityGenerator.resolveElementType).
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Money", "children": [
                { "field.long":   { "name": "amount", "@required": true } },
                { "field.string": { "name": "currency", "@required": true } }
            ] } },
            { "object.entity": { "name": "Cart", "children": [
                { "field.long": { "name": "id" } },
                { "field.map":  { "name": "prices", "@objectRef": "Money" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kmap-vo-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("map-vo", fx))

            val cartKt = outDir.resolve("acme/demo/Cart.kt")
            val moneyKt = outDir.resolve("acme/demo/Money.kt")
            assertTrue(Files.exists(cartKt),
                "expected $cartKt; files=${Files.walk(outDir).toList()}")
            assertTrue(Files.exists(moneyKt),
                "expected $moneyKt (object.value should be emitted); files=${Files.walk(outDir).toList()}")

            val cartSrc = Files.readString(cartKt)
            assertTrue("val prices: Map<String, Money>?" in cartSrc,
                "expected `val prices: Map<String, Money>?` in:\n$cartSrc")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === Exposed table column (KotlinExposedTableGenerator) ===================

    @Test fun fieldMapEmitsSingleJsonbColumn() {
        // field.map → ONE jsonb column on the Exposed table (the JSON object). Never a
        // native array, never flattened columns.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Product", "children": [
                { "field.long":   { "name": "id" } },
                { "field.map":    { "name": "labels", "@valueType": "string" } },
                { "source.rdb":   { "@table": "products" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kmap-tbl-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("map-tbl", fx))

            val tableKt = outDir.resolve("acme/demo/ProductTable.kt")
            assertTrue(Files.exists(tableKt),
                "expected $tableKt; files=${Files.walk(outDir).toList()}")

            val src = Files.readString(tableKt)
            // The single jsonb column for the map (same emission as a jsonb-stored field.object).
            assertTrue("val labels = jsonb(\"labels\"" in src,
                "expected a single `jsonb(\"labels\", ...)` column in:\n$src")
            // The jsonb extension import is present.
            assertTrue("import org.jetbrains.exposed.sql.json.jsonb" in src,
                "expected the exposed-json jsonb import in:\n$src")
            // It must NOT be emitted as a varchar/text scalar column.
            assertTrue("varchar(\"labels\"" !in src && "text(\"labels\"" !in src,
                "field.map must be a jsonb column, never varchar/text in:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
