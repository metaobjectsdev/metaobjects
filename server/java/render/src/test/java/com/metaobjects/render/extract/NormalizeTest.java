package com.metaobjects.render.extract;

import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;

/**
 * FR-011 unit tests for {@link Normalize} (the ASCII enum-variant rule) and the
 * {@link Coerce} enum pipeline (exact → normalize → alias → coerceDefault → MALFORMED).
 * Byte-identical to the TS/C# normalize + coerce tests.
 */
public class NormalizeTest {

    // ---- Normalize.enumValue rule ----

    @Test
    public void noneIsIdentity() {
        assertEquals("in progress", Normalize.enumValue("in progress", Normalize.NONE));
        assertEquals("In-Progress!", Normalize.enumValue("In-Progress!", Normalize.NONE));
    }

    @Test
    public void stripUppercasesAndKeepsAlnumOnly() {
        assertEquals("INPROGRESS", Normalize.enumValue("in progress", Normalize.STRIP));
        assertEquals("INPROGRESS", Normalize.enumValue("In-Progress!", Normalize.STRIP));
        assertEquals("INPROGRESS", Normalize.enumValue("  in_progress  ", Normalize.STRIP));
        assertEquals("DONE", Normalize.enumValue("done", Normalize.STRIP));
    }

    @Test
    public void collapseUppercasesTrimsAndCollapsesSeparators() {
        assertEquals("IN_PROGRESS", Normalize.enumValue("in progress", Normalize.COLLAPSE));
        assertEquals("IN_PROGRESS", Normalize.enumValue("In-Progress", Normalize.COLLAPSE));
        assertEquals("IN_PROGRESS", Normalize.enumValue("  in___progress  ", Normalize.COLLAPSE));
        // "inprogress" (no separator) does NOT collapse to IN_PROGRESS → distinct from strip.
        assertEquals("INPROGRESS", Normalize.enumValue("inprogress", Normalize.COLLAPSE));
    }

    @Test
    public void asciiOnlyUppercasingIsLocaleIndependent() {
        // 'i' must fold to ASCII 'I' (U+0049), never the Turkish dotted-I (U+0130).
        String result = Normalize.enumValue("idle", Normalize.STRIP);
        assertEquals("IDLE", result);
        assertEquals('I', result.charAt(0));
    }

    // ---- Coerce enum pipeline ----

    private static Object coerceEnum(String raw, FieldSpec spec, ExtractOptions opts) {
        return Coerce.value(raw, spec, opts, spec.name(), new ExtractionReport());
    }

    private static FieldSpec enumSpec(String normalize, String coerceDefault, Map<String, String> aliases) {
        return FieldSpec.enumField("status", true, List.of("IN_PROGRESS", "DONE"),
                aliases, coerceDefault, normalize, null);
    }

    @Test
    public void exactMatchWins() {
        FieldSpec spec = enumSpec(Normalize.STRIP, null, Map.of());
        assertEquals("DONE", coerceEnum("DONE", spec, ExtractOptions.defaults()));
    }

    @Test
    public void normalizeStripFoldsOffVocab() {
        FieldSpec spec = enumSpec(Normalize.STRIP, null, Map.of());
        assertEquals("IN_PROGRESS", coerceEnum("in progress", spec, ExtractOptions.defaults()));
    }

    @Test
    public void normalizeCollapseRejectsRunTogether() {
        FieldSpec spec = enumSpec(Normalize.COLLAPSE, null, Map.of());
        // "inprogress" normalizes to "INPROGRESS" which != "IN_PROGRESS" under collapse → MALFORMED.
        assertEquals(Coerce.MALFORMED, coerceEnum("inprogress", spec, ExtractOptions.defaults()));
    }

    @Test
    public void normalizeNoneRejectsAnyVariation() {
        FieldSpec spec = enumSpec(Normalize.NONE, null, Map.of());
        assertEquals(Coerce.MALFORMED, coerceEnum("in progress", spec, ExtractOptions.defaults()));
        assertEquals("DONE", coerceEnum("DONE", spec, ExtractOptions.defaults()));
    }

    @Test
    public void coerceDefaultIsTerminalFallback() {
        FieldSpec spec = enumSpec(Normalize.NONE, "DONE", Map.of());
        assertEquals("DONE", coerceEnum("banana", spec, ExtractOptions.defaults()));
    }

    @Test
    public void schemaAliasResolvesBeforeCoerceDefault() {
        FieldSpec spec = enumSpec(Normalize.NONE, "DONE", Map.of("wip", "IN_PROGRESS"));
        assertEquals("IN_PROGRESS", coerceEnum("wip", spec, ExtractOptions.defaults()));
    }

    @Test
    public void aliasKeyMatchesUnderNormalizationMode() {
        FieldSpec spec = enumSpec(Normalize.STRIP, null, Map.of("WIP", "IN_PROGRESS"));
        // "w.i.p" strips to "WIP" → matches the alias key under strip.
        assertEquals("IN_PROGRESS", coerceEnum("w.i.p", spec, ExtractOptions.defaults()));
    }

    @Test
    public void strictToleranceForcesExactOnly() {
        FieldSpec spec = enumSpec(Normalize.STRIP, "DONE", Map.of());
        ExtractOptions strict = ExtractOptions.defaults().withTolerance(Tolerance.STRICT);
        // Under STRICT, normalization is forced to none — "in progress" cannot fold; but
        // @coerceDefault still applies as the terminal fallback.
        assertEquals("DONE", coerceEnum("in progress", spec, strict));
        // exact still wins.
        assertEquals("DONE", coerceEnum("DONE", spec, strict));
    }
}
