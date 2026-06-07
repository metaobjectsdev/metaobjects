package com.metaobjects.generator.kotlin

import com.metaobjects.loader.ai.LlmTraceFieldDeriver
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * AI LLM-call trace persistence — Unit 2 (Kotlin port). Proves the cross-port
 * [LlmTraceFieldDeriver] pre-pass (shared JVM `metadata` module) feeds the Kotlin
 * codegen: a `LlmCallBase`-derived entity with a nested `template.prompt`
 * (`@payloadRef`/`@responseRef`) gets typed `voRequest`/`voResponse` nested refs
 * derived, and [KotlinEntityGenerator] emits them as typed nullable properties —
 * without the author restating them.
 *
 * In a real build this runs automatically: `meta:gen` (the Maven plugin's
 * AbstractMetaDataMojo) calls `deriveTraceFields(loader)` before executing the
 * Kotlin generators via the shared SPI. This test exercises the same sequence.
 *
 * The `record<Entity>` ergonomic helper is deferred for the Kotlin port (matching
 * the C# port): Kotlin persistence is generated Exposed tables, not a generic
 * metadata-driven runtime writer, so adopters write the generated entity directly.
 */
class KotlinTraceFieldDerivationTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::ai", "children": [
        { "object.entity": { "name": "LlmCallBase", "abstract": true, "children": [
            { "field.string": { "name": "spanId" } }
        ] } },
        { "object.value": { "name": "GreetingRequest", "children": [
            { "field.string": { "name": "prompt" } }
        ] } },
        { "object.value": { "name": "GreetingResponse", "children": [
            { "field.string": { "name": "greeting" } },
            { "field.int":    { "name": "score" } }
        ] } },
        { "object.entity": { "name": "GreetingCall", "extends": "acme::ai::LlmCallBase", "children": [
            { "template.prompt": { "name": "greet",
                "@payloadRef": "acme::ai::GreetingRequest",
                "@responseRef": "acme::ai::GreetingResponse" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `deriveTraceFields feeds the Kotlin entity generator`() {
        val outDir = Files.createTempDirectory("kgen-trace-")
        try {
            val loader = loadString("trace", fixture)
            // The pre-freeze pass the Maven mojo runs before the Kotlin generators.
            LlmTraceFieldDeriver.deriveTraceFields(loader)

            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loader)

            val greeting = outDir.resolve("acme/ai/GreetingCall.kt")
            assertTrue(Files.exists(greeting),
                "expected $greeting; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(greeting)
            // Derived typed nested refs (the storage shape is jsonb; the property type
            // is the referenced VO regardless of storage).
            assertTrue("voResponse: GreetingResponse?" in src,
                "expected derived voResponse in:\n$src")
            assertTrue("voRequest: GreetingRequest?" in src,
                "expected derived voRequest in:\n$src")
            // The referenced VOs are emitted as data classes.
            assertTrue(Files.exists(outDir.resolve("acme/ai/GreetingResponse.kt")),
                "expected GreetingResponse.kt to be emitted")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
