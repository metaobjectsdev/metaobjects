package com.metaobjects.validation;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.List;

/**
 * A symbol table of every top-level object, built once per load — the compiler-binder
 * analogue, so reference resolution reads this instead of re-scanning the tree per ref.
 * Matching mirrors {@code ValidationPhase.nameMatches} (bare/short name tail, or full FQN).
 */
public final class SymbolTable {

    private final List<MetaObject> objects = new ArrayList<>();

    public static SymbolTable build(MetaRoot root) {
        SymbolTable t = new SymbolTable();
        // ADR-0039: root-level object scan — root is never extended, so own children
        // is the complete top-level object set.
        for (MetaData child : root.getChildren(MetaData.class, false)) {
            if (child instanceof MetaObject) {
                t.objects.add((MetaObject) child);
            }
        }
        return t;
    }

    /** Resolve a ref to its object, or {@code null}. */
    public MetaObject resolveObject(String ref) {
        for (MetaObject obj : objects) {
            if (nameMatches(obj, ref)) {
                return obj;
            }
        }
        return null;
    }

    private static boolean nameMatches(MetaData child, String ref) {
        // ADR-0041: a FULLY-QUALIFIED ref (contains "::") resolves EXACTLY — it
        // matches the object whose package-qualified name equals it and NOTHING
        // else. It must NEVER fall back to a bare-tail match (the closed bug: an
        // explicit `xpkg::vendor::Customer` wrongly binding `xpkg::crm::Customer`).
        if (ref.indexOf(MetaData.PKG_SEPARATOR) >= 0) {
            return ref.equals(child.getName());
        }
        // Bare ref → match the object's bare (short) name. Cross-package ambiguity
        // on a bare ref is reported separately by the loader's cross-package pass
        // (ERR_AMBIGUOUS_REF); resolution here stays lenient (first match wins).
        String bare = child.getShortName();
        if (bare == null || bare.isEmpty()) {
            String full = child.getName();
            if (full == null) return false;
            int i = full.lastIndexOf(MetaData.PKG_SEPARATOR);
            bare = (i >= 0) ? full.substring(i + MetaData.PKG_SEPARATOR.length()) : full;
        }
        return ref.equals(bare);
    }
}
