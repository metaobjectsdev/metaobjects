package com.metaobjects.requirement;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.validation.SymbolTable;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Resolves an {@code @implementedBy} reference to the model node it names. ONE resolver,
 * shared by the requirement gate ({@link RequirementCheck}) and the requirement-test
 * generator, so the ADR-0042 package-local binding contract has a single owner.
 *
 * <p>Java port of {@code resolve-claim.ts} (and {@code splitMemberRef} from the TypeScript
 * gate). Objects resolve through {@link SymbolTable}, the loader's own resolver, never a
 * parallel name scan (#228).</p>
 */
public final class RequirementClaims {

    private RequirementClaims() {}

    /** A reference split into its owning root-level node and the dotted member path under it. */
    public record MemberRef(String owner, List<String> path) {}

    /**
     * Split a member reference into its owning ref and the dotted member path. {@code ::}
     * qualifies the ROOT-level node only, so the owner ends at the first {@code .} after the
     * last {@code ::}: {@code acme::sales::Order.total.display} gives owner
     * {@code acme::sales::Order} and path {@code [total, display]}.
     */
    public static MemberRef splitMemberRef(String ref) {
        int pkgEnd = ref.lastIndexOf(MetaData.PKG_SEPARATOR);
        int from = pkgEnd == -1 ? 0 : pkgEnd + MetaData.PKG_SEPARATOR.length();
        int dot = ref.indexOf('.', from);
        if (dot == -1) return new MemberRef(ref, List.of());
        return new MemberRef(ref.substring(0, dot), Arrays.asList(ref.substring(dot + 1).split("\\.", -1)));
    }

    /**
     * Resolve the owner segment of an {@code @implementedBy} reference to the node it names.
     * OBJECTS FIRST, through the loader's symbol table; then ROOT-LEVEL NON-OBJECT nodes (a
     * {@code template.prompt} and its siblings). Requirements are excluded: hierarchy is
     * nesting, and a requirement claiming a requirement would be a second parent mechanism.
     *
     * @param referrerPkg the effective package of the requirement making the claim
     * @return the node, or {@code null} when nothing matches or the match is ambiguous
     */
    public static MetaData resolveClaimTarget(MetaRoot root, String owner, String referrerPkg) {
        return resolveClaimTarget(root, SymbolTable.build(root), owner, referrerPkg);
    }

    /** {@link #resolveClaimTarget(MetaRoot, String, String)} over a symbol table the caller built once. */
    public static MetaData resolveClaimTarget(MetaRoot root, SymbolTable symbols, String owner, String referrerPkg) {
        MetaData object = symbols.resolveObject(owner, referrerPkg);
        if (object != null) return object;

        List<MetaData> candidates = new ArrayList<>();
        for (MetaData c : structuralChildren(root)) {
            if (!"object".equals(c.getType()) && !MetaRequirement.TYPE_REQUIREMENT.equals(c.getType())) candidates.add(c);
        }

        // A fully-qualified reference binds exactly, like every other FQN in the model.
        if (owner.contains(MetaData.PKG_SEPARATOR)) {
            for (MetaData c : candidates) if (owner.equals(c.getName())) return c;
            return null;
        }
        // A bare reference prefers the referrer's own package, then a root-level (unpackaged)
        // node of that bare name. An ambiguous bare name binds NOTHING.
        if (referrerPkg != null && !referrerPkg.isEmpty()) {
            String localKey = referrerPkg + MetaData.PKG_SEPARATOR + owner;
            MetaData local = null;
            int matches = 0;
            for (MetaData c : candidates) {
                if (localKey.equals(c.getName())) { local = c; matches++; }
            }
            if (matches == 1) return local;
        }
        MetaData bare = null;
        int matches = 0;
        for (MetaData c : candidates) {
            if (owner.equals(c.getShortName()) && owner.equals(c.getName())) { bare = c; matches++; }
        }
        return matches == 1 ? bare : null;
    }

    /**
     * Walk dotted member segments by CHILD NAME from a node, to full depth. Attributes are not
     * members: they are children in this port's tree and are not in TypeScript's.
     *
     * @return the node reached, or {@code null} when a segment does not resolve
     */
    public static MetaData resolveMember(MetaData obj, List<String> path) {
        MetaData cur = obj;
        for (String seg : path) {
            if (cur == null) return null;
            MetaData next = null;
            for (MetaData c : structuralChildren(cur)) {
                if (seg.equals(c.getShortName())) { next = c; break; }
            }
            cur = next;
        }
        return cur;
    }

    /**
     * Resolve a full {@code @implementedBy} reference, owner plus any dotted member segments, to
     * the node it names, or {@code null}. Resolution walks to the FULL depth of the reference,
     * so {@code Council.slug.display} yields the view node rather than stopping at the field.
     */
    public static MetaData resolveClaim(MetaRoot root, String ref, String referrerPkg) {
        // Segments split on every dot, as the reference does: a package qualifies the root
        // node only and carries no dot, so the first segment is the whole owner.
        String[] segs = ref.split("\\.", -1);
        MetaData owner = resolveClaimTarget(root, segs[0], referrerPkg);
        if (owner == null || segs.length == 1) return owner;
        return resolveMember(owner, Arrays.asList(segs).subList(1, segs.length));
    }

    /**
     * The node's EFFECTIVE children, attributes excluded: own plus inherited through
     * {@code extends} (ADR-0039 default, the same set TypeScript's {@code children()} reads).
     */
    static List<MetaData> structuralChildren(MetaData node) {
        List<MetaData> out = new ArrayList<>();
        for (MetaData c : node.getChildren(MetaData.class, true)) {
            if (!(c instanceof MetaAttribute)) out.add(c);
        }
        return out;
    }
}
