package com.metaobjects.render;

import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class VerifyTest {

    @Test
    public void scalarVariableOnPayloadOk() {
        var errors = Verify.check("Hello {{name}}",
            List.of(PayloadField.scalar("name")),
            VerifyOptions.empty());
        assertTrue(errors.isEmpty());
    }

    @Test
    public void variableNotOnPayloadFlagged() {
        var errors = Verify.check("Hello {{missing}}",
            List.of(PayloadField.scalar("name")),
            VerifyOptions.empty());
        assertEquals(1, errors.size());
        assertEquals("ERR_VAR_NOT_ON_PAYLOAD", errors.get(0).code());
        assertTrue(errors.get(0).path().contains("missing"));
    }

    @Test
    public void sectionWithContextResolvesNestedFields() {
        var errors = Verify.check("{{#posts}}- {{title}}\n{{/posts}}",
            List.of(PayloadField.object("posts",
                List.of(PayloadField.scalar("title")))),
            VerifyOptions.empty());
        assertTrue(errors.isEmpty());
    }

    @Test
    public void invertedSectionKeepsContext() {
        var errors = Verify.check("{{^posts}}none{{/posts}} {{name}}",
            List.of(
                PayloadField.scalar("name"),
                PayloadField.object("posts", List.of(PayloadField.scalar("title")))
            ),
            VerifyOptions.empty());
        assertTrue(errors.isEmpty());
    }

    @Test
    public void partialResolvedViaProvider() {
        var opts = new VerifyOptions(
            new InMemoryProvider(Map.of("p/h", "{{title}}")),
            null, null);
        var errors = Verify.check("{{#posts}}{{> p/h }}{{/posts}}",
            List.of(PayloadField.object("posts",
                List.of(PayloadField.scalar("title")))),
            opts);
        assertTrue(errors.isEmpty());
    }

    @Test
    public void unresolvedPartialFlagged() {
        var opts = new VerifyOptions(new InMemoryProvider(Map.of()), null, null);
        var errors = Verify.check("{{> missing/x }}", List.of(), opts);
        assertEquals(1, errors.size());
        assertEquals("ERR_PARTIAL_UNRESOLVED", errors.get(0).code());
    }

    @Test
    public void unusedRequiredSlotFlaggedAsWarning() {
        var opts = new VerifyOptions(null, List.of("name", "unused"), null);
        var errors = Verify.check("Hello {{name}}",
            List.of(PayloadField.scalar("name")),
            opts);
        assertEquals(1, errors.size());
        assertEquals("ERR_REQUIRED_SLOT_UNUSED", errors.get(0).code());
        assertEquals("unused", errors.get(0).path());
    }

    @Test
    public void missingOutputTagFlagged() {
        var opts = new VerifyOptions(null, null, List.of("required"));
        var errors = Verify.check("<other>x</other>", List.of(), opts);
        assertEquals(1, errors.size());
        assertEquals("ERR_OUTPUT_TAG_MISSING", errors.get(0).code());
    }

    @Test
    public void presentOutputTagOk() {
        var opts = new VerifyOptions(null, null, List.of("present"));
        var errors = Verify.check("<present>x</present>", List.of(), opts);
        assertTrue(errors.isEmpty());
    }

    @Test
    public void presentOutputTagWithAttributesOk() {
        var opts = new VerifyOptions(null, null, List.of("present"));
        var errors = Verify.check("<present attr=\"v\">x</present>", List.of(), opts);
        assertTrue(errors.isEmpty());
    }
}
