package com.metaobjects.loader.validation;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.TypeDefinition;
import com.metaobjects.validation.ReferenceDescriptor;
import com.metaobjects.validation.SymbolTable;
import com.metaobjects.validation.ValidationContext;
import com.metaobjects.validation.ValidationError;

import java.util.List;

/**
 * The single recursive walk that backs {@code root.validate(ctx)}. Validation is DERIVED
 * FROM THE TYPE REGISTRY: each node's {@link TypeDefinition} carries its reference
 * descriptors + imperative validator, so a downstream provider's type validates itself
 * simply by being registered — no separate wiring, no core changes. Per node: apply the
 * type's declared references (resolve against the symbol table), invoke its validator, then
 * recurse. Phase 2 prototype.
 */
public final class RegisteredValidation {

    private RegisteredValidation() {}

    /** Run validation derived from {@code registry} over the tree, COLLECTING all findings. */
    public static List<ValidationError> run(MetaRoot root, MetaDataRegistry registry) {
        ValidationContext ctx = new ValidationContext(SymbolTable.build(root));
        walk(root, registry, ctx, "");
        return ctx.errors();
    }

    private static void walk(MetaData node, MetaDataRegistry registry, ValidationContext ctx,
                             String referrerPkg) {
        String type = node.getType();
        String subType = node.getSubType();
        // ADR-0042: a top-level object establishes the package context for its subtree;
        // nested ref-bearing nodes (relationship / field.object / identity.reference) resolve
        // BARE refs against it. Nested nodes carry no package of their own, so they inherit the
        // enclosing object's. Mirrors TS validation-registry.ts.
        String pkg = referrerPkg;
        if (node instanceof MetaObject) {
            String p = node.getPackage();
            pkg = (p != null && !p.isEmpty()) ? p : referrerPkg;
        }
        if (type != null && subType != null) {
            TypeDefinition def = registry.getTypeDefinition(type, subType);
            if (def != null) {
                for (ReferenceDescriptor desc : def.getReferences()) {
                    // ADR-0039: resolving — a reference attr (e.g. @objectRef on a
                    // relationship, @references on identity.reference) may be inherited
                    // via extends; read the EFFECTIVE value so an inherited reference is
                    // still resolution-checked. Mirrors TS validation-registry.ts:66
                    // (node.attr(desc.attr), resolving). Own-only would skip validating
                    // an inherited reference, letting a dangling inherited ref slip through.
                    if (!node.hasMetaAttr(desc.attr())) continue;
                    String raw = node.getMetaAttr(desc.attr()).getValueAsString();
                    if (raw == null || raw.isEmpty()) continue; // absence is the required-attr pass's job
                    int dot = raw.indexOf('.');
                    String entityRef = (desc.dottedFieldPath() && dot >= 0) ? raw.substring(0, dot) : raw;
                    // ADR-0042: package-local resolution — an FQN resolves exactly, a bare ref
                    // resolves in the referrer's package (else root-level). No bare-name fallback.
                    MetaObject target = ctx.symbols().resolveObject(entityRef, pkg);
                    // Qualify the node name with its owning entity (e.g. "Order.items") so the
                    // error is locatable from the message alone, not just the source envelope.
                    String qname = (node.getParent() != null && node.getParent().getShortName() != null
                            && !node.getParent().getShortName().isEmpty())
                        ? node.getParent().getShortName() + "." + node.getShortName()
                        : node.getShortName();
                    if (target == null) {
                        ctx.error(desc.errorCode(), node,
                            type + "." + subType + " \"" + qname + "\" @"
                                + desc.attr() + " \"" + raw + "\" does not resolve to an object."
                                + didYouMeanHint(node, entityRef));
                    } else if (!target.getType().equals(desc.targetType())
                            || (desc.targetSubType() != null && !target.getSubType().equals(desc.targetSubType()))) {
                        String want = desc.targetSubType() != null
                            ? desc.targetType() + "." + desc.targetSubType() : desc.targetType();
                        ctx.error(desc.errorCode(), node,
                            type + "." + subType + " \"" + qname + "\" @" + desc.attr()
                                + " \"" + raw + "\" resolves to " + target.getType() + "." + target.getSubType()
                                + ", not a " + want + ".");
                    }
                }
                if (def.getValidator() != null) {
                    def.getValidator().validate(node, ctx);
                }
            }
        }
        // ADR-0039: structural tree recursion — descend via OWN children so each declared
        // node is validated exactly once at its declaration site (inherited members are
        // validated on the parent, not re-walked here).
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walk(child, registry, ctx, pkg);
        }
    }

    /**
     * ADR-0042 §5 — a did-you-mean suffix for an UNRESOLVED object reference: the FQNs of
     * same-short-name objects that DO exist (typically in other packages), so the author can
     * qualify a bare ref they meant to point across a package boundary. Returns "" when no
     * same-short-name object exists. Mirrors the TS {@code didYouMeanHint}.
     */
    private static String didYouMeanHint(MetaData node, String ref) {
        int sep = ref.lastIndexOf(MetaData.PKG_SEPARATOR);
        String shortName = (sep >= 0) ? ref.substring(sep + MetaData.PKG_SEPARATOR.length()) : ref;
        MetaData root = node;
        while (root.getParent() != null) root = root.getParent();
        StringBuilder candidates = new StringBuilder();
        for (MetaData child : root.getChildren(MetaData.class, false)) {
            if (!(child instanceof MetaObject)) continue;
            if (!shortName.equals(child.getShortName())) continue;
            if (candidates.length() > 0) candidates.append(", ");
            candidates.append(child.getName());
        }
        if (candidates.length() == 0) return "";
        return " An object named \"" + shortName + "\" exists in: " + candidates
            + ". Qualify it with its package (FQN).";
    }
}
