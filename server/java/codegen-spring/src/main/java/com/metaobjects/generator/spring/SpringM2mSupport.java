package com.metaobjects.generator.spring;

import com.metaobjects.MetaRoot;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.relationship.M2MFields;
import com.metaobjects.relationship.MetaRelationship;

import java.util.ArrayList;
import java.util.List;

/**
 * FR-018 M:N codegen support — resolves the many-to-many relationships declared
 * on an entity into the data the Spring generators need to emit navigation
 * (controller traversal endpoint + repository finder).
 *
 * <p>A M:N relationship is a {@code relationship.*} child with
 * {@code @cardinality: "many"} that declares {@code @through} (the junction
 * entity). The junction FK columns are NOT restated on the relationship — they
 * are DERIVED from the junction entity's two {@code identity.reference}
 * children via the cross-port SSOT {@link M2MFields#derive}. This helper is the
 * codegen-side mirror of the OMDB runtime {@code M2MResolver}: it surfaces the
 * same derived {@code (sourceField, targetField, symmetric)} so the emitted
 * route + repository finder traverse the junction with identical semantics to
 * the runtime resolver and the cross-port REST contract.</p>
 *
 * <p>The cross-port REST contract (see
 * {@code fixtures/api-contract-conformance/m2m/README.md}):</p>
 * <pre>
 *   GET {prefix}/&lt;source-plural&gt;/:id/&lt;relationName&gt;  -&gt;  the related target rows
 * </pre>
 * The source URL segment is the source entity name pluralized
 * ({@code Person} → {@code persons}); the relation segment is the relationship
 * {@code name}; related-row order is not contractual.
 */
public final class SpringM2mSupport {

    private SpringM2mSupport() { /* no instances */ }

    /**
     * One resolved M:N navigation on a source entity.
     *
     * @param relationName     the relationship {@code name} (the URL relation segment + finder stem)
     * @param targetShortName  the target entity short name (e.g. {@code Tag})
     * @param targetDtoType    the target DTO type name, package-qualified when the
     *                         target lives in a different package than the source
     * @param junctionShortName the junction (through) entity short name (e.g. {@code PostTag})
     * @param sourceField      the junction FK field holding the source key (derived)
     * @param targetField      the junction FK field holding the target key (derived)
     * @param symmetric        {@code true} for an undirected self-join (union-on-read)
     */
    public record M2mNav(
        String relationName,
        String targetShortName,
        String targetDtoType,
        String junctionShortName,
        String sourceField,
        String targetField,
        boolean symmetric) {}

    /**
     * Resolve every M:N relationship declared on {@code entity}. Returns an empty
     * list when the entity declares none. Each entry's junction FK fields are
     * derived from the junction's {@code identity.reference} children.
     *
     * @param entity the source entity
     * @param loader the loader (for the model root, to find junction + target entities)
     * @return the resolved M:N navigations, in declaration order
     */
    public static List<M2mNav> resolve(MetaObject entity, MetaDataLoader loader) {
        MetaRoot root = loader.getRoot();
        String sourcePkg = SpringNaming.splitFqn(entity.getName())[0];
        List<M2mNav> out = new ArrayList<>();
        for (MetaRelationship rel : entity.getRelationships()) {
            if (!MetaRelationship.CARDINALITY_MANY.equals(rel.getCardinality())) continue;
            String through = rel.getThrough();
            if (through == null || through.isEmpty()) continue;

            M2MFields fields = M2MFields.derive(rel, entity, root);

            MetaObject target = findEntity(root, rel.getObjectRef());
            MetaObject junction = findEntity(root, through);
            if (target == null || junction == null) continue;

            String[] targetSplit = SpringNaming.splitFqn(target.getName());
            String targetPkg = targetSplit[0];
            String targetShort = targetSplit[1];
            // Qualify the DTO type only when the target lives in a different package
            // than the source controller/repository (avoids an unqualified cross-package
            // reference that would not compile).
            String targetDto = targetPkg.equals(sourcePkg) || targetPkg.isEmpty()
                ? targetShort + "Dto"
                : targetPkg + "." + targetShort + "Dto";

            String junctionShort = SpringNaming.splitFqn(junction.getName())[1];

            out.add(new M2mNav(
                rel.getShortName(),
                targetShort,
                targetDto,
                junctionShort,
                fields.getSourceField(),
                fields.getTargetField(),
                rel.isSymmetric()));
        }
        return out;
    }

    private static MetaObject findEntity(MetaRoot root, String name) {
        if (name == null) return null;
        // ADR-0041: a FULLY-QUALIFIED ref (contains "::") resolves EXACTLY on the
        // object's package-qualified name — it never falls back to a bare-tail match
        // (the closed bug: an FQN @objectRef / @through binding a same-named object
        // in the WRONG package). A bare ref matches the object's short name (first
        // match wins; cross-package same-package-preference is the deferred codegen
        // follow-up, mirroring the TS residual note).
        boolean fqn = name.indexOf("::") >= 0;
        // ADR-0039: root-level entity scan — root is never extended, so own children
        // is correct (entities are declared directly under root, not inherited into it).
        for (MetaObject mo : root.getChildren(MetaObject.class, false)) {
            if (fqn ? name.equals(mo.getName()) : name.equals(mo.getShortName())) return mo;
        }
        return null;
    }
}
