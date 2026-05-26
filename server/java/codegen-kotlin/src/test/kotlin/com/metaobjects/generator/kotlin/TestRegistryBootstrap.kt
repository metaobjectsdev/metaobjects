package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString

/**
 * Forces the MetaDataRegistry to complete its SPI provider chain before any test
 * instantiates a MetaField subclass directly.
 *
 * <p>Without this, a test that does `StringField("name")` triggers `MetaField.<clinit>`,
 * which triggers `MetaData.<clinit>`, which calls `MetaDataRegistry.getInstance()` —
 * the registry then loads service providers, but `FieldTypesMetaDataProvider`'s registration
 * of `StringField.class` itself triggers nested class loading on a class that is already
 * mid-load, leaving the registry partially populated (only `field.base` registered, no
 * `field.string`/`field.long`/etc). Subsequent `loadString` calls fail with
 * `No type registered for: field.long`.
 *
 * <p>Calling `loadString` with a trivial doc here primes the loader pipeline cleanly, so by
 * the time direct `StringField("name")` runs it sees an already-fully-initialized registry.
 */
internal object TestRegistryBootstrap {
    @Volatile private var done = false

    fun ensureInitialized() {
        if (done) return
        synchronized(this) {
            if (done) return
            loadString("bootstrap",
                "{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}")
            done = true
        }
    }
}
