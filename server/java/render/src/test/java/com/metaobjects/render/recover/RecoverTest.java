package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class RecoverTest {

    private RecoverSchema jsonAnswer() {
        return new RecoverSchema(Format.JSON, "answer", List.of(
                FieldSpec.scalar("text", FieldKind.STRING, true),
                FieldSpec.enumField("confidence", true, List.of("HIGH", "OK", "LOW"), Map.of("medium", "OK")),
                FieldSpec.scalar("note", FieldKind.STRING, false)));
    }

    @Test
    public void cleanJsonAllRecovered() {
        RecoverOutcome o = Recover.recover(
                "{\"text\":\"hi\",\"confidence\":\"HIGH\",\"note\":\"n\"}", jsonAnswer(), RecoverOptions.defaults());
        assertEquals("hi", o.data().get("text"));
        assertEquals("HIGH", o.data().get("confidence"));
        assertEquals(FieldRecovery.RECOVERED, o.report().states().get("confidence"));
        assertFalse(o.report().hasLostRequired());
    }

    @Test
    public void fencedAndProseWrappedStillRecovers() {
        String dirty = "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"HIGH\"}\n```\nDone.";
        RecoverOutcome o = Recover.recover(dirty, jsonAnswer(), RecoverOptions.defaults());
        assertEquals("hi", o.data().get("text"));
        assertEquals(FieldRecovery.LOST_OPTIONAL, o.report().states().get("note"));
    }

    @Test
    public void aliasFoldsOffVocab() {
        RecoverOutcome o = Recover.recover(
                "{\"text\":\"hi\",\"confidence\":\"medium\"}", jsonAnswer(), RecoverOptions.defaults());
        assertEquals("OK", o.data().get("confidence"));
        assertEquals(FieldRecovery.RECOVERED, o.report().states().get("confidence"));
    }

    @Test
    public void offVocabRequiredIsMalformed() {
        RecoverOutcome o = Recover.recover(
                "{\"text\":\"hi\",\"confidence\":\"banana\"}", jsonAnswer(), RecoverOptions.defaults());
        assertEquals(FieldRecovery.MALFORMED, o.report().states().get("confidence"));
        assertFalse(o.data().containsKey("confidence"));
    }

    @Test
    public void missingRequiredIsLostRequired() {
        RecoverOutcome o = Recover.recover("{\"text\":\"hi\"}", jsonAnswer(), RecoverOptions.defaults());
        assertEquals(List.of("confidence"), o.report().lostRequired());
    }

    @Test
    public void emptyResponseFlagsEmptyAndAllRequiredLost() {
        RecoverOutcome o = Recover.recover("   ", jsonAnswer(), RecoverOptions.defaults());
        assertTrue(o.report().isEmpty());
        assertTrue(o.report().lostRequired().contains("text"));
        assertTrue(o.report().lostRequired().contains("confidence"));
    }

    @Test
    public void xmlUnclosedTagRecovers() {
        RecoverSchema xml = new RecoverSchema(Format.XML, "answer", List.of(
                FieldSpec.scalar("text", FieldKind.STRING, true),
                FieldSpec.enumField("confidence", true, List.of("HIGH"), Map.of())));
        RecoverOutcome o = Recover.recover("<answer><text>hi<confidence>HIGH</confidence></answer>",
                xml, RecoverOptions.defaults());
        assertEquals("hi", o.data().get("text"));
        assertEquals("HIGH", o.data().get("confidence"));
    }

    @Test
    public void neverThrowsOnGarbage() {
        RecoverOutcome o = Recover.recover("@@@ totally broken @@@", jsonAnswer(), RecoverOptions.defaults());
        assertTrue(o.report().isEmpty());
    }

    @Test
    public void jsonStringArrayRecoversAsList() {
        RecoverSchema s = new RecoverSchema(Format.JSON, "answer", List.of(
                new FieldSpec("tags", FieldKind.STRING, false, true, null, null, null, null, null)));
        RecoverOutcome o = Recover.recover("{\"tags\":[\"a\",\"b\"]}", s, RecoverOptions.defaults());
        assertEquals(List.of("a", "b"), o.data().get("tags"));
        assertEquals(FieldRecovery.RECOVERED, o.report().states().get("tags"));
    }

    @Test
    public void jsonEnumArrayCoercesPerElement() {
        RecoverSchema s = new RecoverSchema(Format.JSON, "answer", List.of(
                new FieldSpec("tones", FieldKind.ENUM, false, true,
                        List.of("HIGH", "LOW"), Map.of("warm", "HIGH"), null, null, null)));
        RecoverOutcome o = Recover.recover("{\"tones\":[\"warm\",\"LOW\"]}", s, RecoverOptions.defaults());
        assertEquals(List.of("HIGH", "LOW"), o.data().get("tones"));
        assertEquals(FieldRecovery.RECOVERED, o.report().states().get("tones"));
    }

    @Test
    public void listForScalarFieldIsMalformed() {
        RecoverSchema s = new RecoverSchema(Format.JSON, "answer", List.of(
                FieldSpec.scalar("text", FieldKind.STRING, true)));
        RecoverOutcome o = Recover.recover("{\"text\":[\"a\",\"b\"]}", s, RecoverOptions.defaults());
        assertEquals(FieldRecovery.MALFORMED, o.report().states().get("text"));
        assertFalse(o.data().containsKey("text"));
    }

    @Test
    public void objectFieldWithScalarValueIsMalformed() {
        RecoverSchema nested = new RecoverSchema(Format.JSON, "meta",
                List.of(FieldSpec.scalar("n", FieldKind.STRING, true)));
        RecoverSchema s = new RecoverSchema(Format.JSON, "answer", List.of(
                FieldSpec.object("meta", true, false, nested)));
        RecoverOutcome o = Recover.recover("{\"meta\":\"oops\"}", s, RecoverOptions.defaults());
        assertEquals(FieldRecovery.MALFORMED, o.report().states().get("meta"));
    }

    @Test
    public void truncatedValueIsMalformedNotLost() {
        // confidence key present but value cut off → MALFORMED (present-but-garbled), distinct from absent
        RecoverOutcome o = Recover.recover("{\"text\":\"hi\",\"confidence\":", jsonAnswer(), RecoverOptions.defaults());
        assertEquals("hi", o.data().get("text"));
        assertEquals(FieldRecovery.MALFORMED, o.report().states().get("confidence"));
        assertFalse(o.report().isEmpty());
    }
}
