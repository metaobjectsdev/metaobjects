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
     * ADR-0042 package-local resolution: an FQN ref (contains {@code ::}) matches EXACTLY
     * on the resolution key; a bare ref matches the referrer's own package
     * ({@code <referrerPkg>::<ref>}), else a root-level (empty-package) object whose key IS
     * the bare ref. Package-local BEFORE root-level. Returns {@code null} when nothing matches.
     *
     * @param ref         the reference value (bare or FQN)
     * @param referrerPkg the effective package of the node declaring the ref ("" for root-level)
     */
    public MetaObject resolveObject(String ref, String referrerPkg) {
        if (ref.indexOf(MetaData.PKG_SEPARATOR) >= 0) {
            return byKey.get(ref);
        }
        String pkg = (referrerPkg == null) ? "" : referrerPkg;
        String localKey = pkg.isEmpty() ? ref : pkg + MetaData.PKG_SEPARATOR + ref;
        MetaObject own = byKey.get(localKey);
        if (own != null) return own;
        return byKey.get(ref); // root-level (empty-package) object whose key is the bare name
    }
}
