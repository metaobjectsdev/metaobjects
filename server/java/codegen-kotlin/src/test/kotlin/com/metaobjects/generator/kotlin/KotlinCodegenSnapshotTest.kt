package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.absolutePathString
import kotlin.io.path.isDirectory
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.fail

/**
 * Parameterized snapshot test — for each fixture under src/test/resources/fixtures/,
 * runs the configured generators and compares each emitted .kt against the snapshot
 * at src/test/resources/snapshots/<fixture-name>/<filename>.
 *
 * <p>First run creates snapshots and fails with "review + commit". Subsequent runs gate.
 */
class KotlinCodegenSnapshotTest {

    private val fixturesRoot: Path = Paths.get("src/test/resources/fixtures").toAbsolutePath()
    private val snapshotsRoot: Path = Paths.get("src/test/resources/snapshots").toAbsolutePath()

    @TestFactory
    fun snapshotTests(): List<DynamicTest> {
        if (!fixturesRoot.isDirectory()) return emptyList()
        return Files.list(fixturesRoot).filter { it.isDirectory() }
            .sorted()
            .map { fixtureDir ->
                DynamicTest.dynamicTest("snapshot:${fixtureDir.fileName}") {
                    runOne(fixtureDir)
                }
            }
            .toList()
    }

    private fun runOne(fixtureDir: Path) {
        val name = fixtureDir.fileName.toString()
        val metaText = fixtureDir.resolve("meta.json").readText()
        val configText = fixtureDir.resolve("config.json").readText()
        val config = parseConfig(configText)

        val outDir = Files.createTempDirectory("snap-$name-")
        try {
            val loader = loadString(name, metaText)
            for (g in config.generators) {
                val gen = when (g) {
                    "entity"     -> KotlinEntityGenerator()
                    "table"      -> KotlinExposedTableGenerator()
                    "payload"    -> KotlinPayloadGenerator()
                    "validator"  -> KotlinValidatorGenerator()
                    "relations"  -> KotlinRelationsGenerator()
                    "storedproc" -> KotlinStoredProcGenerator()
                    "controller" -> KotlinSpringControllerGenerator()
                    "repository" -> KotlinRepositoryGenerator()
                    "filter-allowlist" -> KotlinFilterAllowlistGenerator()
                    "output-parser" -> KotlinOutputParserGenerator()
                    "output-prompt" -> KotlinOutputPromptGenerator()
                    "names" -> KotlinNamesGenerator()
                    else -> fail("unknown generator name in config: $g")
                }
                val args = mutableMapOf("outputDir" to outDir.toString())
                if (g == "validator") {
                    args["packageName"] = config.validatorPackage
                        ?: fail("validator config needs validatorPackage")
                }
                gen.setArgs(args)
                gen.execute(loader)
            }

            val snapshotDir = snapshotsRoot.resolve(name)
            val emittedFiles = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()

            if (!snapshotDir.isDirectory() || Files.walk(snapshotDir).filter { it.isRegularFile() }.count() == 0L) {
                // First run: create snapshots
                Files.createDirectories(snapshotDir)
                for (f in emittedFiles) {
                    val rel = outDir.relativize(f)
                    val target = snapshotDir.resolve(rel.toString())
                    Files.createDirectories(target.parent)
                    Files.copy(f, target)
                }
                fail("snapshots created for '$name' at ${snapshotDir.absolutePathString()} — review + commit. Re-run to gate.")
            }

            // Subsequent runs: compare each emitted file to its snapshot
            for (f in emittedFiles) {
                val rel = outDir.relativize(f)
                val snap = snapshotDir.resolve(rel.toString())
                if (!snap.isRegularFile()) {
                    fail("emitted file has no snapshot: $rel (write snapshot to $snap and re-run)")
                }
                val actual = f.readText()
                val expected = snap.readText()
                if (actual != expected) {
                    fail("snapshot drift in $name/$rel\nEXPECTED:\n$expected\nACTUAL:\n$actual")
                }
            }
            // Also verify no snapshot file is missing from emission
            val snapFiles = Files.walk(snapshotDir).filter { it.isRegularFile() }.toList()
            val emittedRels = emittedFiles.map { outDir.relativize(it).toString() }.toSet()
            for (s in snapFiles) {
                val rel = snapshotDir.relativize(s).toString()
                if (rel !in emittedRels) {
                    fail("snapshot has no emitted counterpart: $rel (stale snapshot? delete or fix generator)")
                }
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    private data class FixtureConfig(val generators: List<String>, val validatorPackage: String?)

    private fun parseConfig(json: String): FixtureConfig {
        // Crude JSON parse — fixtures are tiny + controlled. No Jackson dep added for this.
        val gens = Regex("\"generators\"\\s*:\\s*\\[([^\\]]+)]").find(json)?.groupValues?.get(1)
            ?.split(",")?.map { it.trim().trim('"') } ?: emptyList()
        val pkg = Regex("\"validatorPackage\"\\s*:\\s*\"([^\"]+)\"").find(json)?.groupValues?.get(1)
        return FixtureConfig(gens, pkg)
    }
}
