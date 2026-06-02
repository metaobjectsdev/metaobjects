package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorException
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Compile-and-run proof for [KotlinRenderHelperGenerator] — the Kotlin port of the
 * cross-port render-helper (Java `SpringRenderHelperGenerator`, TS/C#/Python siblings).
 *
 * Mirrors [KotlinExtractorCompilesTest]: generate Payload + RenderHelper into a temp
 * dir, compile together with `KotlinCompilation(inheritClassPath=true)`, then
 * reflectively invoke the emitted helper against the EXISTING JVM render engine.
 *
 * The headline assertion is the BUILD-TIME drift gate: a mustache `{{missing}}` not on
 * the payload VO must make the GENERATOR throw [GeneratorException] at codegen time
 * (with `ERR_VAR_NOT_ON_PAYLOAD` + the offending field), NOT a runtime failure.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinRenderHelperCompilesTest {

    /** Write `<root>/<ref>.mustache` with [body]; creates parent dirs. */
    private fun writeTemplate(root: Path, ref: String, body: String) {
        val file = root.resolve("$ref.mustache")
        file.parent?.let { Files.createDirectories(it) }
        Files.writeString(file, body)
    }

    private fun compile(outDir: Path): KotlinCompilation.Result {
        val sources = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            .map { path -> SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText()) }
        return KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
    }

    // ---------------------------------------------------------------------------
    // 1. Document: render() returns a String via the JVM Renderer engine.
    // ---------------------------------------------------------------------------
    @Test fun `document render helper returns String`() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Welcome", "children": [
                { "field.string": { "name": "name" } }
            ] } },
            { "template.output": { "name": "WelcomePage",
                "@payloadRef": "Welcome",
                "@textRef": "pages/welcome",
                "@format": "html" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("krh-doc-")
        val tplRoot = Files.createTempDirectory("krh-doc-tpl-")
        try {
            writeTemplate(tplRoot, "pages/welcome", "Hello {{name}}")
            val loader = loadString("krh-doc", fx)
            KotlinPayloadGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinRenderHelperGenerator().apply {
                setArgs(mapOf("outputDir" to outDir.toString(), "templateRoot" to tplRoot.toString()))
            }.execute(loader)

            val helper = outDir.resolve("acme/demo/prompts/WelcomePageRenderHelper.kt")
            assertTrue(Files.exists(helper), "expected $helper; files=${Files.walk(outDir).toList()}")
            val src = helper.readText()
            assertTrue("object WelcomePageRenderHelper" in src, src)
            // Payload class is <TemplateShort>Payload (KotlinPayloadGenerator convention),
            // derived from the template short name (WelcomePage), NOT the VO name (Welcome).
            assertTrue("fun render(payload: WelcomePagePayload" in src, src)
            assertTrue(": String =" in src, "document helper must return String; src:\n$src")

            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "render-helper generated Kotlin failed to compile:\n${result.messages}")
            val cl = result.classLoader

            // payload(name="Ada") — class is <TemplateShort>Payload = WelcomePagePayload.
            val payloadClass = cl.loadClass("acme.demo.prompts.WelcomePagePayload")
            val payload = payloadClass.getDeclaredConstructor(String::class.java).newInstance("Ada")

            // FilesystemProvider rooted at the template dir.
            val providerClass = cl.loadClass("com.metaobjects.render.Provider")
            val fsProvider = cl.loadClass("com.metaobjects.render.FilesystemProvider")
                .getDeclaredConstructor(Path::class.java).newInstance(tplRoot)

            val helperClass = cl.loadClass("acme.demo.prompts.WelcomePageRenderHelper")
            val instance = helperClass.getDeclaredField("INSTANCE").get(null)
            val renderMethod = helperClass.getDeclaredMethod("render", payloadClass, providerClass)
            val rendered = renderMethod.invoke(instance, payload, fsProvider)
            assertEquals("Hello Ada", rendered, "document helper must render the mustache")
        } finally {
            outDir.toFile().deleteRecursively()
            tplRoot.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 2. Email: render() returns an EmailDocument with subject/htmlBody/textBody.
    // ---------------------------------------------------------------------------
    @Test fun `email render helper returns EmailDocument`() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Welcome", "children": [
                { "field.string": { "name": "name" } }
            ] } },
            { "template.output": { "name": "WelcomeEmail",
                "@payloadRef": "Welcome",
                "@kind": "email",
                "@subjectRef": "email/subject",
                "@htmlBodyRef": "email/html",
                "@textBodyRef": "email/text" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("krh-email-")
        val tplRoot = Files.createTempDirectory("krh-email-tpl-")
        try {
            writeTemplate(tplRoot, "email/subject", "Hi {{name}}")
            writeTemplate(tplRoot, "email/html", "<p>Hello {{name}}</p>")
            writeTemplate(tplRoot, "email/text", "Hello {{name}}")
            val loader = loadString("krh-email", fx)
            KotlinPayloadGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinRenderHelperGenerator().apply {
                setArgs(mapOf("outputDir" to outDir.toString(), "templateRoot" to tplRoot.toString()))
            }.execute(loader)

            val helper = outDir.resolve("acme/demo/prompts/WelcomeEmailRenderHelper.kt")
            val src = helper.readText()
            assertTrue("com.metaobjects.render.EmailDocument" in src, src)

            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "email render-helper generated Kotlin failed to compile:\n${result.messages}")
            val cl = result.classLoader

            val payloadClass = cl.loadClass("acme.demo.prompts.WelcomeEmailPayload")
            val payload = payloadClass.getDeclaredConstructor(String::class.java).newInstance("Ada")
            val providerClass = cl.loadClass("com.metaobjects.render.Provider")
            val fsProvider = cl.loadClass("com.metaobjects.render.FilesystemProvider")
                .getDeclaredConstructor(Path::class.java).newInstance(tplRoot)

            val helperClass = cl.loadClass("acme.demo.prompts.WelcomeEmailRenderHelper")
            val instance = helperClass.getDeclaredField("INSTANCE").get(null)
            val renderMethod = helperClass.getDeclaredMethod("render", payloadClass, providerClass)
            val email = renderMethod.invoke(instance, payload, fsProvider)
            assertNotNull(email, "email helper must return an EmailDocument")

            val emailClass = cl.loadClass("com.metaobjects.render.EmailDocument")
            assertEquals("Hi Ada", emailClass.getDeclaredMethod("subject").invoke(email))
            assertEquals("<p>Hello Ada</p>", emailClass.getDeclaredMethod("htmlBody").invoke(email))
            assertEquals("Hello Ada", emailClass.getDeclaredMethod("textBody").invoke(email))
        } finally {
            outDir.toFile().deleteRecursively()
            tplRoot.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 3a. BUILD-TIME drift gate FAILS: a {{missing}} not on the payload VO.
    // ---------------------------------------------------------------------------
    @Test fun `build-time drift gate throws on a missing field`() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Welcome", "children": [
                { "field.string": { "name": "name" } }
            ] } },
            { "template.output": { "name": "WelcomePage",
                "@payloadRef": "Welcome",
                "@textRef": "pages/welcome",
                "@format": "html" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("krh-drift-")
        val tplRoot = Files.createTempDirectory("krh-drift-tpl-")
        try {
            // {{missing}} is NOT a field on the Welcome VO.
            writeTemplate(tplRoot, "pages/welcome", "Hi {{missing}}")
            val loader = loadString("krh-drift", fx)
            val gen = KotlinRenderHelperGenerator().apply {
                setArgs(mapOf("outputDir" to outDir.toString(), "templateRoot" to tplRoot.toString()))
            }
            try {
                gen.execute(loader)
                fail("generator must THROW at codegen when a mustache field is not on the payload VO")
            } catch (e: GeneratorException) {
                val msg = e.message ?: ""
                assertTrue("ERR_VAR_NOT_ON_PAYLOAD" in msg,
                    "drift message must name ERR_VAR_NOT_ON_PAYLOAD; got: $msg")
                assertTrue("missing" in msg, "drift message must name the offending field 'missing'; got: $msg")
                assertTrue("WelcomePage" in msg, "drift message must name the template; got: $msg")
            }
        } finally {
            outDir.toFile().deleteRecursively()
            tplRoot.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------
    // 3b. Inverse: a clean mustache does NOT throw.
    // ---------------------------------------------------------------------------
    @Test fun `clean mustache does not throw`() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Welcome", "children": [
                { "field.string": { "name": "name" } }
            ] } },
            { "template.output": { "name": "WelcomePage",
                "@payloadRef": "Welcome",
                "@textRef": "pages/welcome",
                "@format": "html" } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("krh-clean-")
        val tplRoot = Files.createTempDirectory("krh-clean-tpl-")
        try {
            writeTemplate(tplRoot, "pages/welcome", "Hello {{name}}")
            val loader = loadString("krh-clean", fx)
            KotlinRenderHelperGenerator().apply {
                setArgs(mapOf("outputDir" to outDir.toString(), "templateRoot" to tplRoot.toString()))
            }.execute(loader)
            assertTrue(Files.exists(outDir.resolve("acme/demo/prompts/WelcomePageRenderHelper.kt")))
        } finally {
            outDir.toFile().deleteRecursively()
            tplRoot.toFile().deleteRecursively()
        }
    }
}
