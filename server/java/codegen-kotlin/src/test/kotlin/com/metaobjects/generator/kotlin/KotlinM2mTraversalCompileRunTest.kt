package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.generator.kotlin.runtime.M2mJoinResolver
import com.metaobjects.generator.kotlin.runtime.M2mJoinResolver.JunctionRow
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * FR-018 Unit 13 — generate→compile→run proof for the Kotlin M:N traversal seam.
 * Parallels the Java codegen-spring `GeneratedM2mTraversalCompileRunTest`.
 *
 * <p>codegen-kotlin's own test classpath carries no Exposed runtime, JDBC driver,
 * or Spring (the generated controller's HTTP lane + the Exposed query lane are
 * exercised in the cross-module `integration-tests-kotlin` api-contract wiring — a
 * separate unit). So, exactly like the Java pilot, the substantive traversal artifact
 * proven here is the substrate-agnostic runtime {@link M2mJoinResolver} driving the
 * three resolution modes against the shared m2m seed, with the related target keys
 * materialized into the GENERATED, COMPILED target data class (`Tag` / `Person`).</p>
 *
 * <ol>
 *   <li>load the shared {@code fixtures/api-contract-conformance/m2m/} model;</li>
 *   <li>run {@link KotlinEntityGenerator} (the {@code @Serializable data class}
 *       target types) and COMPILE the emitted Kotlin with kotlin-compile-testing;</li>
 *   <li>seed from {@code seed.json}, traverse each junction via the runtime
 *       {@link M2mJoinResolver} (hetero / directed self-join / symmetric union-on-read,
 *       junction FK direction derived once at codegen time), then construct the
 *       compiled target data class from the related rows via reflection;</li>
 *   <li>assert the related-row {@code name} multiset matches the api-contract
 *       scenarios (order-insensitive) for all three modes.</li>
 * </ol>
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinM2mTraversalCompileRunTest {

    private val mapper = ObjectMapper()

    /** Walk up from cwd to the shared api-contract m2m corpus. */
    private fun findM2mCorpus(): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve("fixtures/api-contract-conformance/m2m")
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException("Could not locate fixtures/api-contract-conformance/m2m")
    }

    @Suppress("UNCHECKED_CAST")
    private fun rows(seed: Map<String, Any?>, table: String): List<Map<String, Any?>> =
        (seed[table] as? List<Map<String, Any?>>) ?: emptyList()

    private fun asLong(o: Any?): Long? = (o as? Number)?.toLong()

    @Suppress("UNCHECKED_CAST")
    @Test fun `runtime resolver + generated target type traverse all three modes`() {
        val corpus = findM2mCorpus()
        val outDir = Files.createTempDirectory("km2m-cr-")
        try {
            val loader = loadString("m2m-cr", Files.readString(corpus.resolve("meta.json")))

            // 1. Generate the @Serializable data-class target types and compile them.
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            assertTrue(emitted.isNotEmpty(), "expected generated entity sources")

            val sources = emitted.map { path ->
                SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText())
            }
            val compileResult = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, compileResult.exitCode,
                "generated m2m entity types failed to compile:\n${compileResult.messages}")

            val cl = compileResult.classLoader
            val tagClass = cl.loadClass("acme.social.Tag")
            val personClass = cl.loadClass("acme.social.Person")

            // 1b. Compile the GENERATED Exposed artifacts (the <Entity>Table objects + the
            //     <Source>Relations.kt M:N junction-join query helpers) against exposed-core,
            //     proving the emitted Exposed DSL (join + selectAll + where, derived FK columns)
            //     is valid Kotlin. exposed-core is not on codegen-kotlin's own test classpath,
            //     so it is supplied explicitly here (the controller's Spring lane stays in the
            //     cross-module api-contract wiring).
            compileExposedArtifacts(loader)

            // 2. Load the seed rows.
            val seed = mapper.readValue(Files.readString(corpus.resolve("seed.json")), Map::class.java)
                as Map<String, Any?>

            val tagsById = rows(seed, "tags").associate { asLong(it["id"]) to (it["name"] as String) }
            val peopleById = rows(seed, "people").associate { asLong(it["id"]) to (it["name"] as String) }

            val postTags = rows(seed, "post_tags").map { JunctionRow(asLong(it["postId"]), asLong(it["tagId"])) }
            val follows = rows(seed, "follows").map { JunctionRow(asLong(it["followerId"]), asLong(it["followeeId"])) }
            val friendships = rows(seed, "friendships").map { JunctionRow(asLong(it["personAId"]), asLong(it["personBId"])) }

            // --- hetero: Post.tags via PostTag (postId -> tagId) ---
            // post_tags = (1,10),(1,20),(2,30); tags 10=red,20=green,30=blue.
            assertEquals(setOf("green", "red"),
                heteroTagNames(postTags, 1L, tagsById, tagClass))
            assertEquals(setOf("blue"),
                heteroTagNames(postTags, 2L, tagsById, tagClass))
            assertEquals(emptySet(),
                heteroTagNames(postTags, 3L, tagsById, tagClass))

            // --- directed self-join: Person.following via Follow (followerId source) ---
            // follows = (1,2),(1,3),(2,1); people 1=Alice,2=Bob,3=Carol,4=Dave.
            assertEquals(setOf("Bob", "Carol"),
                directedPersonNames(follows, 1L, peopleById, personClass))
            assertEquals(setOf("Alice"),
                directedPersonNames(follows, 2L, peopleById, personClass))
            assertEquals(emptySet(),
                directedPersonNames(follows, 3L, peopleById, personClass))

            // --- symmetric self-join: Person.friends via Friendship (union on read) ---
            // friendships = (1,2),(3,1),(2,4).
            assertEquals(setOf("Bob", "Carol"),
                symmetricPersonNames(friendships, 1L, peopleById, personClass))
            assertEquals(setOf("Alice", "Dave"),
                symmetricPersonNames(friendships, 2L, peopleById, personClass))
            assertEquals(setOf("Bob"),
                symmetricPersonNames(friendships, 4L, peopleById, personClass))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Generate the [KotlinExposedTableGenerator] tables + [KotlinRelationsGenerator]
     * M:N junction-join query helpers and COMPILE them against exposed-core, asserting
     * the emitted Exposed DSL is valid Kotlin. The exposed-core jar is resolved from the
     * local Maven repository (it is not on codegen-kotlin's own test classpath).
     */
    private fun compileExposedArtifacts(loader: com.metaobjects.loader.MetaDataLoader) {
        val exposedDir = Files.createTempDirectory("km2m-exposed-")
        try {
            KotlinExposedTableGenerator().apply { setArgs(mapOf("outputDir" to exposedDir.toString())) }.execute(loader)
            KotlinRelationsGenerator().apply { setArgs(mapOf("outputDir" to exposedDir.toString())) }.execute(loader)

            val relationsFiles = Files.walk(exposedDir).filter { it.isRegularFile() }
                .filter { it.fileName.toString().endsWith("Relations.kt") }.sorted().toList()
            assertTrue(relationsFiles.any { it.fileName.toString() == "PostRelations.kt" },
                "expected a generated PostRelations.kt M:N helper; saw $relationsFiles")
            assertTrue(relationsFiles.any { it.fileName.toString() == "PersonRelations.kt" },
                "expected a generated PersonRelations.kt M:N helper; saw $relationsFiles")

            val sources = Files.walk(exposedDir).filter { it.isRegularFile() }.sorted().toList()
                .map { SourceFile.kotlin(it.parent.relativize(it).toString().replace('/', '_'), it.readText()) }

            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                classpaths = exposedClasspath()
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated Exposed tables + M:N relation helpers failed to compile:\n${result.messages}")
        } finally {
            exposedDir.toFile().deleteRecursively()
        }
    }

    /** Resolve the exposed-core jar (+ its kotlinx coroutines/slf4j transitive needs) from ~/.m2. */
    private fun exposedClasspath(): List<java.io.File> {
        val m2 = Paths.get(System.getProperty("user.home"), ".m2", "repository")
        val jars = mutableListOf<java.io.File>()
        fun add(rel: String) {
            val p = m2.resolve(rel)
            assertTrue(Files.exists(p), "expected jar on local m2: $p (run a build that resolves exposed first)")
            jars.add(p.toFile())
        }
        add("org/jetbrains/exposed/exposed-core/0.55.0/exposed-core-0.55.0.jar")
        return jars
    }

    /** hetero: junction filtered to sourceField (postId) = id; related = targetField (tagId). */
    private fun heteroTagNames(
        junction: List<JunctionRow>, id: Long, tagsById: Map<Long?, String>, tagClass: Class<*>,
    ): Set<String> {
        val matched = junction.filter { M2mJoinResolver.keyEquals(it.sourceKey, id) }
        val relatedIds = M2mJoinResolver.relatedKeys(id, matched, false)
        return relatedIds.map { rid ->
            // Build the COMPILED target data class from the related row, read its `name`.
            val name = tagsById[asLong(rid)]
            val tag = construct(tagClass, asLong(rid), name)
            tagClass.getMethod("getName").invoke(tag) as String
        }.toSet()
    }

    /** directed self-join: junction filtered to source FK (followerId) = id; related = target FK. */
    private fun directedPersonNames(
        junction: List<JunctionRow>, id: Long, peopleById: Map<Long?, String>, personClass: Class<*>,
    ): Set<String> {
        val matched = junction.filter { M2mJoinResolver.keyEquals(it.sourceKey, id) }
        return personNames(M2mJoinResolver.relatedKeys(id, matched, false), peopleById, personClass)
    }

    /** symmetric self-join: junction touched on either FK; related = the non-source column. */
    private fun symmetricPersonNames(
        junction: List<JunctionRow>, id: Long, peopleById: Map<Long?, String>, personClass: Class<*>,
    ): Set<String> {
        val matched = junction.filter {
            M2mJoinResolver.keyEquals(it.sourceKey, id) || M2mJoinResolver.keyEquals(it.targetKey, id)
        }
        return personNames(M2mJoinResolver.relatedKeys(id, matched, true), peopleById, personClass)
    }

    private fun personNames(
        relatedIds: List<Any?>, peopleById: Map<Long?, String>, personClass: Class<*>,
    ): Set<String> = relatedIds.map { rid ->
        val person = construct(personClass, asLong(rid), peopleById[asLong(rid)])
        personClass.getMethod("getName").invoke(person) as String
    }.toSet()

    /** Construct a generated `data class <T>(id: Long?, name: String, ...)` reflectively. */
    private fun construct(clazz: Class<*>, id: Long?, name: String?): Any {
        // Both Tag and Person have the (id: Long?, name: String) leading shape; pick the
        // constructor whose first two params are (Long, String) and pass defaults for the rest.
        val ctor = clazz.declaredConstructors
            .firstOrNull { c ->
                c.parameterTypes.size >= 2 &&
                    c.parameterTypes[0] == java.lang.Long::class.java &&
                    c.parameterTypes[1] == String::class.java
            } ?: error("no (Long, String, ...) constructor on ${clazz.name}")
        // Kotlin compiles a primary ctor whose all-args form is callable directly when the
        // remaining params are nullable (default null). Find that all-args ctor or the 2-arg.
        val args = arrayOfNulls<Any?>(ctor.parameterTypes.size)
        args[0] = id
        args[1] = name
        ctor.isAccessible = true
        return ctor.newInstance(*args)
    }
}
