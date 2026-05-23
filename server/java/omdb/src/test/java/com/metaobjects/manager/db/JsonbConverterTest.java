package com.metaobjects.manager.db;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class JsonbConverterTest {
    // mutable POJO stand-in for a generated jsonb value type
    public static class Disposition {
        public String subjectId;
        public int affinity;
        public Disposition() {}
        public Disposition(String s, int a) { subjectId = s; affinity = a; }
    }

    private final JsonbConverter conv = new JsonbConverter();

    @Test
    public void single_object_roundtrip() {
        Disposition d = new Disposition("p1", 5);
        String json = conv.toJson(d);
        Disposition back = conv.fromJson(json, Disposition.class);
        assertEquals("p1", back.subjectId);
        assertEquals(5, back.affinity);
    }

    @Test
    public void list_roundtrip() {
        List<Disposition> list = List.of(new Disposition("p1", 1), new Disposition("p2", 2));
        String json = conv.toJson(list);
        List<Disposition> back = conv.fromJsonList(json, Disposition.class);
        assertEquals(2, back.size());
        assertEquals("p2", back.get(1).subjectId);
    }

    @Test
    public void keyed_map_roundtrip() {
        Map<String, Disposition> m = Map.of("p1", new Disposition("p1", 9));
        String json = conv.toJson(m);
        Map<String, Disposition> back = conv.fromJsonMap(json, String.class, Disposition.class);
        assertEquals(9, back.get("p1").affinity);
    }
}
