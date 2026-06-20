package com.metaobjects.loader.validation;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.object.MetaObject;
import com.metaobjects.relationship.MetaRelationship;

import java.util.List;

/**
 * The single recursive walk that backs {@code root.validate(ctx)}. Per node: apply declared
 * reference descriptors (generic resolution against the symbol table), then invoke the
 * registered imperative validators, then recurse. The logic lives in the registered rules,
 * not on the node classes — so it ports identically to the data-oriented ports and a
 * downstream provider extends it without touching core. Phase 2 prototype.
 */
public final class RegisteredValidation {

    private RegisteredValidation() {}

    /** Run the registry over the tree and COLLECT all findings. */
    public static List<ValidationError> run(MetaRoot root, ValidationRegistry registry) {
        ValidationContext ctx = new ValidationContext(SymbolTable.build(root));
        walk(root, registry, ctx);
        return ctx.errors();
    }

    private static void walk(MetaData node, ValidationRegistry registry, ValidationContext ctx) {
        String type = node.getType();
        String subType = node.getSubType();
        if (type != null && subType != null) {
            for (ReferenceDescriptor desc : registry.referencesFor(type, subType)) {
                if (!node.hasMetaAttr(desc.attr(), false)) continue;
                String raw = node.getMetaAttr(desc.attr(), false).getValueAsString();
                if (raw == null || raw.isEmpty()) continue; // absence is the required-attr pass's job
                int dot = raw.indexOf('.');
                String entityRef = (desc.dottedFieldPath() && dot >= 0) ? raw.substring(0, dot) : raw;
                MetaObject target = ctx.symbols().resolveObject(entityRef);
                if (target == null) {
                    ctx.error(desc.errorCode(), node,
                        type + "." + subType + " \"" + node.getShortName() + "\" @"
                            + desc.attr() + " \"" + raw + "\" does not resolve to an object.");
                } else if (!target.getType().equals(desc.targetType())
                        || (desc.targetSubType() != null && !target.getSubType().equals(desc.targetSubType()))) {
                    String want = desc.targetSubType() != null
                        ? desc.targetType() + "." + desc.targetSubType() : desc.targetType();
                    ctx.error(desc.errorCode(), node,
                        type + "." + subType + " \"" + node.getShortName() + "\" @" + desc.attr()
                            + " \"" + raw + "\" resolves to " + target.getType() + "." + target.getSubType()
                            + ", not a " + want + ".");
                }
            }
            for (NodeValidator v : registry.validatorsFor(type, subType)) {
                v.validate(node, ctx);
            }
        }
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walk(child, registry, ctx);
        }
    }

    /** The core providers' built-in reference descriptors, declared as data. */
    public static ValidationRegistry defaultRegistry() {
        return new ValidationRegistry()
            .registerReference(MetaRelationship.TYPE_RELATIONSHIP, ValidationRegistry.SUBTYPE_ANY,
                new ReferenceDescriptor(MetaRelationship.ATTR_OBJECT_REF, MetaObject.TYPE_OBJECT,
                    null, false, "ERR_INVALID_RELATIONSHIP"))
            .registerReference(MetaIdentity.TYPE_IDENTITY, MetaIdentity.SUBTYPE_REFERENCE,
                new ReferenceDescriptor(MetaIdentity.ATTR_REFERENCES, MetaObject.TYPE_OBJECT,
                    null, true, "ERR_INVALID_REFERENCE"));
    }
}
