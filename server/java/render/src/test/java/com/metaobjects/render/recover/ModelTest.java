package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class ModelTest {

    @Test
    public void scalarFieldSpecBuildsWithDefaults() {
        FieldSpec f = FieldSpec.scalar("confidence", FieldKind.STRING, true);
        assertEquals("confidence", f.name());
        assertEquals(FieldKind.STRING, f.kind());
        assertTrue(f.required());
        assertFalse(f.array());
        assertNull(f.enumValues());
        assertNull(f.nested());
    }

    @Test
    public void enumFieldSpecCarriesValuesAndAliases() {
        FieldSpec f = FieldSpec.enumField(
                "tone", true,
                List.of("FRIENDLY", "NEUTRAL", "HOSTILE"),
                Map.of("warm", "FRIENDLY"));
        assertEquals(FieldKind.ENUM, f.kind());
        assertEquals(List.of("FRIENDLY", "NEUTRAL", "HOSTILE"), f.enumValues());
        assertEquals("FRIENDLY", f.enumAlias().get("warm"));
    }

    @Test
    public void schemaCarriesFormatAndRoot() {
        RecoverSchema s = new RecoverSchema(Format.XML, "answer",
                List.of(FieldSpec.scalar("text", FieldKind.STRING, true)));
        assertEquals(Format.XML, s.format());
        assertEquals("answer", s.rootName());
        assertEquals(1, s.fields().size());
    }
}
