package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.identity.MetaIdentity
import com.metaobjects.identity.ReferenceIdentity
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.References
import com.metaobjects.loader.uri.URIHelper
import com.metaobjects.metadata.ktx.loadUris
import com.metaobjects.`object`.MetaObject
import com.metaobjects.relationship.M2MFields
import com.metaobjects.relationship.MetaRelationship
import com.metaobjects.relationship.RelationshipReferences
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Cross-port conformance (Kotlin) for ADR-0059 Decision 7: codegen binds the target a reference
 * names, never a same-short-named object in another package and never the package of the entity
 * that inherits the attribute. Loads `fixtures/codegen-conformance/cross-package-binding/input/`,
 * checks every entry of `expected-bindings.json`, then the generated Exposed tables, relations
 * and controllers.
 */
class KotlinCrossPackageBindingConformanceTest {

    private fun fixtureDir(): Path {
        val dir = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize()
            .resolve("fixtures/codegen-conformance/cross-package-binding")
        assertTrue(Files.isDirectory(dir), "fixture must exist at $dir")
        return dir
    }

    private fun load(): MetaDataLoader {
        val uris = Files.list(fixtureDir().resolve("input")).use { s ->
            s.filter { it.toString().endsWith(".json") }.sorted().toList()
        }.map { URIHelper.toURI("model:file:" + it.toAbsolutePath().toString().replace('\\', '/')) }
        assertEquals(4, uris.size)
        return loadUris("cross-package-binding", uris, LoaderOptions.create(false, false, true))
    }

    private fun expected(): JsonNode =
        ObjectMapper().readTree(Files.readString(fixtureDir().resolve("expected-bindings.json")))

    private fun objectOf(loader: MetaDataLoader, key: String): MetaObject =
        assertNotNull(loader.getMetaObjectByName(key), "object $key must load")

    private fun tableOf(o: MetaObject): String = o.findPrimaryWritableSource().orElseThrow().tableName

    private fun member(key: String): Pair<String, String> =
        key.substring(0, key.lastIndexOf('.')) to key.substring(key.lastIndexOf('.') + 1)

    @Test
    fun `every identity reference is bound to the expected object`() {
        val loader = load()
        val refs = expected().get("references")
        var checked = 0
        for (key in refs.fieldNames().asSequence().toList()) {
            val (owner, name) = member(key)
            val ref = objectOf(loader, owner).identities
                .filterIsInstance<ReferenceIdentity>().firstOrNull { it.shortName == name }
            assertNotNull(ref, "identity.reference $key")
            val bound = References.refTarget(ref, MetaIdentity.ATTR_REFERENCES)
            assertNotNull(bound, "unbound $key")
            assertEquals(refs.get(key).asText(), bound.name, "binding of $key")
            checked++
        }
        assertEquals(6, checked)
    }

    @Test
    fun `every relationship resolves to the expected target tables and join fields`() {
        val loader = load()
        val relations = expected().get("relations")
        var checked = 0
        for (key in relations.fieldNames().asSequence().toList()) {
            val want = relations.get(key)
            val (ownerKey, name) = member(key)
            val owner = objectOf(loader, ownerKey)
            val rel = owner.relationships.firstOrNull { it.shortName == name }
            assertNotNull(rel, "relationship $key")

            val target = References.refTarget(rel, MetaRelationship.ATTR_OBJECT_REF)
            assertNotNull(target, "unbound target of $key")
            assertEquals(want.get("target").asText(), target.name, "target of $key")
            assertEquals(want.get("targetTable").asText(), tableOf(target), "target table of $key")

            if (want.get("cardinality").asText() == "many") {
                val junction = References.refTarget(rel, MetaRelationship.ATTR_THROUGH)
                assertNotNull(junction, "unbound junction of $key")
                assertEquals(want.get("junction").asText(), junction.name, "junction of $key")
                assertEquals(want.get("junctionTable").asText(), tableOf(junction), "junction table of $key")
                val fields = M2MFields.derive(rel, owner, loader.root)
                assertEquals(want.get("sourceJoinField").asText(), fields.sourceField, "source join field of $key")
                assertEquals(want.get("targetJoinField").asText(), fields.targetField, "target join field of $key")

                val nav = KotlinM2mSupport.resolve(owner, loader).firstOrNull { it.relationName == name }
                assertNotNull(nav, "codegen M:N navigation for $key")
                assertEquals(want.get("sourceJoinField").asText(), nav.sourceField)
                assertEquals(want.get("targetJoinField").asText(), nav.targetField)
                assertEquals(PackageMapping.splitFqn(target.name).second + "Table", nav.targetTableObj)
                assertEquals(PackageMapping.splitFqn(target.name).first, nav.targetPackage)
                assertEquals(PackageMapping.splitFqn(junction.name).second + "Table", nav.junctionTableObj)
                assertEquals(target.getMetaField("id").name, nav.targetPkField)
            } else {
                val fk = RelationshipReferences.resolveRelationshipReference(
                    owner, rel.shortName, target, rel.sourceRefField)
                assertNotNull(fk, "fk reference of $key")
                assertEquals(want.get("fkField").asText(), fk.fields[0], "fk field of $key")
            }
            checked++
        }
        assertEquals(4, checked)
    }

    @Test
    fun `inherited root references bind the root object not the inheriting packages`() {
        val loader = load()
        val order = objectOf(loader, "acme::Order")
        val customer = loader.getMetaObjectByName("Customer")
        val label = loader.getMetaObjectByName("Label")
        val customerRel = order.relationships.first { it.shortName == "customer" }
        val labelsRel = order.relationships.first { it.shortName == "labels" }
        assertSame(customer, References.refTarget(customerRel, MetaRelationship.ATTR_OBJECT_REF))
        assertSame(label, References.refTarget(labelsRel, MetaRelationship.ATTR_OBJECT_REF))
        assertSame(customer, References.lookupCanonical(loader.root,
            customerRel.getMetaAttr(MetaRelationship.ATTR_OBJECT_REF).valueAsString))
    }

    private fun generateAll(loader: MetaDataLoader, out: Path, withControllers: Boolean): Map<String, String> {
        val args = mapOf("outputDir" to out.toString())
        KotlinEntityGenerator().apply { setArgs(args) }.execute(loader)
        KotlinExposedTableGenerator().apply { setArgs(args) }.execute(loader)
        KotlinRelationsGenerator().apply { setArgs(args) }.execute(loader)
        if (withControllers) KotlinSpringControllerGenerator().apply { setArgs(args) }.execute(loader)
        return Files.walk(out).use { s ->
            s.filter { it.toString().endsWith(".kt") }.toList()
        }.associate { out.relativize(it).toString().replace('\\', '/') to Files.readString(it) }
    }

    @Test
    fun `generated tables relations and controllers use the bound targets`() {
        val out = Files.createTempDirectory("kcross-")
        try {
            val files = generateAll(load(), out, withControllers = true)
            fun file(path: String) = assertNotNull(files[path], "expected $path; saw ${files.keys.sorted()}")

            val postTable = file("a/PostTable.kt")
            assertTrue("import b.TagTable" in postTable, "Post.featuredTag must bind b::Tag; saw:\n$postTable")
            assertTrue("references(TagTable.id" in postTable, "saw:\n$postTable")
            val postRelations = file("a/PostRelations.kt")
            assertTrue("import b.TagTable" in postRelations, "saw:\n$postRelations")
            assertTrue("TagTable.join(PostTagTable, JoinType.INNER) { TagTable.id eq PostTagTable.tagId }" in postRelations,
                "saw:\n$postRelations")
            val postController = file("a/PostController.kt")
            assertTrue("import b.TagTable" in postController, "saw:\n$postController")
            assertTrue("ResponseEntity<List<b.Tag>>" in postController, "saw:\n$postController")

            val orderTable = file("acme/OrderTable.kt")
            assertTrue("\nimport CustomerTable\n" in orderTable,
                "Order.customer must bind the root Customer, not acme::Customer; saw:\n$orderTable")
            assertTrue("references(CustomerTable.id" in orderTable, "saw:\n$orderTable")
            val orderRelations = file("acme/OrderRelations.kt")
            assertTrue("\nimport LabelTable\n" in orderRelations, "saw:\n$orderRelations")
            assertTrue("\nimport OrderLabelTable\n" in orderRelations, "saw:\n$orderRelations")
            assertTrue("LabelTable.join(OrderLabelTable, JoinType.INNER) { LabelTable.id eq OrderLabelTable.labelId }" in orderRelations,
                "saw:\n$orderRelations")
            val orderController = file("acme/OrderController.kt")
            assertTrue("\nimport LabelTable\n" in orderController, "saw:\n$orderController")
            assertTrue("\nimport Label\n" in orderController, "saw:\n$orderController")

            for ((path, src) in files) {
                if (!path.startsWith("a/Post") && !path.startsWith("acme/Order")) continue
                for (wrong in listOf("a_tags", "acme_labels", "acme_customers", "a.TagTable", "acme.LabelTable", "acme.CustomerTable")) {
                    assertFalse(wrong in src, "$path must not mention $wrong")
                }
            }
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
    @Test
    fun `generated entities tables and relations compile against exposed`() {
        val out = Files.createTempDirectory("kcross-compile-")
        try {
            generateAll(load(), out, withControllers = false)
            val sources = Files.walk(out).use { s -> s.filter { Files.isRegularFile(it) }.sorted().toList() }
                .map { SourceFile.kotlin(out.relativize(it).toString().replace('/', '_'), Files.readString(it)) }
            val exposed = Path.of(System.getProperty("user.home"), ".m2", "repository",
                "org/jetbrains/exposed/exposed-core/0.55.0/exposed-core-0.55.0.jar")
            assertTrue(Files.exists(exposed), "expected jar on local m2: $exposed")
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                classpaths = listOf(exposed.toFile())
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated cross-package tree failed to compile:\n${result.messages}")
        } finally {
            out.toFile().deleteRecursively()
        }
    }
}
