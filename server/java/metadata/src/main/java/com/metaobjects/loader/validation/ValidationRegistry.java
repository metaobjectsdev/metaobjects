package com.metaobjects.loader.validation;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The registry a provider contributes reference descriptors + node validators to, keyed by
 * "type.subType" (or "type.*" for all subtypes). The same registration that carries a
 * type's attrs/constraints can carry its validation — so a downstream provider extends
 * validation without forking core.
 */
public final class ValidationRegistry {

    public static final String SUBTYPE_ANY = "*";

    private final Map<String, List<ReferenceDescriptor>> refs = new HashMap<>();
    private final Map<String, List<NodeValidator>> validators = new HashMap<>();

    private static String key(String type, String subType) {
        return type + "." + subType;
    }

    public ValidationRegistry registerReference(String type, String subType, ReferenceDescriptor d) {
        refs.computeIfAbsent(key(type, subType), k -> new ArrayList<>()).add(d);
        return this;
    }

    public ValidationRegistry registerValidator(String type, String subType, NodeValidator v) {
        validators.computeIfAbsent(key(type, subType), k -> new ArrayList<>()).add(v);
        return this;
    }

    /** Descriptors registered for the exact (type, subType) PLUS (type, *). */
    public List<ReferenceDescriptor> referencesFor(String type, String subType) {
        List<ReferenceDescriptor> out = new ArrayList<>();
        out.addAll(refs.getOrDefault(key(type, SUBTYPE_ANY), List.of()));
        out.addAll(refs.getOrDefault(key(type, subType), List.of()));
        return out;
    }

    public List<NodeValidator> validatorsFor(String type, String subType) {
        List<NodeValidator> out = new ArrayList<>();
        out.addAll(validators.getOrDefault(key(type, SUBTYPE_ANY), List.of()));
        out.addAll(validators.getOrDefault(key(type, subType), List.of()));
        return out;
    }
}
