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
}
