package com.metaobjects.generator.kotlin

import com.metaobjects.loader.InMemoryStringSource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * ADR-0059 R7 — [KotlinGenUtil.resolveObjectRef] and [KotlinGenUtil.resolveValueObjectRef] resolve a
 * CANONICAL value exactly: `pkg::Name` binds that package's object, `::Name` and a bare `Name` bind
 * the root-level one, and the referrer package is never applied. Three value objects share the short
 * name `Report`, so a short-name scan or a package-local resolve would bind a packaged copy instead.
 */
class KotlinGenUtilCanonicalRefTest {

    private fun doc(pkg: String?, field: String): String {
        val pkgPart = if (pkg == null) "" else "\"package\": \"$pkg\", "
        return "{ \"metadata.root\": { $pkgPart\"children\": [" +
            "{ \"object.value\": { \"name\": \"Report\", \"children\": [" +
            "{ \"field.string\": { \"name\": \"$field\" } } ] } } ] } }"
    }

    private fun load(vararg docs: String): MetaDataLoader {
        val loader = MetaDataLoader(LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "kotlin-canonical")
        loader.init()
        loader.load(docs.mapIndexed { i, d -> InMemoryStringSource(d, "kotlin-canonical/meta.$i.json") })
        return loader
    }

    private fun fieldOf(obj: MetaObject?): String? = obj?.metaFields?.first()?.name

    @Test
    fun canonicalValuesResolveExactly() {
        val loader = load(doc("acme::alpha", "alphaVal"), doc("acme::beta", "betaVal"), doc(null, "rootVal"))

        assertEquals("alphaVal", fieldOf(KotlinGenUtil.resolveObjectRef(loader, "acme::alpha::Report", "")))
        assertEquals("betaVal", fieldOf(KotlinGenUtil.resolveValueObjectRef(loader, "acme::beta::Report", "acme::alpha")))
        assertEquals("rootVal", fieldOf(KotlinGenUtil.resolveValueObjectRef(loader, "::Report", "acme::alpha")))
        assertEquals("rootVal", fieldOf(KotlinGenUtil.resolveObjectRef(loader, "Report", "acme::alpha")))
        assertNull(KotlinGenUtil.resolveObjectRef(loader, "acme::gamma::Report", ""))
    }

    @Test
    fun bareValueDoesNotBindAPackagedObject() {
        val loader = load(doc("acme::alpha", "alphaVal"))

        assertNull(KotlinGenUtil.resolveObjectRef(loader, "Report", "acme::alpha"))
        assertEquals("alphaVal", fieldOf(KotlinGenUtil.resolveObjectRef(loader, "acme::alpha::Report", "")))
    }
}
