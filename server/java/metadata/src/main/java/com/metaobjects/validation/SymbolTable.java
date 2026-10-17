package com.metaobjects.validation;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.object.MetaObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A symbol table of every top-level object, built once per load — the compiler-binder
 * analogue, so reference resolution reads this instead of re-scanning the tree per ref.
 *
 * <p>ADR-0042 — package-local resolution. Objects are keyed by their canonical resolution
 * key ({@link MetaData#getName()} — the FQN, or the bare name for a root-level/empty-package
 * object) ONLY, with NO bare-name fallback: a bare ref never binds a same-named object in
 * another package. Mirrors the TS loader symbol table ({@code validation-registry.ts}).</p>
 */
public final class SymbolTable {

    private final Map<String, MetaObject> byKey = new LinkedHashMap<>();

    public static SymbolTable build(MetaRoot root) {
        SymbolTable t = new SymbolTable();
        // ADR-0039: root-level object scan — root is never extended, so own children
        // is the complete top-level object set.
        for (MetaData child : root.getChildren(MetaData.class, false)) {
            if (child instanceof MetaObject) {
                // ADR-0042: key by the canonical resolution key (getName()) ONLY — the FQN,
                // or the bare name for a root-level object. NO bare-name fallback, so a bare
                // ref never binds a same-named object in another package.
                t.byKey.put(child.getName(), (MetaObject) child);
            }
        }
        return t;
    }

    /**
     * ADR-0059 R2 resolution: {@code ::Rest} root-absolute, {@code ..::Rest} parent-relative,
     * {@code pkg::Name} exact, bare {@code Name} in the referrer's own package then root-level.
     * Exact keys only. An over-dropping {@code ..::} resolves to nothing; the walk reports it.
     *
     * @param ref         the reference value
     * @param referrerPkg the effective package of the declaring node ("" for root-level)
     */
    public MetaObject resolveObject(String ref, String referrerPkg) {
        java.util.List<String> keys;
        try {
            keys = com.metaobjects.loader.References.ownerCandidateKeys(ref, referrerPkg);
        } catch (com.metaobjects.loader.References.OverDropException e) {
            return null;
        }
        for (String key : keys) {
            MetaObject hit = byKey.get(key);
            if (hit != null) return hit;
        }
        return null;
    }
}
