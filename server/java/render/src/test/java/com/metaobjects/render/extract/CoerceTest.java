package com.metaobjects.render.extract;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class CoerceTest {

    private ExtractionReport rep;
    private ExtractOptions normal() { return ExtractOptions.defaults(); }

    @org.junit.Before public void setup() { rep = new ExtractionReport(); }

    @Test
    public void enumExactMatch() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY", "HOSTILE"), Map.of());
        assertEquals("FRIENDLY", Coerce.value("FRIENDLY", f, normal(), "tone", rep));
    }

    @Test
    public void enumCaseFoldedInNormal() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY"), Map.of());
        assertEquals("FRIENDLY", Coerce.value("friendly", f, normal(), "tone", rep));
    }

    @Test
    public void enumStrictDoesNotCaseFold() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY"), Map.of());
        assertEquals(Coerce.MALFORMED, Coerce.value("friendly", f, normal().withTolerance(Tolerance.STRICT), "tone", rep));
    }

    @Test
    public void enumSchemaAliasFolds() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY"), Map.of("warm", "FRIENDLY"));
        assertEquals("FRIENDLY", Coerce.value("warm", f, normal(), "tone", rep));
        assertTrue(rep.coercions().stream().anyMatch(c -> c.kind().equals("alias")));
    }

    @Test
    public void runtimeAliasWinsOverSchema() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY", "HOSTILE"), Map.of("x", "FRIENDLY"));
        ExtractOptions opts = new ExtractOptions(Tolerance.NORMAL, Map.of("x", "HOSTILE"), Map.of(), null);
        assertEquals("HOSTILE", Coerce.value("x", f, opts, "tone", rep));
        assertTrue(rep.coercions().stream().anyMatch(c -> c.kind().equals("runtime-alias-override")));
    }

    @Test
    public void enumOffVocabIsMalformed() {
        FieldSpec f = FieldSpec.enumField("tone", true, List.of("FRIENDLY"), Map.of());
        assertEquals(Coerce.MALFORMED, Coerce.value("banana", f, normal(), "tone", rep));
    }

    @Test
    public void intClampToRange() {
        FieldSpec f = FieldSpec.range("score", FieldKind.INT, true, 0.0, 10.0);
        assertEquals(10L, Coerce.value("42", f, normal(), "score", rep));
        assertTrue(rep.coercions().stream().anyMatch(c -> c.kind().equals("clamp")));
    }

    @Test
    public void intUnparseableMalformed() {
        FieldSpec f = FieldSpec.scalar("score", FieldKind.INT, true);
        assertEquals(Coerce.MALFORMED, Coerce.value("abc", f, normal(), "score", rep));
    }

    @Test
    public void booleanForms() {
        FieldSpec f = FieldSpec.scalar("ok", FieldKind.BOOLEAN, true);
        assertEquals(Boolean.TRUE, Coerce.value("yes", f, normal(), "ok", rep));
        assertEquals(Boolean.FALSE, Coerce.value("0", f, normal(), "ok", rep));
    }

    @Test
    public void onFieldHookWins() {
        FieldSpec f = FieldSpec.scalar("x", FieldKind.STRING, true);
        ExtractOptions opts = new ExtractOptions(Tolerance.NORMAL, Map.of(), Map.of(),
                (path, raw, spec) -> "HOOKED");
        assertEquals("HOOKED", Coerce.value("anything", f, opts, "x", rep));
    }

    @Test
    public void nanIsMalformedForDouble() {
        FieldSpec f = FieldSpec.scalar("n", FieldKind.DOUBLE, true);
        assertEquals(Coerce.MALFORMED, Coerce.value("NaN", f, normal(), "n", rep));
    }

    @Test
    public void infinityIsMalformedForInt() {
        FieldSpec f = FieldSpec.scalar("k", FieldKind.INT, true);
        assertEquals(Coerce.MALFORMED, Coerce.value("Infinity", f, normal(), "k", rep));
        assertEquals(Coerce.MALFORMED, Coerce.value("-Infinity", f, normal(), "k", rep));
    }

    @Test
    public void normalizerByFieldNameApplied() {
        FieldSpec f = FieldSpec.scalar("x", FieldKind.STRING, true);
        java.util.Map<String, java.util.function.Function<String, Object>> norms =
                java.util.Map.of("x", raw -> raw.toUpperCase());
        ExtractOptions opts = new ExtractOptions(Tolerance.NORMAL, Map.of(), norms, null);
        assertEquals("HELLO", Coerce.value("hello", f, opts, "x", rep));
        assertTrue(rep.coercions().stream().anyMatch(c -> c.kind().equals("normalizer")));
    }
}
