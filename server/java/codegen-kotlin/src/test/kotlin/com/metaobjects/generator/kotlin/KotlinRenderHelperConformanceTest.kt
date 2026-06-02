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
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Cross-port conformance for the `template.output` render-helper generator (Kotlin half),
 * loading the SHARED corpus at `fixtures/template-output-render-conformance/` — the same
 * `meta.json` + `templates/` the TS port loads (`render-helper-conformance.test.ts`) and
 * the Java port loads (`GeneratedRenderHelperConformanceTest`), and the oracle pinned in
 * the corpus README. The expected strings here are IDENTICAL to the TS/Java/C#/Python halves.
 *
 * Generate Payload + RenderHelper → compile with `KotlinCompilation(inheritClassPath=true)`
 * → reflectively invoke `render(payload, provider)` against the on-disk templates via the
 * shared JVM [com.metaobjects.render.FilesystemProvider], asserting the README outputs
 * byte-for-byte:
 *   - document WelcomePage → "Hello Ada"
 *   - email WelcomeEmail → subject "Welcome Ada", htmlBody "<p>Hi Ada</p>", textBody "Hi Ada"
 *   - email WelcomeEmail with an XSS-bearing name → html part ESCAPED, text parts RAW
 *   - email OrderEmail (nested customer + array items section loop + partial footer)
 *   - the drift/ case → the GENERATOR throws [GeneratorException] (ERR_VAR_NOT_ON_PAYLOAD).
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinRenderHelperConformanceTest {

    private val corpus: Path = run {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (p != null && !Files.exists(p.resolve("fixtures/template-output-render-conformance"))) {
            p = p.parent
        }
        assertTrue(p != null, "could not locate fixtures/template-output-render-conformance from user.dir")
        p!!.resolve("fixtures/template-output-render-conformance")
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

    private fun generate(metaJson: Path, outDir: Path, templates: Path) {
        val loader = loadString("rh-conf", Files.readString(metaJson))
        KotlinPayloadGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
        KotlinRenderHelperGenerator().apply {
            setArgs(mapOf("outputDir" to outDir.toString(), "templateRoot" to templates.toString()))
        }.execute(loader)
    }

    private fun fsProvider(cl: ClassLoader, templates: Path): Any =
        cl.loadClass("com.metaobjects.render.FilesystemProvider")
            .getDeclaredConstructor(Path::class.java).newInstance(templates)

    // -------------------------------------------------------------------------
    // document → "Hello Ada"
    // -------------------------------------------------------------------------
    @Test fun `document WelcomePage matches corpus oracle`() {
        val outDir = Files.createTempDirectory("krhc-doc-")
        val templates = corpus.resolve("templates")
        try {
            generate(corpus.resolve("meta.json"), outDir, templates)
            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
            val cl = result.classLoader

            val payloadClass = cl.loadClass("acme.ai.prompts.WelcomePagePayload")
            val payload = payloadClass.getDeclaredConstructor(String::class.java).newInstance("Ada")
            val providerClass = cl.loadClass("com.metaobjects.render.Provider")
            val helperClass = cl.loadClass("acme.ai.prompts.WelcomePageRenderHelper")
            val instance = helperClass.getDeclaredField("INSTANCE").get(null)
            val render = helperClass.getDeclaredMethod("render", payloadClass, providerClass)
            assertEquals("Hello Ada", render.invoke(instance, payload, fsProvider(cl, templates)))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // -------------------------------------------------------------------------
    // email → EmailDocument
    // -------------------------------------------------------------------------
    @Test fun `email WelcomeEmail matches corpus oracle`() {
        val outDir = Files.createTempDirectory("krhc-email-")
        val templates = corpus.resolve("templates")
        try {
            generate(corpus.resolve("meta.json"), outDir, templates)
            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
            val cl = result.classLoader

            val payloadClass = cl.loadClass("acme.ai.prompts.WelcomeEmailPayload")
            val payload = payloadClass.getDeclaredConstructor(String::class.java).newInstance("Ada")
            val providerClass = cl.loadClass("com.metaobjects.render.Provider")
            val helperClass = cl.loadClass("acme.ai.prompts.WelcomeEmailRenderHelper")
            val instance = helperClass.getDeclaredField("INSTANCE").get(null)
            val email = helperClass.getDeclaredMethod("render", payloadClass, providerClass)
                .invoke(instance, payload, fsProvider(cl, templates))

            val emailClass = cl.loadClass("com.metaobjects.render.EmailDocument")
            assertEquals("Welcome Ada", emailClass.getDeclaredMethod("subject").invoke(email))
            assertEquals("<p>Hi Ada</p>", emailClass.getDeclaredMethod("htmlBody").invoke(email))
            assertEquals("Hi Ada", emailClass.getDeclaredMethod("textBody").invoke(email))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // -------------------------------------------------------------------------
    // email html SAFETY — @format=html part escapes markup/XSS; @format=text raw.
    // -------------------------------------------------------------------------
    @Test fun `email WelcomeEmail escapes html part but leaves text parts raw`() {
        val outDir = Files.createTempDirectory("krhc-xss-")
        val templates = corpus.resolve("templates")
        try {
            generate(corpus.resolve("meta.json"), outDir, templates)
            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
            val cl = result.classLoader

            val payloadClass = cl.loadClass("acme.ai.prompts.WelcomeEmailPayload")
            val payload = payloadClass.getDeclaredConstructor(String::class.java).newInstance("<b>A & Co</b>")
            val providerClass = cl.loadClass("com.metaobjects.render.Provider")
            val helperClass = cl.loadClass("acme.ai.prompts.WelcomeEmailRenderHelper")
            val instance = helperClass.getDeclaredField("INSTANCE").get(null)
            val email = helperClass.getDeclaredMethod("render", payloadClass, providerClass)
                .invoke(instance, payload, fsProvider(cl, templates))

            val emailClass = cl.loadClass("com.metaobjects.render.EmailDocument")
            val htmlBody = emailClass.getDeclaredMethod("htmlBody").invoke(email) as String
            // html part: < > & entity-escaped → no raw <b> reaches a mail client.
            assertEquals("<p>Hi &lt;b&gt;A &amp; Co&lt;/b&gt;</p>", htmlBody)
            assertTrue("<b>A" !in htmlBody, "html body must NOT contain a raw <b> tag; got: $htmlBody")
            // text parts (@format=text): raw, NOT escaped.
            assertEquals("Welcome <b>A & Co</b>", emailClass.getDeclaredMethod("subject").invoke(email))
            assertEquals("Hi <b>A & Co</b>", emailClass.getDeclaredMethod("textBody").invoke(email))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // -------------------------------------------------------------------------
    // email OrderEmail — nested customer + array items {{#items}} loop + partial.
    // nested/meta.json is a NO-PACKAGE sub-corpus → generated classes land in the
    // bare `prompts` package; the bare @objectRef resolves by short-name. Shares templates/.
    // -------------------------------------------------------------------------
    @Test fun `email OrderEmail renders nested array loop and partial`() {
        val outDir = Files.createTempDirectory("krhc-order-")
        val templates = corpus.resolve("templates")
        try {
            // The clean nested template must pass the build-time drift gate (no throw).
            generate(corpus.resolve("nested").resolve("meta.json"), outDir, templates)
            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
            val cl = result.classLoader

            val customerClass = cl.loadClass("prompts.CustomerPayload")
            val customer = customerClass.getDeclaredConstructor(String::class.java).newInstance("Ada")

            // field.int → kotlin Int (primitive) in the generated payload data class.
            val itemClass = cl.loadClass("prompts.ItemPayload")
            val itemCtor = itemClass.getDeclaredConstructor(String::class.java, Int::class.javaPrimitiveType)
            val itemA = itemCtor.newInstance("A1", 2)
            val itemB = itemCtor.newInstance("B2", 1)

            val payloadClass = cl.loadClass("prompts.OrderEmailPayload")
            val payload = payloadClass.getDeclaredConstructor(customerClass, List::class.java)
                .newInstance(customer, listOf(itemA, itemB))

            val providerClass = cl.loadClass("com.metaobjects.render.Provider")
            val helperClass = cl.loadClass("prompts.OrderEmailRenderHelper")
            val instance = helperClass.getDeclaredField("INSTANCE").get(null)
            val email = helperClass.getDeclaredMethod("render", payloadClass, providerClass)
                .invoke(instance, payload, fsProvider(cl, templates))

            val emailClass = cl.loadClass("com.metaobjects.render.EmailDocument")
            assertEquals("Order for Ada", emailClass.getDeclaredMethod("subject").invoke(email))
            assertEquals(
                "<h1>Ada</h1><ul><li>A1 x2</li><li>B2 x1</li></ul><hr/>Sent by Acme",
                emailClass.getDeclaredMethod("htmlBody").invoke(email),
            )
            assertEquals("Order for Ada: A1 x2; B2 x1;", emailClass.getDeclaredMethod("textBody").invoke(email))
            // the partial resolved into the html body.
            assertTrue(
                (emailClass.getDeclaredMethod("htmlBody").invoke(email) as String).contains("<hr/>Sent by Acme"),
                "html body must contain the resolved footer partial",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // -------------------------------------------------------------------------
    // drift/ → the GENERATOR throws GeneratorException (ERR_VAR_NOT_ON_PAYLOAD).
    // -------------------------------------------------------------------------
    @Test fun `drift case fails codegen`() {
        val outDir = Files.createTempDirectory("krhc-drift-")
        val driftRoot = corpus.resolve("drift")
        val templates = driftRoot.resolve("templates")
        try {
            val loader = loadString("rh-conf-drift", Files.readString(driftRoot.resolve("meta.json")))
            val gen = KotlinRenderHelperGenerator().apply {
                setArgs(mapOf("outputDir" to outDir.toString(), "templateRoot" to templates.toString()))
            }
            try {
                gen.execute(loader)
                fail("generator must THROW at codegen for the drift/ case")
            } catch (e: GeneratorException) {
                val msg = e.message ?: ""
                assertTrue("ERR_VAR_NOT_ON_PAYLOAD" in msg, "got: $msg")
                assertTrue("missing" in msg, "got: $msg")
                assertTrue("WelcomePage" in msg, "got: $msg")
                assertTrue("pages/bad" in msg, "got: $msg")
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
