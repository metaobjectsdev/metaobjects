package com.metaobjects.metadata.ktx

import com.metaobjects.field.StringField
import com.metaobjects.io.json.CanonicalJsonSerializer
import com.metaobjects.layout.MetaLayout
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.registry.MetaDataRegistry
import com.metaobjects.registry.MetaDataTypeProvider
import com.metaobjects.source.JsonSource
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A project's own vocabulary, written in Kotlin and passed to the metadata-ktx loader as
 * `providers = listOf(...)`. Runs the two shared `provider-custom-vocabulary-*` conformance
 * fixtures: loaded with the provider the input matches `expected.json`; loaded without it the
 * strict load refuses it with the expected codes, in order, at the expected JSON paths.
 */
class ProviderVocabularyTest {

    /** The project's own layout subtype. */
    class PickerLayout(name: String) : MetaLayout("picker", name)

    /** `layout.picker` + `field.string` gains `@searchable` / `@valueLabels`. */
    class ContactVocabulary : MetaDataTypeProvider {
        override fun getProviderId() = "example-custom-vocabulary"

        // The Java port's real provider ids; the cross-port alias "metaobjects-core-types" is
        // not a Java provider id.
        override fun getDependencies() = arrayOf("field-types", "layout-types")

        override fun registerTypes(registry: MetaDataRegistry) {
            registry.registerType(PickerLayout::class.java) { def ->
                def.type("layout").subType("picker").inheritsFrom("layout", "base")
                def.optionalAttributeWithConstraints("displayField").ofType("string").asSingle()
            }
            registry.extendType(StringField::class.java) { def ->
                def.optionalAttributeWithConstraints("searchable").ofType("boolean").asSingle()
                def.optionalAttributeWithConstraints("valueLabels").ofType("string").asArray()
            }
        }
    }

    private fun fixtures(): Path {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (p != null && !Files.exists(p.resolve("fixtures/conformance"))) p = p.parent
        assertTrue(p != null, "could not locate fixtures/conformance from user.dir")
        return p!!.resolve("fixtures/conformance")
    }

    private fun read(p: Path) = String(Files.readAllBytes(p), StandardCharsets.UTF_8)

    private val strict = { LoaderOptions.create(false, false, true) }

    @Test fun `success fixture loads with providers and matches the canonical output`() {
        val dir = fixtures().resolve("provider-custom-vocabulary-success")
        val loader = loadString(
            "examples", read(dir.resolve("input/meta.contacts.json")),
            opts = strict(), providers = listOf(ContactVocabulary()),
        )
        assertTrue(loader.errors.isEmpty(), "unexpected errors: ${loader.errors}")
        assertEquals(
            read(dir.resolve("expected.json")).trim(),
            CanonicalJsonSerializer.canonicalSerialize(loader.root).trim(),
        )
    }

    @Test fun `missing-provider fixture is refused with the expected codes in order`() {
        val dir = fixtures().resolve("provider-custom-vocabulary-missing-provider-fails")
        val loader = loadString("examples", read(dir.resolve("input/meta.contacts.json")), opts = strict())
        val got = loader.errors.map {
            it.code.get().name to (it.envelope.get() as JsonSource).jsonPath()
        }
        val base = "\$['metadata.root'].children[0]['object.value'].children"
        assertEquals(
            listOf(
                "ERR_UNKNOWN_SUBTYPE" to "$base[2]['layout.picker']",
                "ERR_UNKNOWN_ATTR" to "$base[0]['field.string']",
                "ERR_UNKNOWN_ATTR" to "$base[1]['field.string']",
            ),
            got,
        )
    }

    @Test fun `no providers leaves the default registry in place`() {
        val loader = loadString("x", """{ "metadata.root": { "package": "acme", "children": [] } }""")
        assertTrue(loader.typeRegistry.isSealed)
    }
}
