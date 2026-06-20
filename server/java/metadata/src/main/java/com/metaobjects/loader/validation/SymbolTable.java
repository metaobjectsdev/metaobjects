package com.metaobjects.loader.validation;

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
        String bare = child.getShortName();
        if (bare == null || bare.isEmpty()) {
            String full = child.getName();
            if (full == null) return false;
            int i = full.lastIndexOf(MetaData.PKG_SEPARATOR);
            bare = (i >= 0) ? full.substring(i + MetaData.PKG_SEPARATOR.length()) : full;
        }
        int idx = ref.lastIndexOf(MetaData.PKG_SEPARATOR);
        String tail = (idx >= 0) ? ref.substring(idx + MetaData.PKG_SEPARATOR.length()) : ref;
        return tail.equals(bare) || ref.equals(child.getName());
    }
}
