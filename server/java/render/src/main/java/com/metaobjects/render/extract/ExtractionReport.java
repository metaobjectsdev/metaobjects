package com.metaobjects.render.extract;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Mutable accumulator of per-field extraction classification, the degenerate-response flag, and coercion notes. */
public final class ExtractionReport {
    private final Map<String, FieldExtraction> states = new LinkedHashMap<>();
    private final List<Coercion> coercions = new ArrayList<>();
    private boolean empty = false;

    public void set(String fieldPath, FieldExtraction state) { states.put(fieldPath, state); }
    public void addCoercion(Coercion c) { coercions.add(c); }
    public void markEmpty() { this.empty = true; }

    public boolean isEmpty() { return empty; }
    public Map<String, FieldExtraction> states() { return Map.copyOf(states); }
    public List<Coercion> coercions() { return List.copyOf(coercions); }

    public List<String> lostRequired() { return byState(FieldExtraction.LOST_REQUIRED); }
    public List<String> malformed() { return byState(FieldExtraction.MALFORMED); }
    public boolean hasLostRequired() { return !lostRequired().isEmpty(); }

    private List<String> byState(FieldExtraction s) {
        List<String> out = new ArrayList<>();
        for (var e : states.entrySet()) if (e.getValue() == s) out.add(e.getKey());
        return out;
    }
}
