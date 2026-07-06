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

    // ---- Auto-derived boolean section accessors ({{#has<Field>}}) ----------

    /**
     * Spec test 1 — auto-accessor positive. A section opened on the derived
     * {@code has<Field>} accessor of a declared (optional/collection) field is
     * clean: the codegen'd payload record exposes a {@code hasAbilities()} method
     * for the {@code abilities} field, so {@code {{#hasAbilities}}} must NOT drift
     * even though {@code hasAbilities} is not itself a declared field.
     */
    @Test
    public void autoAccessorSectionOnDeclaredFieldOk() {
        var errors = Verify.check(
            "{{#hasAbilities}}{{#abilities}}- {{name}}\n{{/abilities}}{{/hasAbilities}}",
            List.of(PayloadField.object("abilities", List.of(PayloadField.scalar("name")))),
            VerifyOptions.empty());
        assertTrue("has<Field> accessor over a declared field must be clean; got: " + errors,
            errors.isEmpty());
    }

    /** A {@code has<Field>} accessor over a SCALAR (String) declared field is clean too. */
    @Test
    public void autoAccessorSectionOnScalarFieldOk() {
        var errors = Verify.check(
            "{{#hasBio}}{{bio}}{{/hasBio}}",
            List.of(PayloadField.scalar("bio")),
            VerifyOptions.empty());
        assertTrue("has<Field> over a scalar field must be clean; got: " + errors, errors.isEmpty());
    }

    /** An inverted section on an accessor ({@code {{^hasX}}}) is recognised the same way. */
    @Test
    public void invertedAutoAccessorSectionOk() {
        var errors = Verify.check(
            "{{^hasAbilities}}none{{/hasAbilities}}",
            List.of(PayloadField.object("abilities", List.of(PayloadField.scalar("name")))),
            VerifyOptions.empty());
        assertTrue(errors.isEmpty());
    }

    /**
     * Spec test 3 (regression guard) — a {@code has<Field>} whose underlying field
     * is NOT on the payload is still real drift.
     */
    @Test
    public void autoAccessorWithNoUnderlyingFieldFlagged() {
        var errors = Verify.check(
            "{{#hasSomethingNotAField}}x{{/hasSomethingNotAField}}",
            List.of(PayloadField.scalar("abilities")),
            VerifyOptions.empty());
        assertEquals(1, errors.size());
        assertEquals("ERR_VAR_NOT_ON_PAYLOAD", errors.get(0).code());
        assertEquals("hasSomethingNotAField", errors.get(0).path());
    }

    /** A bare {@code has} (no capitalised remainder / no field) is not an accessor. */
    @Test
    public void bareHasIsNotAnAccessor() {
        var errors = Verify.check(
            "{{#has}}x{{/has}}",
            List.of(PayloadField.scalar("abilities")),
            VerifyOptions.empty());
        assertEquals(1, errors.size());
        assertEquals("ERR_VAR_NOT_ON_PAYLOAD", errors.get(0).code());
    }

    // ---- Nested section scope (inner {{field}} resolves against the element) -

    /**
     * Spec test 2 — nested-scope positive. A section over a collection/object
     * field resolves its inner vars against that field's element field-tree
     * ({@code order}/{@code type} live on the element, not the root).
     */
    @Test
    public void nestedSectionResolvesInnerFieldsAgainstElement() {
        var errors = Verify.check(
            "{{#memories}}{{order}}:{{type}}\n{{/memories}}",
            List.of(PayloadField.object("memories",
                List.of(PayloadField.scalar("order"), PayloadField.scalar("type")))),
            VerifyOptions.empty());
        assertTrue("inner element fields must resolve; got: " + errors, errors.isEmpty());
    }

    /**
     * Spec test 3 (regression guard) — an inner {@code {{field}}} NOT on the
     * section's element type is still real drift.
     */
    @Test
    public void nestedSectionUnknownElementFieldFlagged() {
        var errors = Verify.check(
            "{{#memories}}{{fieldNotOnElement}}{{/memories}}",
            List.of(PayloadField.object("memories",
                List.of(PayloadField.scalar("order"), PayloadField.scalar("type")))),
            VerifyOptions.empty());
        assertEquals(1, errors.size());
        assertEquals("ERR_VAR_NOT_ON_PAYLOAD", errors.get(0).code());
        assertEquals("fieldNotOnElement", errors.get(0).path());
    }

    /** Spec test 3 (regression guard) — a bare root {@code {{orphan}}} still errors. */
    @Test
    public void bareRootOrphanStillFlagged() {
        var errors = Verify.check(
            "{{#memories}}{{order}}{{/memories}} {{orphanField}}",
            List.of(PayloadField.object("memories", List.of(PayloadField.scalar("order")))),
            VerifyOptions.empty());
        assertEquals(1, errors.size());
        assertEquals("ERR_VAR_NOT_ON_PAYLOAD", errors.get(0).code());
        assertEquals("orphanField", errors.get(0).path());
    }

    /**
     * Symmetry lock (spec test 4, engine half): the section name the static
     * verifier accepts for field {@code abilities} is EXACTLY the accessor name
     * the payload generator emits ({@link PayloadAccessors#hasAccessorName}) — the
     * two consult the one shared rule, so they cannot drift apart.
     */
    @Test
    public void acceptedAccessorNameMatchesSharedRule() {
        String accessor = PayloadAccessors.hasAccessorName("abilities"); // "hasAbilities"
        var clean = Verify.check(
            "{{#" + accessor + "}}ok{{/" + accessor + "}}",
            List.of(PayloadField.scalar("abilities")),
            VerifyOptions.empty());
        assertTrue("the generator's accessor name must verify clean; got: " + clean, clean.isEmpty());

        // A one-letter-off name is NOT the shared-rule accessor → still drift.
        var drift = Verify.check(
            "{{#hasAbility}}x{{/hasAbility}}",
            List.of(PayloadField.scalar("abilities")),
            VerifyOptions.empty());
        assertEquals(1, drift.size());
        assertEquals("ERR_VAR_NOT_ON_PAYLOAD", drift.get(0).code());
    }
}
