package com.metaobjects.loader.validation;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.TypeDefinition;

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
        walk(root, registry, ctx);
        return ctx.errors();
    }

    private static void walk(MetaData node, MetaDataRegistry registry, ValidationContext ctx) {
        String type = node.getType();
        String subType = node.getSubType();
        if (type != null && subType != null) {
            TypeDefinition def = registry.getTypeDefinition(type, subType);
            if (def != null) {
                for (ReferenceDescriptor desc : def.getReferences()) {
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
                if (def.getValidator() != null) {
                    def.getValidator().validate(node, ctx);
                }
            }
        }
        for (MetaData child : node.getChildren(MetaData.class, false)) {
            walk(child, registry, ctx);
        }
    }
}
