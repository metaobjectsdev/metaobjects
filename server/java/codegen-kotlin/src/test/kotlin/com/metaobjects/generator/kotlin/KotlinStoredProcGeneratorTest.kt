package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KotlinStoredProcGeneratorTest {

    @Test fun storedProcEntityEmitsProcStubFile() {
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
            // Package + import wired.
            assertTrue("package acme.demo" in src, src)
            assertTrue("import org.jetbrains.exposed.sql.Transaction" in src, src)
            // Generated stub body.
            assertTrue("object MyProcProc {" in src, src)
            assertTrue("const val PROC_NAME = \"get_data\"" in src, src)
            // Documented stub references the data class + Transaction receiver.
            assertTrue("fun Transaction.callMyProc(" in src, src)
            assertTrue("List<MyProc>" in src, src)
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
}
