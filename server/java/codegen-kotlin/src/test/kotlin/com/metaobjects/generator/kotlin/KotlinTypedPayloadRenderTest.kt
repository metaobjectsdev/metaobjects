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

    // ---- The overlay adds names; it never takes any away -----------------------------------

    class Money(val cents: Long, val currency: String) {
        override fun toString(): String = "$currency ${cents}c"
    }

    data class Line(val sku: String, val price: Money) {
        fun label(): String = "label:$sku"
        val exploding: String get() = throw IllegalStateException("read a member the template never names")
    }

    data class Order(val id: String, val total: Money, val lines: List<Line>) {
        fun summary(): String = "order $id"
    }

    private val order = Order("o-1", Money(1250, "USD"), listOf(Line("a", Money(500, "USD")), Line("b", Money(750, "USD"))))

    /** The engine with no MetaObjects view at all: what a typed payload rendered before. */
    private fun renderWithBareEngine(template: String, payload: Any): String {
        val out = java.io.StringWriter()
        com.github.mustachejava.DefaultMustacheFactory()
            .compile(java.io.StringReader(template), "bare").execute(out, payload).flush()
        return out.toString()
    }

    @Test
    fun `a function member and a value's own string form still render`() {
        assertEquals(
            "order o-1 USD 1250c|a=label:a USD 500c;b=label:b USD 750c;",
            render("{{summary}} {{total}}|{{#lines}}{{sku}}={{label}} {{price}};{{/lines}}", order),
        )
    }

    class Scoreboard(val scores: IntArray, val weights: DoubleArray)

    /**
     * The oracle is the Mustache spec: a section over a list renders its body once per element
     * and an inverted section renders for an empty list. `IntArray` and `DoubleArray` are JVM
     * primitive arrays, which the engine iterates itself.
     */
    @Test
    fun `a primitive array property is iterated per element`() {
        assertEquals(
            "1,2,3,|0.5;",
            render("{{#scores}}{{.}},{{/scores}}|{{#weights}}{{.}};{{/weights}}", Scoreboard(intArrayOf(1, 2, 3), doubleArrayOf(0.5))),
        )
        assertEquals(
            "none",
            render("{{^scores}}none{{/scores}}{{#weights}}{{.}}{{/weights}}", Scoreboard(intArrayOf(), doubleArrayOf())),
        )
    }

    @Test
    fun `a property the template never names is never read`() {
        assertEquals("a,b", render("{{#lines}}{{sku}}{{^-last}},{{/-last}}{{/lines}}", order))
    }

    @Test
    fun `a template without derived names renders exactly as the bare engine does`() {
        val template = "{{id}} {{summary}} {{total}} {{total.cents}}" +
            "{{#lines}} [{{sku}} {{label}} {{price}} {{price.currency}} {{id}}]{{/lines}}" +
            "{{#total}} {{currency}}{{/total}}{{^missing}} none{{/missing}}"
        val expected = renderWithBareEngine(template, order)
        assertEquals(
            "o-1 order o-1 USD 1250c 1250 [a label:a USD 500c USD o-1] [b label:b USD 750c USD o-1] USD none",
            expected,
        )
        assertEquals(expected, render(template, order))
    }
}
