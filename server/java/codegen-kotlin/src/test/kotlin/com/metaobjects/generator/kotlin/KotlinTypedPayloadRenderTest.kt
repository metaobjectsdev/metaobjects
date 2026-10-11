package com.metaobjects.generator.kotlin

import com.metaobjects.render.InMemoryProvider
import com.metaobjects.render.RenderRequest
import com.metaobjects.render.Renderer
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.assertEquals

/**
 * A Kotlin data class payload — the shape a generated value object takes — goes through the JVM
 * renderer and must render byte-identically to the equal map payload: `-last` and `has<Field>`
 * come from one mechanism whatever the payload's shape. The oracle is the shared
 * render-list-separator fixture, whose expected.txt every port renders identically.
 */
class KotlinTypedPayloadRenderTest {

    data class Item(val name: String)
    data class Tag(val label: String)
    data class Group(val tags: List<Tag>)
    data class Owner(val nick: String)
    data class Entry(val name: String, val note: String?, val owner: Owner)
    data class ListSeparator(
        val items: List<Item>,
        val solo: List<Item>,
        val none: List<Item>,
        val groups: List<Group>,
        val entries: List<Entry>,
        val authored: List<Map<String, Any>>,
    )

    private val fixture: Path = Path.of(System.getProperty("user.dir"))
        .resolve("../../..").normalize()
        .resolve("fixtures/render-conformance/render-list-separator")

    private fun render(template: String, payload: Any): String =
        Renderer().render(RenderRequest(template, null, payload, InMemoryProvider(emptyMap()), "text", null, null))

    @Test
    fun `a data class payload renders the shared fixture byte-identically`() {
        val payload = ListSeparator(
            items = listOf(Item("a"), Item("b"), Item("c")),
            solo = listOf(Item("only")),
            none = emptyList(),
            groups = listOf(Group(listOf(Tag("x"), Tag("y"))), Group(listOf(Tag("z")))),
            entries = listOf(
                Entry("a", "x", Owner("ann")),
                Entry("b", null, Owner("bob")),
                Entry("c", "z", Owner("cy")),
            ),
            authored = listOf(mapOf("name" to "p", "-last" to true), mapOf("name" to "q", "-last" to true)),
        )
        assertEquals(
            Files.readString(fixture.resolve("expected.txt")),
            render(Files.readString(fixture.resolve("template.mustache")), payload),
        )
    }

    @Test
    fun `has gate on a data class element matches the equal map payload`() {
        val template = "{{#items}}{{name}}:{{#hasNote}}y{{/hasNote}}{{^hasNote}}n{{/hasNote}} {{/items}}"
        val viaMaps = mapOf("items" to listOf(mapOf("name" to "a", "note" to "x"), mapOf("name" to "b", "note" to " ")))
        val viaData = mapOf("items" to listOf(Entry("a", "x", Owner("o")), Entry("b", " ", Owner("o"))))
        assertEquals("a:y b:n ", render(template, viaMaps))
        assertEquals(render(template, viaMaps), render(template, viaData))
    }
}
