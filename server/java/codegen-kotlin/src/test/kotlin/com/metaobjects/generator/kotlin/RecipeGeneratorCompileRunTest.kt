package com.metaobjects.generator.kotlin

import com.metaobjects.generator.Generator
import com.metaobjects.generator.GeneratorBase
import com.metaobjects.loader.InMemoryStringSource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The Kotlin example generator in `docs/recipes/generators/kotlin/` is what the guidance tells
 * a Kotlin adopter to copy (ADR-0034 Amendment 4). This compiles it VERBATIM against the
 * current codegen-base (`FileEmittingGenerator` + `ModelWalk`), runs it through the same
 * `Generator` SPI `metaobjects:generate` calls, and checks the output parses and reads the
 * model through inheritance — so the recipe cannot rot. It is an example, not a product surface.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class RecipeGeneratorCompileRunTest {

    private val model = """
        { "metadata": { "package": "shop", "children": [
          { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "city", "@required": true } } ]}},
          { "object.entity": { "name": "BaseEntity", "abstract": true, "children": [
            { "field.long": { "name": "id" } },
            { "field.timestamp": { "name": "createdAt", "@required": true } },
            { "field.string": { "name": "labels", "isArray": true, "@maxLength": 40 } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } } ]}},
          { "object.entity": { "name": "Customer", "extends": "BaseEntity", "children": [
            { "source.rdb": { "@table": "customers" } },
            { "field.object": { "name": "shipping", "@objectRef": "Address", "@storage": "jsonb" } },
            { "field.enum": { "name": "tier", "@values": ["free", "paid"] } } ]}}
        ]}}
    """.trimIndent()

    @Test
    fun kotlinRecipeCompilesAndGenerates() {
        val recipe = Path.of("../../../docs/recipes/generators/kotlin/JsonSchemaGenerator.kt").normalize()
        assertTrue(Files.exists(recipe), "expected ${recipe.toAbsolutePath()}")

        val result = KotlinCompilation().apply {
            sources = listOf(SourceFile.kotlin("JsonSchemaGenerator.kt", Files.readString(recipe)))
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)

        val loader = MetaDataLoader(LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "recipe-kt")
        loader.init()
        loader.load(listOf(InMemoryStringSource(model, "recipe/meta.shop.json")))

        val out = Files.createTempDirectory("mo-kt-recipe")
        val gen = result.classLoader.loadClass("com.acme.codegen.KtJsonSchemaGenerator")
            .getConstructor().newInstance() as Generator
        gen.setArgs(mapOf(GeneratorBase.ARG_OUTPUTDIR to out.toString())).execute(loader)

        val customer = Files.readString(out.resolve("Customer.schema.json"))
        assertTrue("\"createdAt\": {\"type\": \"string\", \"format\": \"date-time\"}" in customer, customer)
        assertTrue("\"labels\": {\"type\": \"array\", \"items\": {\"type\": \"string\", \"maxLength\": 40}}" in customer, customer)
        assertTrue("\"shipping\": {\"\$ref\": \"./Address.schema.json\"}" in customer, customer)
        assertTrue("\"required\": [\"createdAt\"]" in customer, customer)
        assertFalse(Files.exists(out.resolve("BaseEntity.schema.json")))
        // It parses as JSON.
        com.fasterxml.jackson.databind.ObjectMapper().readTree(customer)
    }
}
