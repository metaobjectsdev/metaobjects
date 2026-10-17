package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorException
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * `packageName` is required by the two generators that write a file of their own beside the
 * entities. A pom that added one without it used to fail with `packageName is required`,
 * which names neither the generator nor the arg's owner among a dozen in the same
 * `<generators>`.
 */
class KotlinPackageNameRequiredTest {

    private val model = """{ "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [ { "field.long": { "name": "id" } } ] } }
    ] } }"""

    private fun message(gen: com.metaobjects.generator.GeneratorBase): String? {
        val out = Files.createTempDirectory("kgen-pkg-")
        try {
            gen.setArgs(mapOf("outputDir" to out.toString()))
            return assertFailsWith<GeneratorException> { gen.execute(loadString("pkg", model)) }.message
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test fun `the validator generator names itself when packageName is missing`() {
        val m = message(KotlinValidatorGenerator())
        assertTrue(m!!.contains("KotlinValidatorGenerator (\"validator\")") && m.contains("packageName is required"), m)
    }

    @Test fun `the spring-config generator names itself when packageName is missing`() {
        val m = message(KotlinSpringConfigGenerator())
        assertTrue(m!!.contains("KotlinSpringConfigGenerator (\"spring-config\")") && m.contains("packageName is required"), m)
    }

    @Test fun `spring-config requires the validator only while the validator hook is emitted`() {
        assertEquals(listOf("validator"), KotlinSpringConfigGenerator().configuredRequires())
        assertEquals(
            listOf("validator"),
            KotlinSpringConfigGenerator().apply { setArgs(mapOf("validatorEnabled" to "TRUE")) }.configuredRequires(),
        )
        assertEquals(
            emptyList(),
            KotlinSpringConfigGenerator().apply { setArgs(mapOf("validatorEnabled" to "false")) }.configuredRequires(),
        )
    }
}
