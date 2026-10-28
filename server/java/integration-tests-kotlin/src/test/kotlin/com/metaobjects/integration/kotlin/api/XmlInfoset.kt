package com.metaobjects.integration.kotlin.api

import java.io.StringReader
import javax.xml.stream.XMLInputFactory
import javax.xml.stream.XMLStreamConstants

/**
 * Compares two XML documents as an infoset: element names, attributes (namespace declarations
 * included), text and order. The declaration and the whitespace between elements are ignored;
 * whitespace inside a text-only element is data. Read with StAX into a small tree.
 */
object XmlInfoset {

    private class Node(val name: String, val attributes: Map<String, String>) {
        /** Child elements and text runs, in order. */
        val children = mutableListOf<Any>()
    }

    /** `null` when the two are the same infoset, else a one-line description of the first difference. */
    fun difference(expected: String, actual: String?): String? {
        if (actual == null) return "no body"
        val want: Node
        val got: Node
        try {
            want = parse(expected)
            got = parse(actual)
        } catch (e: Exception) {
            return "not well-formed XML: ${e.message}"
        }
        return compare(want, got, "/" + want.name)
    }

    private fun parse(xml: String): Node {
        val factory = XMLInputFactory.newFactory()
        factory.setProperty(XMLInputFactory.SUPPORT_DTD, false)
        factory.setProperty(XMLInputFactory.IS_NAMESPACE_AWARE, false) // prefixes and xmlns compared as written
        val r = factory.createXMLStreamReader(StringReader(xml))
        val stack = ArrayDeque<Node>()
        var root: Node? = null
        while (r.hasNext()) {
            when (r.next()) {
                XMLStreamConstants.START_ELEMENT -> {
                    val attrs = java.util.TreeMap<String, String>()
                    for (i in 0 until r.attributeCount) attrs[r.getAttributeLocalName(i).let { n ->
                        r.getAttributePrefix(i).takeUnless { it.isNullOrEmpty() }?.let { "$it:$n" } ?: n
                    }] = r.getAttributeValue(i)
                    val node = Node(r.localName.let { n -> r.prefix.takeUnless { it.isNullOrEmpty() }?.let { "$it:$n" } ?: n }, attrs)
                    stack.lastOrNull()?.children?.add(node)
                    if (root == null) root = node
                    stack.addLast(node)
                }
                XMLStreamConstants.END_ELEMENT -> stack.removeLast()
                XMLStreamConstants.CHARACTERS, XMLStreamConstants.CDATA -> stack.lastOrNull()?.children?.add(r.text)
            }
        }
        return root ?: error("no root element")
    }

    private fun compare(want: Node, got: Node, path: String): String? {
        if (want.name != got.name) return "$path: element ${want.name} expected, got ${got.name}"
        if (want.attributes != got.attributes) return "$path: attributes ${want.attributes} expected, got ${got.attributes}"
        val w = significant(want)
        val g = significant(got)
        if (w.size != g.size) return "$path: ${w.size} children expected, got ${g.size}"
        for (i in w.indices) {
            val a = w[i]
            val b = g[i]
            if (a is Node && b is Node) {
                compare(a, b, "$path/${a.name}[$i]")?.let { return it }
            } else if (a is Node || b is Node) {
                return "$path[$i]: node kind differs"
            } else if (a != b) {
                return "$path: text \"$a\" expected, got \"$b\""
            }
        }
        return null
    }

    /** Child elements and text, merging adjacent text runs and dropping blank text between elements. */
    private fun significant(n: Node): List<Any> {
        val merged = mutableListOf<Any>()
        for (c in n.children) {
            if (c is String && merged.lastOrNull() is String) merged[merged.lastIndex] = (merged.last() as String) + c
            else merged.add(c)
        }
        val hasElement = merged.any { it is Node }
        return merged.filterNot { it is String && hasElement && it.isBlank() }.filterNot { it is String && it.isEmpty() }
    }
}
