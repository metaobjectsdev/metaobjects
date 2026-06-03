package com.metaobjects.generator.kotlin

import com.metaobjects.registry.RegistryManifest
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * SP-G Registry Conformance — the Kotlin runner.
 *
 * Kotlin runs on the JVM and REUSES the shared Java [RegistryManifest] emitter (the same
 * class the Java runner validates). This test composes a registry from the DEFINED metamodel
 * provider set ([RegistryManifest.composeMetamodelRegistry]) and asserts the emitted manifest
 * is byte-identical to the single committed canonical
 * `fixtures/registry-conformance/expected-registry.json` — proving the metamodel vocabulary
 * matches the cross-port contract from the Kotlin module too.
 *
 * It composes from the metamodel provider set rather than the process-global
 * `MetaDataRegistry.getInstance()` ON PURPOSE: this module's test classpath also carries the
 * `om` + `codegen-base` SPI providers, which register an extra `object.managed` subtype and
 * ~22 codegen-tooling attrs (`ai*`/`json*`/`has*`, self-registered by the doc generators).
 * Those are per-port codegen tooling, not the cross-port logical metamodel vocabulary this
 * gate measures. Composing from the defined provider set makes this runner measure exactly
 * what the metadata-module runner does — immune to classpath pollution while still catching
 * real metamodel-vocabulary drift. See `fixtures/registry-conformance/README.md`.
 *
 * Byte-identity to the Java runner holds by construction (same provider set, same emitter);
 * the value here is the gate existing in the Kotlin module's test surface as well.
 *
 * Like the Java runner, this is a drift-finding gate: any mismatch is a real divergence
 * between the JVM metamodel registry's logical vocabulary and the cross-port canonical. Fix
 * the Java registration to match the canonical (TS is the reference) — do NOT loosen the
 * canonical. Escalate if TS itself is wrong versus the documented vocabulary.
 */
class RegistryManifestConformanceTest {

    @Test
    fun manifestMatchesCanonical() {
        // Compose from the DEFINED metamodel provider set (RegistryManifest.
        // composeMetamodelRegistry) rather than the process-global
        // MetaDataRegistry.getInstance(): this module's test classpath ALSO
        // carries the `om` + `codegen-base` SPI providers, which register an
        // extra `object.managed` subtype and ~22 codegen-tooling attrs
        // (`ai*`/`json*`/`has*`, self-registered by the doc generators). Those
        // are per-port codegen tooling, NOT the cross-port logical metamodel
        // vocabulary this gate measures. Composing from the metamodel provider
        // set makes the Kotlin runner measure exactly what the metadata-module
        // runner does — byte-identical to the canonical, and still catching real
        // metamodel-vocabulary drift.
        val registry = RegistryManifest.composeMetamodelRegistry()
        val got = RegistryManifest.emit(registry).replace("\r\n", "\n")
        val want = readCanonical().replace("\r\n", "\n")

        assertEquals(
            want,
            got,
            "SP-G registry-conformance gate FAILED (Kotlin/JVM view): the shared JVM metamodel " +
                "registry diverges from the cross-port canonical " +
                "(fixtures/registry-conformance/expected-registry.json). Fix the Java " +
                "registration to match the cross-port contract, or escalate if TS is wrong.",
        )
    }

    private fun readCanonical(): String {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (p != null && !Files.exists(p.resolve("fixtures/registry-conformance/expected-registry.json"))) {
            p = p.parent
        }
        assertTrue(
            p != null,
            "could not locate fixtures/registry-conformance/expected-registry.json from user.dir",
        )
        return String(
            Files.readAllBytes(p!!.resolve("fixtures/registry-conformance/expected-registry.json")),
            StandardCharsets.UTF_8,
        )
    }
}
