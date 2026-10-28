package com.metaobjects.integration.api;

import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Compares two XML documents as an infoset: element names, attributes (namespace declarations
 * included), text and order. The declaration and the whitespace between elements are ignored;
 * whitespace inside a text-only element is data.
 */
final class XmlInfoset {
    private XmlInfoset() {}

    /** {@code null} when the two are the same infoset, else a one-line description of the first difference. */
    static String difference(String expected, String actual) {
        if (actual == null) return "no body";
        Element want;
        Element got;
        try {
            want = parse(expected);
            got = parse(actual);
        } catch (Exception e) {
            return "not well-formed XML: " + e.getMessage();
        }
        return compare(want, got, "/" + want.getTagName());
    }

    private static Element parse(String xml) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(false); // prefixes and xmlns attributes are compared as written
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        DocumentBuilder builder = factory.newDocumentBuilder();
        return builder.parse(new InputSource(new StringReader(xml))).getDocumentElement();
    }

    private static String compare(Element want, Element got, String path) {
        if (!want.getTagName().equals(got.getTagName()))
            return path + ": element " + want.getTagName() + " expected, got " + got.getTagName();
        Map<String, String> wantAttrs = attributes(want);
        Map<String, String> gotAttrs = attributes(got);
        if (!wantAttrs.equals(gotAttrs))
            return path + ": attributes " + wantAttrs + " expected, got " + gotAttrs;
        List<Node> wantKids = significant(want);
        List<Node> gotKids = significant(got);
        if (wantKids.size() != gotKids.size())
            return path + ": " + wantKids.size() + " children expected, got " + gotKids.size();
        for (int i = 0; i < wantKids.size(); i++) {
            Node w = wantKids.get(i);
            Node g = gotKids.get(i);
            if (w.getNodeType() != g.getNodeType())
                return path + "[" + i + "]: node kind differs";
            if (w instanceof Element we) {
                String d = compare(we, (Element) g, path + "/" + we.getTagName() + "[" + i + "]");
                if (d != null) return d;
            } else if (!w.getTextContent().equals(g.getTextContent())) {
                return path + ": text \"" + w.getTextContent() + "\" expected, got \"" + g.getTextContent() + "\"";
            }
        }
        return null;
    }

    private static Map<String, String> attributes(Element e) {
        Map<String, String> out = new TreeMap<>();
        for (int i = 0; i < e.getAttributes().getLength(); i++) {
            Node a = e.getAttributes().item(i);
            out.put(a.getNodeName(), a.getNodeValue());
        }
        return out;
    }

    /** The element and text children, dropping comments and whitespace-only text between elements. */
    private static List<Node> significant(Element e) {
        NodeList all = e.getChildNodes();
        boolean hasElement = false;
        for (int i = 0; i < all.getLength(); i++) if (all.item(i) instanceof Element) hasElement = true;
        List<Node> out = new ArrayList<>();
        for (int i = 0; i < all.getLength(); i++) {
            Node n = all.item(i);
            if (n instanceof Element) {
                out.add(n);
            } else if (n.getNodeType() == Node.TEXT_NODE || n.getNodeType() == Node.CDATA_SECTION_NODE) {
                if (hasElement && n.getTextContent().isBlank()) continue;
                out.add(n);
            }
        }
        return out;
    }
}
