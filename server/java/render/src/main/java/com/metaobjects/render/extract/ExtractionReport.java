package com.metaobjects.render.extract;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Mutable accumulator of per-field extraction classification, the degenerate-response flag, and coercion notes. */
public final class ExtractionReport {
    private final Map<String, FieldExtraction> states = new LinkedHashMap<>();
    private final List<Coercion> coercions = new ArrayList<>();
    private final Set<String> defaultedRequired = new LinkedHashSet<>();
    private boolean empty = false;

    public void set(String fieldPath, FieldExtraction state) { states.put(fieldPath, state); }
    public void addCoercion(Coercion c) { coercions.add(c); }
    public void markEmpty() { this.empty = true; }

    /** Called by Extract when an absent <b>required</b> field is filled from its {@code @default}. */
    public void markDefaultedRequired(String fieldPath) { defaultedRequired.add(fieldPath); }

    public boolean isEmpty() { return empty; }
    public Map<String, FieldExtraction> states() { return Map.copyOf(states); }
    public List<Coercion> coercions() { return List.copyOf(coercions); }

    public List<String> lostRequired() { return byState(FieldExtraction.LOST_REQUIRED); }
    public List<String> malformed() { return byState(FieldExtraction.MALFORMED); }
    public boolean hasLostRequired() { return !lostRequired().isEmpty(); }

    /** Every field the document did not answer, whose value came from its {@code @default}. */
    public List<String> defaulted() { return byState(FieldExtraction.DEFAULTED); }

    /**
     * The dangerous subset: <b>{@code @required} fields the document did NOT answer</b>, whose
     * value was silently supplied by their {@code @default}.
     *
     * <p>These do NOT appear in {@link #lostRequired()}, and that is deliberate — a default IS an
     * answer, so the field is not "lost". But it means a {@code @default} <b>switches off loss
     * detection for that field</b>, including in generated code: the generated extractor and
     * {@code ExtractionResult.dataOrThrow()} both key their failure signal on
     * {@link #hasLostRequired()}, so a required field carrying a default can never make them fire.
     *
     * <p>That is a sharp edge worth being able to SEE. It propagates through {@code extends} —
     * adding an innocuous {@code @default} to a shared abstract field silently disables loss
     * detection for every field inheriting it — and a missing value then becomes indistinguishable
     * from a real one. Check this alongside {@link #hasLostRequired()} when an absent answer must
     * not be mistaken for a given one.
     */
    public List<String> defaultedRequired() { return List.copyOf(defaultedRequired); }

    public boolean hasDefaultedRequired() { return !defaultedRequired.isEmpty(); }

    private List<String> byState(FieldExtraction s) {
        List<String> out = new ArrayList<>();
        for (var e : states.entrySet()) if (e.getValue() == s) out.add(e.getKey());
        return out;
    }
}
