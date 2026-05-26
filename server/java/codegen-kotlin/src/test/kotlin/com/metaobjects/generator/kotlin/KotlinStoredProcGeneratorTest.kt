package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KotlinStoredProcGeneratorTest {

    @Test fun storedProcEntityEmitsCallFnFile() {
        // Entity has 2 result-row fields (id, label) and NO @param fields → emits
        // a no-arg `call(): List<MyProc>` function (not the documented stub).
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "MyProc", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "label", "@required": true } },
                { "source.rdb":   { "@kind": "storedProc", "@procName": "get_data" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-explicit-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-explicit", fixture))

            val emitted = outDir.resolve("acme/demo/MyProcProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            // Package + imports wired.
            assertTrue("package acme.demo" in src, src)
            assertTrue("import org.jetbrains.exposed.sql.Transaction" in src, src)
            assertTrue("import org.jetbrains.exposed.sql.transactions.transaction" in src, src)
            // Object + PROC_NAME.
            assertTrue("object MyProcProc {" in src, src)
            assertTrue("const val PROC_NAME = \"get_data\"" in src, src)
            // Real no-arg call function returning the data class.
            assertTrue("fun call(): List<MyProc>" in src, src)
            // Empty-parens SQL (no params).
            assertTrue("SELECT * FROM \${PROC_NAME}()" in src, src)
            // Result-row mapping.
            assertTrue("rs.getLong(\"id\")" in src, src)
            assertTrue("rs.getString(\"label\")" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun procNameDefaultsToTableAttr() {
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "MyProc", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@kind": "storedProc", "@table": "get_orders" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-table-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-table", fixture))

            val emitted = outDir.resolve("acme/demo/MyProcProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            assertTrue("const val PROC_NAME = \"get_orders\"" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun procNameFallsBackToEntityShortName() {
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "MyProc", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@kind": "storedProc" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-fallback-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-fallback", fixture))

            val emitted = outDir.resolve("acme/demo/MyProcProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            assertTrue("const val PROC_NAME = \"myproc\"" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun nonStoredProcEntitySkipped() {
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@table": "authors", "@kind": "table" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-skip-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-skip", fixture))

            val notEmitted = outDir.resolve("acme/demo/AuthorProc.kt")
            assertFalse(Files.exists(notEmitted),
                "should NOT emit Proc stub for table-kind entity; files=${Files.walk(outDir).toList()}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === New @param-binding tests =============================================

    @Test fun `storedProc with one @param emits typed call fn`() {
        // OrderReport: orderId (@param, Long) + status (result, String) + total (result, Long)
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "OrderReport", "children": [
                { "field.long":   { "name": "orderId", "@param": true } },
                { "field.string": { "name": "status" } },
                { "field.long":   { "name": "total" } },
                { "source.rdb":   { "@kind": "storedProc", "@procName": "get_order_report" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-one-param-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-one-param", fixture))

            val emitted = outDir.resolve("acme/demo/OrderReportProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            // Typed call signature with the param.
            assertTrue("fun call(orderId: Long): List<OrderReport>" in src, src)
            // Single `?` placeholder.
            assertTrue("SELECT * FROM \${PROC_NAME}(?)" in src, src)
            // Bindings list with LongColumnType + orderId.
            assertTrue("org.jetbrains.exposed.sql.LongColumnType() to orderId" in src, src)
            // Result-row mapping uses status + total only (orderId is NOT mapped).
            assertTrue("rs.getString(\"status\")" in src, src)
            assertTrue("rs.getLong(\"total\")" in src, src)
            assertFalse("rs.getLong(\"orderId\")" in src,
                "orderId is a @param, must not appear in result-row mapping; src=$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `storedProc with no @param emits no-arg call fn`() {
        // GetAllProducts: no params, result fields name + price.
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "GetAllProducts", "children": [
                { "field.string": { "name": "name" } },
                { "field.long":   { "name": "price" } },
                { "source.rdb":   { "@kind": "storedProc", "@procName": "get_all_products" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-no-param-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-no-param", fixture))

            val emitted = outDir.resolve("acme/demo/GetAllProductsProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            // No-arg call signature.
            assertTrue("fun call(): List<GetAllProducts>" in src, src)
            // Empty parens in the SQL.
            assertTrue("SELECT * FROM \${PROC_NAME}()" in src, src)
            // No bindings list emitted.
            assertFalse(", listOf(" in src,
                "no-param call must not emit a bindings list; src=$src")
            // Result-row mapping covers both fields.
            assertTrue("rs.getString(\"name\")" in src, src)
            assertTrue("rs.getLong(\"price\")" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `storedProc with multiple @param preserves order`() {
        // GetReport: year (Int, @param) + region (String, @param) — declared in that order.
        // Result fields: total (Long).
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "GetReport", "children": [
                { "field.int":    { "name": "year",   "@param": true } },
                { "field.string": { "name": "region", "@param": "in" } },
                { "field.long":   { "name": "total" } },
                { "source.rdb":   { "@kind": "storedProc", "@procName": "get_report" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kproc-multi-param-")
        try {
            val gen = KotlinStoredProcGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("proc-multi-param", fixture))

            val emitted = outDir.resolve("acme/demo/GetReportProc.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            // Signature in authoring order: year first, region second.
            assertTrue("fun call(year: Int, region: String): List<GetReport>" in src, src)
            // Two `?` placeholders.
            assertTrue("SELECT * FROM \${PROC_NAME}(?, ?)" in src, src)
            // Both bindings present, year before region (positional order matters).
            val yearIdx = src.indexOf("IntegerColumnType() to year")
            val regionIdx = src.indexOf("VarCharColumnType(255) to region")
            assertTrue(yearIdx > 0, "year binding missing; src=$src")
            assertTrue(regionIdx > 0, "region binding missing; src=$src")
            assertTrue(yearIdx < regionIdx,
                "year must bind before region (declared order); src=$src")
            // Result-row mapping for total only.
            assertTrue("rs.getLong(\"total\")" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
