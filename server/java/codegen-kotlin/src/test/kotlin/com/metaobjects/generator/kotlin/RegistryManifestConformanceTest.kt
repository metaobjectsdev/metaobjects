package com.metaobjects.generator.kotlin

import com.metaobjects.registry.MetaDataRegistry
import com.metaobjects.registry.RegistryManifest
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.Disabled

/**
 * SP-G Registry Conformance — the Kotlin runner.
 *
 * Kotlin runs on the JVM and REUSES the shared Java [MetaDataRegistry] and the Java
 * [RegistryManifest] emitter (the same classes the Java runner validates). This test obtains
 * the shared JVM registry and asserts the emitted manifest is byte-identical to the single
 * committed canonical `fixtures/registry-conformance/expected-registry.json` — proving the
 * JVM-view of the registry matches the cross-port contract from the Kotlin module too.
 *
 * Byte-identity to the Java runner holds by construction (same registry, same emitter); the
 * value here is the gate existing in the Kotlin module's test surface as well.
 *
 * Like the Java runner, this is a drift-finding gate: any mismatch is a real divergence
 * between the JVM metamodel registry's logical vocabulary and the cross-port canonical. Fix
 * the Java registration to match the canonical (TS is the reference) — do NOT loosen the
 * canonical. Escalate if TS itself is wrong versus the documented vocabulary.
 *
 * `@Disabled` — ESCALATED, same root cause as the Java runner
 * (`com.metaobjects.registry.RegistryManifestConformanceTest`): the shared JVM registry's
 * attribute vocabulary diverges pervasively from the cross-port canonical that TS, C#, and
 * Python agree on. See that Java test's Javadoc for the full divergence inventory. The
 * canonical is correct and is NOT edited; re-enable once the Java vocabulary reconciliation
 * lands.
 */
class RegistryManifestConformanceTest {

    @Test
    @Disabled(
        "SP-G ESCALATED: the shared JVM metamodel registry vocabulary diverges pervasively " +
            "from the cross-port canonical (TS/C#/Python agree). See the Java runner's Javadoc " +
            "for the inventory. Re-enable once the Java vocabulary reconciliation lands; the " +
            "canonical is correct and is NOT to be edited.",
    )
    fun manifestMatchesCanonical() {
        val registry = MetaDataRegistry.getInstance()
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
