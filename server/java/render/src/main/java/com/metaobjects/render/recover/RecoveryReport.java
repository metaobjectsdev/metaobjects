package com.metaobjects.render.recover;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Mutable accumulator of per-field recovery classification, the degenerate-response flag, and coercion notes. */
public final class RecoveryReport {
    private final Map<String, FieldRecovery> states = new LinkedHashMap<>();
    private final List<Coercion> coercions = new ArrayList<>();
    private boolean empty = false;

    public void set(String fieldPath, FieldRecovery state) { states.put(fieldPath, state); }
    public void addCoercion(Coercion c) { coercions.add(c); }
    public void markEmpty() { this.empty = true; }

    public boolean isEmpty() { return empty; }
    public Map<String, FieldRecovery> states() { return Map.copyOf(states); }
    public List<Coercion> coercions() { return List.copyOf(coercions); }

    public List<String> lostRequired() { return byState(FieldRecovery.LOST_REQUIRED); }
    public List<String> malformed() { return byState(FieldRecovery.MALFORMED); }
    public boolean hasLostRequired() { return !lostRequired().isEmpty(); }

    private List<String> byState(FieldRecovery s) {
        List<String> out = new ArrayList<>();
        for (var e : states.entrySet()) if (e.getValue() == s) out.add(e.getKey());
        return out;
    }
}
