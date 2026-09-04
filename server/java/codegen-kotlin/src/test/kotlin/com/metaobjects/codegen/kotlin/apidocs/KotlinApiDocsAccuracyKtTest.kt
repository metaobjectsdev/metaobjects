package com.metaobjects.codegen.kotlin.apidocs

import com.metaobjects.generator.Generator
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinExtractorGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinOutputParserGenerator
import com.metaobjects.generator.kotlin.KotlinOutputPromptGenerator
import com.metaobjects.generator.kotlin.KotlinPayloadGenerator
import com.metaobjects.generator.kotlin.KotlinRelationsGenerator
import com.metaobjects.generator.kotlin.KotlinRenderHelperGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
import com.metaobjects.generator.kotlin.KotlinStoredProcGenerator
import com.metaobjects.generator.kotlin.apidocs.ApiSymbol
import com.metaobjects.generator.kotlin.apidocs.ApiSymbolKind
import com.metaobjects.generator.kotlin.apidocs.ApiUnit
import com.metaobjects.generator.kotlin.apidocs.KotlinApiModel
import com.metaobjects.generator.kotlin.apidocs.KotlinApiModelBuilder
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * ACCURACY GATE (Phase 3 keystone): proves the [KotlinApiModelBuilder]'s documented SDK surface ==
 * what the REAL `codegen-kotlin` generators actually emit.
 *
 * The builder enumerates symbol names via the `KotlinNaming` seam and gates inclusion via the same
 * subtype + abstract + `source.rdb @kind` + TPH + `@payloadRef` + json/xml gates the generators use,
 * so by construction documented == generated. This test is the cross-check that holds that promise:
 * it runs every real generator into a temp directory, then greps the generated Kotlin for every
 * documented symbol (FORWARD) and confirms skip-shapes are not over-documented (INVERSE). It
 * deliberately does NOT compare against the builder's own strings — the forward assertions match
 * documented names against the independently generated source.
 *
 * The fixture covers every skip branch the builder exercises:
 * - `Author` table entity (pk, `@required name`, optional `bio`, `field.enum status`,
 *   `@filterable name`) → MODEL / DATA_ACCESS / REST / FILTER / VALIDATION;
 * - M:N `Author` ↔ `Tag` via the `AuthorTag` junction → the M:N REST traversal;
 * - `Address` value object (no identity, no rdb source) → MODEL only;
 * - `BaseNode` abstract entity → NO unit (no symbols);
 * - `SummaryOutput` json `template.output` → PAYLOAD / RENDER (ADR-0052: outbound only);
 * - `AnswerPrompt` responding `template.prompt` → PAYLOAD / PROMPT / OUTPUT_PARSER / EXTRACTOR;
 * - `ClassifyPrompt` `template.prompt` with NO `@responseRef` → PAYLOAD only (nothing elicits a
 *   typed reply, so no fragment and no parser).
 */
class KotlinApiDocsAccuracyKtTest {

    private companion object {
        const val PROJECT = "apidocs-fixture"
    }

    private lateinit var loader: MetaDataLoader
    private lateinit var model: KotlinApiModel
    private lateinit var outDir: Path
    private lateinit var templateRoot: Path

    /** All generated .kt concatenated. */
    private lateinit var allGenerated: String

    private val fixture = """{
      "metadata.root": { "package": "acme::blog", "children": [
        { "object.entity": { "name": "BaseNode", "@isAbstract": true, "children": [
            { "field.long": { "name": "id" } }
        ] } },
        { "object.entity": { "name": "Author", "children": [
            { "source.rdb":   { "@table": "authors" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 100, "@filterable": true } },
            { "field.string": { "name": "bio" } },
            { "field.enum":   { "name": "status", "@values": ["ACTIVE", "RETIRED"] } },
            { "relationship.association": { "name": "tags", "@cardinality": "many",
                "@objectRef": "Tag", "@through": "AuthorTag" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Tag", "children": [
            { "source.rdb":   { "@table": "tags" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "label", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "AuthorTag", "children": [
            { "source.rdb":         { "@table": "author_tags" } },
            { "field.long":         { "name": "authorId", "@required": true } },
            { "field.long":         { "name": "tagId",    "@required": true } },
            { "identity.primary":   { "@fields": ["authorId", "tagId"] } },
            { "identity.reference": { "name": "fkAuthor", "@fields": "authorId", "@references": "Author" } },
            { "identity.reference": { "name": "fkTag",    "@fields": "tagId",    "@references": "Tag" } }
        ] } },
        { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "street", "@required": true } },
            { "field.string": { "name": "city" } }
        ] } },
        { "object.projection": { "name": "SalesReport", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "regionName", "@maxLength": 100 } },
            { "field.long":   { "name": "totalCents" } },
            { "source.rdb":   { "@table": "v_sales_report", "@kind": "view" } }
        ] } },
        { "object.value": { "name": "OrderReportArgs", "children": [
            { "field.long": { "name": "orderId" } }
        ] } },
        { "object.projection": { "name": "OrderReport", "children": [
            { "field.string": { "name": "status", "@maxLength": 50 } },
            { "field.long":   { "name": "totalCents" } },
            { "source.rdb":   { "@kind": "storedProc", "@table": "get_order_report",
                                "@parameterRef": "OrderReportArgs" } }
        ] } },
        { "object.value": { "name": "SummaryPayload", "children": [
            { "field.string": { "name": "summary", "@required": true } }
        ] } },
        { "object.value": { "name": "ClassifyPayload", "children": [
            { "field.string": { "name": "label", "@required": true } }
        ] } },
        { "template.output": { "name": "SummaryOutput",
            "@payloadRef": "SummaryPayload",
            "@textRef": "blog/summary",
            "@format": "json" } },
        { "object.value": { "name": "AnswerPayload", "children": [
            { "field.string": { "name": "answer", "@required": true } }
        ] } },
        { "template.prompt": { "name": "AnswerPrompt",
            "@payloadRef": "SummaryPayload",
            "@responseRef": "AnswerPayload",
            "@textRef": "blog/answer",
            "@format": "text",
            "@responseFormat": "json",
            "@promptStyle": "inline" } },
        { "template.prompt": { "name": "ClassifyPrompt",
            "@payloadRef": "ClassifyPayload",
            "@textRef": "blog/classify",
            "@format": "json",
            "@promptStyle": "inline" } }
      ] }
    }""".trimIndent()

    @BeforeTest
    fun setUp() {
        loader = loadString("apidocs-accuracy", fixture)
        model = KotlinApiModelBuilder().build(loader, PROJECT)

        outDir = Files.createTempDirectory("kapidocs-gen-")
        templateRoot = Files.createTempDirectory("kapidocs-tpl-")
        writeTemplate(templateRoot, "blog/summary.mustache", "Summary: {{summary}}")

        runGenerators()

        val sb = StringBuilder()
        Files.walk(outDir).use { stream ->
            stream.filter { it.toString().endsWith(".kt") }.sorted().forEach { p ->
                sb.append(Files.readString(p)).append('\n')
            }
        }
        allGenerated = sb.toString()
        assertTrue(allGenerated.isNotBlank(), "expected the real generators to emit .kt")
    }

    @AfterTest
    fun tearDown() {
        outDir.toFile().deleteRecursively()
        templateRoot.toFile().deleteRecursively()
    }

    // ------------------------------------------------------------------------
    // load-smoke: the fixture loads and the expected nodes are present.
    // ------------------------------------------------------------------------

    @Test
    fun fixtureLoadsWithTheExpectedNodes() {
        assertTrue(loader.metaObjects.any { it.name.endsWith("::Author") }, "expected the Author entity")
        assertTrue(loader.metaObjects.any { it.name.endsWith("::Tag") }, "expected the Tag entity")
        assertTrue(loader.metaObjects.any { it.name.endsWith("::AuthorTag") }, "expected the AuthorTag junction")
        assertTrue(loader.metaObjects.any { it.name.endsWith("::Address") }, "expected the Address value object")
        assertTrue(model.units.isNotEmpty(), "expected at least one unit in the model")
    }

    // ------------------------------------------------------------------------
    // FORWARD: every documented TYPE name appears as a real identifier in the output.
    // ------------------------------------------------------------------------

    @Test
    fun everyDocumentedTypeNameAppearsInGeneratedKotlin() {
        // The generated-TYPE kinds whose symbol.name is an emitted Kotlin identifier. REST is
        // excluded (it documents "VERB path", handled separately). VALIDATION names the entity
        // data class (constraints live on it).
        val typeKinds = setOf(
            ApiSymbolKind.MODEL, ApiSymbolKind.DATA_ACCESS, ApiSymbolKind.FILTER,
            ApiSymbolKind.PAYLOAD, ApiSymbolKind.RENDER, ApiSymbolKind.PROMPT,
            ApiSymbolKind.OUTPUT_PARSER, ApiSymbolKind.EXTRACTOR, ApiSymbolKind.VALIDATION,
        )
        var checked = 0
        for (unit in model.units) {
            for (sym in unit.symbols) {
                if (sym.kind !in typeKinds) continue
                assertTrue(
                    containsIdentifier(allGenerated, sym.name),
                    "documented ${sym.kind} symbol '${sym.name}' (unit ${unit.node}) was NOT found as " +
                        "an identifier in the generated Kotlin — builder over-documents or names off-seam",
                )
                checked++
            }
        }
        assertTrue(checked >= 10, "expected to have cross-checked several documented type symbols; saw $checked")
    }

    // ------------------------------------------------------------------------
    // REST accuracy: each "VERB path" maps to a real controller route + base.
    // ------------------------------------------------------------------------

    @Test
    fun everyRestSymbolMapsToARealControllerMapping() {
        val controller = fileEndingWith("AuthorController.kt")
        val base = "/api/authors"
        assertTrue(
            controller.contains("@RequestMapping(\"$base\")"),
            "controller must carry the route base via @RequestMapping(\"$base\")",
        )

        val author = unit("Author")
        var restChecked = 0
        for (sym in author.symbols) {
            if (sym.kind != ApiSymbolKind.REST) continue
            val vp = sym.name.split(" ", limit = 2)
            assertEquals(2, vp.size, "REST symbol name must be 'VERB path'; saw '${sym.name}'")
            val verb = vp[0]
            val path = vp[1]
            assertTrue(
                path == base || path.startsWith("$base/"),
                "REST path '$path' must start with the controller base '$base'",
            )
            val sub = path.substring(base.length) // "" | "/{id}" | "/{id}/tags"
            assertTrue(
                controller.contains(mappingFor(verb, sub)),
                "REST symbol '${sym.name}' has no matching Spring mapping in AuthorController.\n" +
                    "expected to find: ${mappingFor(verb, sub)}",
            )
            restChecked++
        }
        // 5 CRUD verbs + 1 M:N traversal (tags).
        assertEquals(6, restChecked, "expected 6 REST symbols on Author (5 CRUD + 1 M:N)")
    }

    /** The exact Spring mapping the Kotlin controller emits for a verb + sub-path. */
    private fun mappingFor(verb: String, sub: String): String = when (verb) {
        "GET" -> if (sub.isEmpty()) "@GetMapping\n" else "@GetMapping(\"$sub\")"
        "POST" -> "@PostMapping\n"
        "DELETE" -> "@DeleteMapping(\"$sub\")"
        "PATCH" -> "@RequestMapping(value = [\"$sub\"], method = [RequestMethod.PATCH, RequestMethod.PUT])"
        else -> throw AssertionError("unexpected REST verb: $verb")
    }

    // ------------------------------------------------------------------------
    // Field-set accuracy: documented VALIDATION field set == data class property set.
    // ------------------------------------------------------------------------

    @Test
    fun documentedModelFieldSetEqualsDataClassPropertySet() {
        val author = unit("Author")
        val validation = symbol(author, ApiSymbolKind.VALIDATION, "Author")
        assertFalse(validation.fields.isEmpty(), "Author VALIDATION must document field shapes")

        val documented = validation.fields.map { it.name }.toSortedSet()
        val properties = dataClassProperties(fileEndingWith("acme/blog/Author.kt"), "Author")

        for (name in documented) {
            assertTrue(name in properties, "documented field '$name' is not a property of the Author data class")
        }
        assertEquals(properties, documented, "documented field set must equal Author's data-class property set")
    }

    // ------------------------------------------------------------------------
    // INVERSE: no over-documentation of skip-shapes.
    // ------------------------------------------------------------------------

    @Test
    fun valueObjectIsDocumentedAsModelOnly() {
        val address = unit("Address")
        assertEquals(
            setOf(ApiSymbolKind.MODEL), kinds(address),
            "value object Address → MODEL only (no DATA_ACCESS/REST/FILTER/etc.)",
        )
        // No AddressController / AddressTable / AddressFilterAllowlist emitted (generators skip VOs).
        assertFalse(containsIdentifier(allGenerated, "AddressController"), "no AddressController should be generated")
        assertFalse(containsIdentifier(allGenerated, "AddressTable"), "no AddressTable should be generated")
        assertFalse(
            containsIdentifier(allGenerated, "AddressFilterAllowlist"),
            "no AddressFilterAllowlist should be generated",
        )
    }

    @Test
    fun viewProjectionIsDocumentedAsReadModelWithExposedTable() {
        // A view-kind object.projection → MODEL (read-model data class) + a read-only Exposed
        // Table DATA_ACCESS surface. NO write surfaces (no REST/FILTER/VALIDATION — the controller
        // / filter / validation gates require a writable table entity).
        val sales = unit("SalesReport")
        assertEquals("projection", sales.kind, "view projection SalesReport → projection unit kind")
        assertEquals(
            setOf(ApiSymbolKind.MODEL, ApiSymbolKind.DATA_ACCESS), kinds(sales),
            "view projection SalesReport → MODEL + read-only Exposed table only",
        )
        // Forward-confirm both documented symbols are really generated...
        assertTrue(containsIdentifier(allGenerated, "SalesReport"), "documented SalesReport model must be generated")
        val dataAccess = symbol(sales, ApiSymbolKind.DATA_ACCESS, "SalesReportTable")
        assertTrue(
            containsIdentifier(allGenerated, dataAccess.name),
            "documented projection Exposed table '${dataAccess.name}' must be generated",
        )
        // ...and NO controller / filter allowlist is generated for the projection.
        assertFalse(containsIdentifier(allGenerated, "SalesReportController"), "no SalesReportController")
        assertFalse(containsIdentifier(allGenerated, "SalesReportFilterAllowlist"), "no SalesReportFilterAllowlist")
    }

    @Test
    fun procProjectionIsDocumentedAsReadModelWithProcCallable() {
        // A storedProc-kind object.projection → MODEL + the <Name>Proc callable DATA_ACCESS surface
        // (KotlinStoredProcGenerator emits it for a proc-backed projection). No write surfaces.
        val order = unit("OrderReport")
        assertEquals("projection", order.kind, "proc projection OrderReport → projection unit kind")
        assertEquals(
            setOf(ApiSymbolKind.MODEL, ApiSymbolKind.DATA_ACCESS), kinds(order),
            "proc projection OrderReport → MODEL + the proc callable only",
        )
        val dataAccess = symbol(order, ApiSymbolKind.DATA_ACCESS, "OrderReportProc")
        assertTrue(
            containsIdentifier(allGenerated, dataAccess.name),
            "documented proc callable '${dataAccess.name}' must be generated",
        )
        // No Exposed Table is generated for a proc-backed projection (table generator skips it).
        assertFalse(containsIdentifier(allGenerated, "OrderReportTable"), "no OrderReportTable for a proc projection")
        assertFalse(containsIdentifier(allGenerated, "OrderReportController"), "no OrderReportController")
    }

    @Test
    fun abstractObjectIsNotDocumented() {
        // An abstract entity yields no MODEL (cannot be instantiated) and every instance generator
        // skips it → NO symbols → NO unit (not an empty unit).
        assertFalse(
            model.units.any { it.node == "BaseNode" },
            "abstract object BaseNode must NOT produce a unit (no symbols → no unit)",
        )
    }

    @Test
    fun promptWithNoResponseIsDocumentedAsPayloadOnly() {
        // ADR-0052: a template.prompt IS documented — it carries a @payloadRef record like any
        // template. What a prompt with NO @responseRef does not get is the INBOUND tier: nothing
        // elicits a typed reply, so no fragment and no parser. (RENDER is absent too: the render
        // helper is template.output-only in every port.)
        val classify = unit("ClassifyPrompt")
        assertEquals(
            setOf(ApiSymbolKind.PAYLOAD),
            kinds(classify),
            "a template.prompt with no @responseRef → PAYLOAD only",
        )
        // And the output-only helpers are not generated for a prompt template.
        assertFalse(containsIdentifier(allGenerated, "ClassifyPromptRenderHelper"), "no ClassifyPromptRenderHelper")
        assertFalse(containsIdentifier(allGenerated, "ClassifyPromptParser"), "no ClassifyPromptParser")
        assertFalse(containsIdentifier(allGenerated, "ClassifyPromptPrompt"), "no ClassifyPromptPrompt")
        assertFalse(containsIdentifier(allGenerated, "ClassifyPromptExtractor"), "no ClassifyPromptExtractor")
    }

    @Test
    fun outputTemplateDocumentsItsOutboundKindsOnly() {
        // ADR-0052 direction pin at the DOCS tier. A template.output renders outbound; the
        // fragment, parser and extractor all describe reading a model's REPLY, so documenting
        // them here named symbols codegen no longer emits.
        val summary = unit("SummaryOutput")
        assertEquals(
            setOf(ApiSymbolKind.PAYLOAD, ApiSymbolKind.RENDER),
            kinds(summary),
            "json template.output → PAYLOAD/RENDER only",
        )
    }

    @Test
    fun respondingPromptDocumentsTheInboundKinds() {
        // The other half: the inbound symbols belong to a prompt that declares @responseRef.
        // RENDER is absent because the render helper is template.output-only in every port.
        val answer = unit("AnswerPrompt")
        assertEquals(
            setOf(
                ApiSymbolKind.PAYLOAD, ApiSymbolKind.PROMPT,
                ApiSymbolKind.OUTPUT_PARSER, ApiSymbolKind.EXTRACTOR,
            ),
            kinds(answer),
            "responding template.prompt → PAYLOAD/PROMPT/OUTPUT_PARSER/EXTRACTOR",
        )
    }

    // ------------------------------------------------------------------------
    // run the REAL generators
    // ------------------------------------------------------------------------

    private fun runGenerators() {
        val dir = outDir.toString()
        val tpl = templateRoot.toString()
        run(KotlinEntityGenerator(), mapOf("outputDir" to dir))
        run(KotlinExposedTableGenerator(), mapOf("outputDir" to dir))
        run(KotlinStoredProcGenerator(), mapOf("outputDir" to dir))
        run(KotlinSpringControllerGenerator(), mapOf("outputDir" to dir))
        run(KotlinFilterAllowlistGenerator(), mapOf("outputDir" to dir))
        run(KotlinRelationsGenerator(), mapOf("outputDir" to dir))
        run(KotlinPayloadGenerator(), mapOf("outputDir" to dir))
        run(KotlinRenderHelperGenerator(), mapOf("outputDir" to dir, "templateRoot" to tpl))
        run(KotlinOutputPromptGenerator(), mapOf("outputDir" to dir))
        run(KotlinOutputParserGenerator(), mapOf("outputDir" to dir))
        run(KotlinExtractorGenerator(), mapOf("outputDir" to dir))
    }

    private fun run(gen: Generator, args: Map<String, String>) {
        gen.setArgs(HashMap(args))
        gen.execute(loader)
    }

    // ------------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------------

    private fun writeTemplate(root: Path, relative: String, body: String) {
        val f = root.resolve(relative)
        Files.createDirectories(f.parent)
        Files.writeString(f, body)
    }

    /** Word-boundary identifier match: [name] must appear as a whole Kotlin identifier. */
    private fun containsIdentifier(haystack: String, name: String): Boolean =
        Regex("(?<![A-Za-z0-9_\$])" + Regex.escape(name) + "(?![A-Za-z0-9_\$])").containsMatchIn(haystack)

    /** Parse the primary-constructor `data class <Name>( ... )` header into its property-name set. */
    private fun dataClassProperties(src: String, className: String): java.util.SortedSet<String> {
        val decl = src.indexOf("class $className(")
        assertTrue(decl >= 0, "could not find `class $className(` in:\n$src")
        val open = src.indexOf('(', decl)
        var depth = 0
        var close = -1
        for (i in open until src.length) {
            when (src[i]) {
                '(' -> depth++
                ')' -> { depth--; if (depth == 0) { close = i; break } }
            }
        }
        assertTrue(close > open, "could not find constructor close for $className")
        val header = src.substring(open + 1, close)

        val names = sortedSetOf<String>()
        for (raw in splitTopLevel(header)) {
            val part = raw.trim()
            if (part.isEmpty()) continue
            // A KotlinPoet ctor param is `[@anno] val <name>: <Type> [= default]`. Take the token
            // after `val`/`var`, stripping a trailing ':' if it abuts the type.
            val tokens = part.split(Regex("\\s+"))
            val idx = tokens.indexOfFirst { it == "val" || it == "var" }
            val nameTok = if (idx >= 0 && idx + 1 < tokens.size) tokens[idx + 1] else tokens.first()
            names.add(nameTok.substringBefore(':').trim())
        }
        return names
    }

    /**
     * Split a constructor header on TOP-LEVEL commas only — commas nested inside an
     * annotation argument list (`@field:Size(min = 1, max = 100)`) or a generic type
     * (`Map<String, V>`) must NOT split a parameter.
     */
    private fun splitTopLevel(header: String): List<String> {
        val parts = mutableListOf<String>()
        val sb = StringBuilder()
        var depth = 0
        for (c in header) {
            when (c) {
                '(', '<', '[' -> { depth++; sb.append(c) }
                ')', '>', ']' -> { depth--; sb.append(c) }
                ',' -> if (depth == 0) { parts.add(sb.toString()); sb.clear() } else sb.append(c)
                else -> sb.append(c)
            }
        }
        if (sb.isNotBlank()) parts.add(sb.toString())
        return parts
    }

    private fun fileEndingWith(suffix: String): String {
        var found: String? = null
        Files.walk(outDir).use { stream ->
            val match = stream.filter { it.toString().endsWith(suffix) }.findFirst()
            if (match.isPresent) found = Files.readString(match.get())
        }
        return found ?: throw AssertionError("no generated file ending with '$suffix' under $outDir")
    }

    private fun unit(node: String): ApiUnit =
        model.units.firstOrNull { it.node == node } ?: throw AssertionError("no unit '$node' in ${model.units}")

    private fun symbol(u: ApiUnit, kind: ApiSymbolKind, name: String): ApiSymbol =
        u.symbols.firstOrNull { it.kind == kind && it.name == name }
            ?: throw AssertionError("no $kind '$name' in ${u.symbols}")

    private fun kinds(u: ApiUnit): Set<ApiSymbolKind> = u.symbols.map { it.kind }.toSet()
}
