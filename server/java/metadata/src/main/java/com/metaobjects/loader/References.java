package com.metaobjects.loader;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * ADR-0059 — the one place a reference gets its meaning, and the one pass that resolves
 * every reference once, against the built tree.
 *
 * <p>Sources do not interpret references: YAML and canonical JSON hand the loader every
 * reference string exactly as authored. This class gives each form its meaning:</p>
 * <ul>
 *   <li>{@code ::Rest} — root-absolute: the node whose resolution key is exactly
 *       {@code Rest}. No package-local retry.</li>
 *   <li>{@code ..::Rest} — parent-relative: drop one trailing segment of the referrer's
 *       package per {@code ..::}, then the exact key. Over-drop is {@link OverDropException}.</li>
 *   <li>{@code pkg::Name} — exact.</li>
 *   <li>{@code Name} — exact {@code <referrerPkg>::Name}, else exact root-level {@code Name}.</li>
 * </ul>
 * <p>A FR-024 dotted child tail starts at the first {@code .} after the owner's last
 * {@code ::}; only the owner is resolved by form. Mirrors the TypeScript
 * {@code naming-refs.ts} and {@code loader/resolve-references.ts}.</p>
 */
public final class References {

    private References() {}

    private static final String SEP = MetaData.PKG_SEPARATOR;
    private static final String PARENT_PREFIX = ".." + SEP;

    /** ADR-0059 R4 — the inline attribute names whose value is an object reference. */
    public static final Set<String> REF_BEARING_ATTR_NAMES = Set.of(
        "objectRef", "through", "references", "from", "via", "of",
        "parameterRef", "payloadRef", "responseRef", "spine");

    /** A parent-relative reference with more {@code ..::} than its referrer's package has segments. */
    public static final class OverDropException extends RuntimeException {
        private static final long serialVersionUID = 1L;
        public OverDropException(String message) { super(message); }
    }

    /** The outcome of an owner resolution: a node, an over-drop message, or neither. */
    public record Resolution(MetaData node, String error) {
        static final Resolution NONE = new Resolution(null, null);
    }

    /** An owner and its dotted child tail ({@code ""} or a string starting with {@code .}). */
    public record Split(String owner, String tail) {}

    /** Split a reference into its owner and any dotted child tail. */
    public static Split splitChildTail(String raw) {
        int lastSep = raw.lastIndexOf(SEP);
        int segStart = lastSep == -1 ? 0 : lastSep + SEP.length();
        int dot = raw.indexOf('.', segStart);
        if (dot == -1) return new Split(raw, "");
        return new Split(raw.substring(0, dot), raw.substring(dot));
    }

    /** Resolution keys an OWNER may bind, in order to try (R2). Throws {@link OverDropException}. */
    public static List<String> ownerCandidateKeys(String owner, String referrerPkg) {
        String pkg = referrerPkg == null ? "" : referrerPkg;
        if (owner.startsWith(SEP)) return List.of(owner.substring(SEP.length()));
        if (owner.startsWith(PARENT_PREFIX)) {
            String rest = owner;
            int levels = 0;
            while (rest.startsWith(PARENT_PREFIX)) {
                levels++;
                rest = rest.substring(PARENT_PREFIX.length());
            }
            String[] parts = pkg.isEmpty() ? new String[0] : pkg.split(SEP);
            if (levels > parts.length) {
                throw new OverDropException("Relative reference '" + owner + "' over-drops: " + levels
                    + " parent level(s) but the package context '" + pkg + "' has only "
                    + parts.length + " segment(s)");
            }
            StringBuilder reduced = new StringBuilder();
            for (int i = 0; i < parts.length - levels; i++) {
                if (reduced.length() > 0) reduced.append(SEP);
                reduced.append(parts[i]);
            }
            return List.of(reduced.length() > 0 ? reduced + SEP + rest : rest);
        }
        if (owner.contains(SEP)) return List.of(owner);
        return pkg.isEmpty() ? List.of(owner) : List.of(pkg + SEP + owner, owner);
    }

    /** Bind an owner among {@code candidates} by exact resolution key. */
    private static Resolution bind(Iterable<MetaData> candidates, String owner, String referrerPkg) {
        List<String> keys;
        try {
            keys = ownerCandidateKeys(owner, referrerPkg);
        } catch (OverDropException e) {
            return new Resolution(null, e.getMessage());
        }
        for (String key : keys) {
            for (MetaData c : candidates) {
                if (key.equals(c.getName())) return new Resolution(c, null);
            }
        }
        return Resolution.NONE;
    }

    /** The root's direct children of {@code type} ({@code null} = any). ADR-0039: the root has no super. */
    private static List<MetaData> topLevelOfType(MetaData root, String type) {
        List<MetaData> out = new ArrayList<>();
        for (MetaData c : root.getChildren(MetaData.class, false)) {
            if (c instanceof MetaAttribute) continue;
            if (type == null || type.equals(c.getType())) out.add(c);
        }
        return out;
    }

    /** Resolve an OBJECT reference (no child tail) under R2. */
    public static Resolution resolveObjectRef(MetaData root, String ref, String referrerPkg) {
        return bind(topLevelOfType(root, MetaObject.TYPE_OBJECT), ref, referrerPkg);
    }

    /** Resolve an owner among the root's top-level nodes of {@code type} (any type when null). */
    public static Resolution resolveOwner(MetaData root, String owner, String referrerPkg, String type) {
        return bind(topLevelOfType(root, type), owner, referrerPkg);
    }

    /**
     * R7 — resolve a CANONICAL reference (owner plus optional dotted tail) with no referrer:
     * strip one leading {@code ::}, match a top-level object's resolution key exactly. The tail
     * is ignored (callers wanting the child walk it). Never matches on a short name. Returns
     * {@code null} when nothing matches.
     */
    public static MetaObject lookupCanonical(MetaData root, String value) {
        if (value == null || value.isEmpty()) return null;
        String owner = splitChildTail(value).owner();
        String exact = owner.startsWith(SEP) ? owner : SEP + owner;
        MetaData node = resolveObjectRef(root, exact, "").node();
        return node instanceof MetaObject ? (MetaObject) node : null;
    }

    /** R6 — the canonical spelling of a resolved owner, as written from a referrer in {@code referrerPkg}. */
    public static String spellRef(MetaData target, String referrerPkg, String tail) {
        String key = target.getName();
        boolean rootLevel = !key.contains(SEP);
        String ref = (rootLevel && referrerPkg != null && !referrerPkg.isEmpty()) ? SEP + key : key;
        return ref + (tail == null ? "" : tail);
    }

    /** The top-level node (a direct child of the root) that physically contains {@code node}. */
    public static MetaData topLevelNodeOf(MetaData node) {
        MetaData current = node;
        while (current.getParent() != null && current.getParent().getParent() != null) {
            current = current.getParent();
        }
        return current;
    }

    /** Effective package of a node: that of its top-level ancestor ({@code ""} for root-level). */
    public static String effectivePackageOf(MetaData node) {
        MetaData top = topLevelNodeOf(node);
        if (top instanceof MetaRoot) return "";
        String pkg = top.getPackage();
        return pkg == null ? "" : pkg;
    }

    /**
     * R3/R10 — the package an {@code extends} on {@code node} resolves in: a top-level node's
     * own package; a nested node's own FILE's default package (so a nested node merged in from
     * an overlay file resolves in that file's package, not the overlaid node's).
     */
    public static String extendsPackageOf(MetaData node) {
        if (node.getParent() == null || node.getParent().getParent() == null) {
            return effectivePackageOf(node);
        }
        String file = node.getFileDefaultPackage();
        return file != null ? file : effectivePackageOf(node);
    }

    /**
     * R3 default — the package a reference attribute resolves in: the effective package of the
     * top-level node that PHYSICALLY declares the attribute. An inherited attribute resolves
     * where it was written.
     */
    public static String referrerPackageFor(MetaData node, String attrName) {
        MetaData declarer = node;
        java.util.Set<MetaData> seen = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
        // ADR-0039: own — locating the layer that physically declares the attr.
        while (declarer != null && !declarer.hasMetaAttr(attrName, false) && seen.add(declarer)) {
            declarer = declarer.hasSuperData() ? declarer.getSuperData() : null;
        }
        return effectivePackageOf(declarer != null ? declarer : node);
    }

    /**
     * R7 — the object a reference attribute on {@code node} names: the owner the loader bound
     * once, read RESOLVING so an inherited attribute works. For a dotted ref it is the owner
     * object. A tree built without the loader has no recorded target, so the value is resolved
     * from the package of the node that declared it. {@code null} when absent or unresolvable.
     */
    public static MetaObject refTarget(MetaData node, String attrName) {
        java.util.Set<MetaData> seen = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
        for (MetaData n = node; n != null && seen.add(n); n = n.hasSuperData() ? n.getSuperData() : null) {
            // ADR-0039: own — locating the layer that declares the attr, walking the super chain.
            if (!n.hasMetaAttr(attrName, false)) continue;
            MetaAttribute<?> attr = n.getMetaAttr(attrName, false);
            Object recorded = attr.getResolvedTarget();
            if (recorded instanceof MetaObject) return (MetaObject) recorded;
            if (recorded != null) return null;
            Object value = attr.getValue();
            if (!(value instanceof String) || ((String) value).isEmpty()) return null;
            MetaData root = topLevelRoot(node);
            if (root == null) return null;
            MetaData found = resolveObjectRef(root, splitChildTail((String) value).owner(),
                effectivePackageOf(n)).node();
            return found instanceof MetaObject ? (MetaObject) found : null;
        }
        return null;
    }

    public static MetaData topLevelRoot(MetaData node) {
        MetaData c = node;
        while (c.getParent() != null) c = c.getParent();
        return c instanceof MetaRoot ? c : null;
    }

    // ---------------------------------------------------------------------------------
    // R5 — the pass
    // ---------------------------------------------------------------------------------

    /**
     * Resolve every own reference attribute (R4) and every {@code extends} in the tree, record
     * the targets, and rewrite resolved values to their canonical spelling. Runs once, after
     * the last validation pass. A reference that does not resolve is left as written.
     */
    public static void resolveReferences(MetaRoot root) {
        visit(root, root);
        flushCaches(root);
    }

    private static void visit(MetaRoot root, MetaData node) {
        if (node != root) {
            resolveExtends(root, node);
            String declPkg = effectivePackageOf(node);
            // ADR-0039: own — this pass rewrites the declared-here layer; an inherited attribute
            // is resolved once, on the node that declares it.
            for (MetaAttribute<?> attr : new ArrayList<>(node.getMetaAttrs(false))) {
                if (REF_BEARING_ATTR_NAMES.contains(attr.getName())) resolveAttr(root, node, attr, declPkg);
            }
        }
        // ADR-0039: own — structural walk over the physical declaration tree.
        for (MetaData child : new ArrayList<>(node.getChildren(MetaData.class, false))) {
            if (child instanceof MetaAttribute) continue;
            visit(root, child);
        }
    }

    private static void flushCaches(MetaData node) {
        node.invalidateCaches();
        for (MetaData child : node.getChildren(MetaData.class, false)) flushCaches(child);
    }

    /** R3 — the package an own reference attribute of {@code node} resolves in. */
    private static String referrerPackage(MetaRoot root, MetaData node, String attr, String declPkg) {
        // @of on a dimension that walks @via: the package of the entity the walk reaches.
        if (com.metaobjects.reporting.ReportingConstants.TYPE_DIMENSION.equals(node.getType())
                && com.metaobjects.reporting.ReportingConstants.ATTR_OF.equals(attr)) {
            String via = stringAttr(node, com.metaobjects.reporting.ReportingConstants.ATTR_VIA);
            MetaData declaring = node.getParent();
            if (via != null && !via.isEmpty() && declaring != null) {
                MetaData terminal = ReportingValidation.dimensionViaTerminal(root, declaring, via);
                return terminal != null ? effectivePackageOf(terminal) : declPkg;
            }
        }
        // @spine on a report: the package of the @from entity.
        if (MetaObject.TYPE_OBJECT.equals(node.getType()) && MetaObject.SUBTYPE_REPORT.equals(node.getSubType())
                && MetaObject.ATTR_REPORT_SPINE.equals(attr)) {
            String from = stringAttr(node, "from");
            if (from != null && !from.isEmpty()) {
                MetaData fromNode = resolveObjectRef(root, splitChildTail(from).owner(), declPkg).node();
                if (fromNode != null) return effectivePackageOf(fromNode);
            }
        }
        return declPkg;
    }

    private static String stringAttr(MetaData node, String name) {
        if (!node.hasMetaAttr(name)) return null;
        Object v = node.getMetaAttr(name).getValue();
        return v instanceof String ? (String) v : null;
    }

    /** One resolved reference: its owner object and the canonical spelling. */
    private record Resolved(MetaData target, String canonical) {}

    private static Resolved resolveOne(MetaRoot root, String value, String refPkg, String declPkg) {
        Split s = splitChildTail(value);
        MetaData target = resolveObjectRef(root, s.owner(), refPkg).node();
        if (target == null) return null;
        return new Resolved(target, spellRef(target, !refPkg.isEmpty() ? refPkg : declPkg, s.tail()));
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static void resolveAttr(MetaRoot root, MetaData node, MetaAttribute attr, String declPkg) {
        Object value = attr.getValue();
        String refPkg = referrerPackage(root, node, attr.getName(), declPkg);
        if (value instanceof String) {
            String v = (String) value;
            if (v.isEmpty()) return;
            Resolved r = resolveOne(root, v, refPkg, declPkg);
            if (r == null) return;
            attr.setResolvedTarget(r.target());
            if (!r.canonical().equals(v)) {
                if (attr.getAuthoredValue() == null) attr.setAuthoredValue(v);
                attr.setValueAsObject(r.canonical());
            }
            return;
        }
        if (value instanceof List && !((List<?>) value).isEmpty()
                && ((List<?>) value).stream().allMatch(x -> x instanceof String)) {
            List<String> items = (List<String>) value;
            List<Resolved> resolved = new ArrayList<>();
            boolean any = false;
            for (String v : items) {
                Resolved r = v.isEmpty() ? null : resolveOne(root, v, refPkg, declPkg);
                if (r != null) any = true;
                resolved.add(r);
            }
            if (!any) return;
            List<MetaData> targets = new ArrayList<>();
            List<String> canonical = new ArrayList<>();
            boolean changed = false;
            for (int i = 0; i < items.size(); i++) {
                Resolved r = resolved.get(i);
                targets.add(r == null ? null : r.target());
                String c = r == null ? items.get(i) : r.canonical();
                if (!c.equals(items.get(i))) changed = true;
                canonical.add(c);
            }
            attr.setResolvedTarget(targets);
            if (changed) {
                if (attr.getAuthoredValue() == null) attr.setAuthoredValue(new ArrayList<>(items));
                if (attr instanceof com.metaobjects.attr.StringAttribute) {
                    ((com.metaobjects.attr.StringAttribute) attr).setArrayValue(canonical);
                } else {
                    attr.setValueAsObject(canonical);
                }
            }
        }
    }

    /** Canonical {@code extends}: the owner spelled from the declaring node's package, tail kept. */
    private static void resolveExtends(MetaRoot root, MetaData node) {
        String ref = node.getAuthoredSuperRef();
        if (ref == null || ref.isEmpty() || !node.hasSuperData()) return;
        String pkg = extendsPackageOf(node);
        Split s = splitChildTail(ref);
        MetaData ownerNode = resolveOwner(root, s.owner(), pkg, null).node();
        if (ownerNode == null) return;
        node.setCanonicalSuperRef(spellRef(ownerNode, pkg, s.tail()));
    }
}
