package com.metaobjects.render;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class EscapersTest {

    @Test public void textIsIdentity() {
        assertEquals("a & b", Escapers.escape("text", "a & b"));
    }

    @Test public void markdownIsIdentity() {
        assertEquals("**bold** & <em>", Escapers.escape("markdown", "**bold** & <em>"));
    }

    @Test public void htmlEntityEncodes() {
        assertEquals("&amp;&lt;&gt;&quot;&#39;", Escapers.escape("html", "&<>\"'"));
    }

    @Test public void xmlEntityEncodes() {
        assertEquals("&amp;&lt;&gt;&quot;&#39;", Escapers.escape("xml", "&<>\"'"));
    }

    @Test public void csvFormulaInjectionGuard() {
        assertEquals("'=SUM(A1:A5)", Escapers.escape("csv", "=SUM(A1:A5)"));
        assertEquals("'+1+1", Escapers.escape("csv", "+1+1"));
        assertEquals("'-1", Escapers.escape("csv", "-1"));
        assertEquals("'@cmd", Escapers.escape("csv", "@cmd"));
        assertEquals("'\tTAB", Escapers.escape("csv", "\tTAB"));
    }

    @Test public void csvQuotesValuesWithCommaOrNewline() {
        assertEquals("\"a,b\"", Escapers.escape("csv", "a,b"));
        assertEquals("\"a\nb\"", Escapers.escape("csv", "a\nb"));
        assertEquals("\"a\"\"b\"", Escapers.escape("csv", "a\"b"));
    }

    @Test public void csvPlainPassesThrough() {
        assertEquals("hello", Escapers.escape("csv", "hello"));
    }

    @Test public void jsonStringEncodes() {
        assertEquals("a\\\"b", Escapers.escape("json", "a\"b"));
        assertEquals("a\\\\b", Escapers.escape("json", "a\\b"));
        assertEquals("a\\nb", Escapers.escape("json", "a\nb"));
        assertEquals("a\\tb", Escapers.escape("json", "a\tb"));
    }

    @Test public void spreadsheetXmlEscapesThenGuards() {
        // = becomes XML-safe identity (= isn't an XML special), then guarded
        assertEquals("'=A1+B1", Escapers.escape("spreadsheet", "=A1+B1"));
        // & gets XML-escaped, no injection
        assertEquals("a&amp;b", Escapers.escape("spreadsheet", "a&b"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void unknownFormatRejected() {
        Escapers.escape("invalid", "x");
    }
}
