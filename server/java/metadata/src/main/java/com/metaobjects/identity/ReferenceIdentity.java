package com.metaobjects.identity;

import com.metaobjects.MetaData;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static com.metaobjects.object.MetaObject.ATTR_DESCRIPTION;

/**
 * Reference identity — declares that this entity has fields whose value(s)
 * identify an instance of another entity.
 *
 * Paradigm-neutral: maps to SQL foreign key, document linked reference,
 * graph edge target, or OO pointer/reference. The metamodel itself does
 * not commit to a backend implementation.
 *
 * Attributes:
 * - {@code @fields} — column(s) on THIS entity that hold the reference value(s).
 * - {@code @references} — target entity. Bare name (e.g. "Program") resolves to
 *   the target's primary identity. Dotted forms ("Program.id" or
 *   "Program.fieldA,fieldB") target an explicit field set on that entity.
 * - {@code @enforce} — optional boolean (default true). When true the backend
 *   physically enforces the reference (SQL FK constraint, document validation
 *   rule, graph edge guarantee). Set false for navigation/typing/codegen-only
 *   references that may dangle at the backend level.
 *
 * Parallel to TypeScript's {@code MetaReferenceIdentity} in
 * {@code @metaobjectsdev/metadata}.
 */
public class ReferenceIdentity extends MetaIdentity {

    private static final Logger log = LoggerFactory.getLogger(ReferenceIdentity.class);

    /**
     * Create a reference identity with the specified name.
     * The subType is automatically set to "reference".
     */
    public ReferenceIdentity(String name) {
        super(SUBTYPE_REFERENCE, name);
    }

    /**
     * Register ReferenceIdentity type with the MetaDataRegistry.
     * Called by IdentityTypesMetaDataProvider during service discovery.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(ReferenceIdentity.class, def -> {
            def.type(TYPE_IDENTITY).subType(SUBTYPE_REFERENCE)
               .description("Reference identity — fields on this entity that identify an instance of another entity")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);

            // @fields + @references are REQUIRED on identity.reference (cross-port canonical).
            def.requiredAttributeWithConstraints(ATTR_FIELDS).ofType(StringAttribute.SUBTYPE_STRING).asArray();
            def.requiredAttributeWithConstraints(ATTR_REFERENCES).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_ENFORCE).ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
            def.optionalAttributeWithConstraints(ATTR_DESCRIPTION).ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // NOTE: @onDelete / @onUpdate are NOT declared on identity.reference in the
            // cross-port canonical — referential-action vocabulary lives only on
            // relationship.composition. (Removed in SP-G Unit 6a to match the canonical.)

            // ACCEPTS ANY ATTRIBUTES (for extensibility from service providers)
            def.optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");
        });
    }

    /**
     * Raw {@code @references} attr value, unparsed. Null when the attr is absent.
     */
    public String getReferencesRaw() {
        return hasMetaAttr(ATTR_REFERENCES) ?
               getMetaAttr(ATTR_REFERENCES).getValueAsString() : null;
    }

    /**
     * Target entity name — the segment before the first dot in {@code @references},
     * or the whole value when bare. Null if the attr is absent.
     */
    public String getTargetEntity() {
        String raw = getReferencesRaw();
        if (raw == null) return null;
        int dot = raw.indexOf('.');
        return dot == -1 ? raw : raw.substring(0, dot);
    }

    /**
     * Target field names parsed from the dotted form. Empty list when {@code @references}
     * is bare (meaning "use the target entity's primary identity"). Multi-element when
     * the dotted form lists comma-separated fields (compound FK).
     */
    public List<String> getTargetFields() {
        String raw = getReferencesRaw();
        if (raw == null) return Collections.emptyList();
        int dot = raw.indexOf('.');
        if (dot == -1) return Collections.emptyList();
        String suffix = raw.substring(dot + 1);
        List<String> out = new ArrayList<>();
        for (String part : suffix.split(",")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) out.add(trimmed);
        }
        return out;
    }

    /**
     * Whether the reference is physically enforced by the backend.
     * Default true (hard FK constraint emitted). Explicit {@code @enforce: false}
     * marks the reference as logical-only — codegen skips physical constraints.
     *
     * The attr is registered as {@link BooleanAttribute#SUBTYPE_BOOLEAN}; the loader
     * coerces values to a {@link Boolean} so the attr's raw value is either {@code null}
     * (absent) or a {@link Boolean}. Default-true semantics: absent → true; only
     * explicit {@code Boolean.TRUE} keeps the reference enforced.
     */
    public boolean isEnforced() {
        if (!hasMetaAttr(ATTR_ENFORCE)) return true;
        return Boolean.TRUE.equals(getMetaAttr(ATTR_ENFORCE).getValue());
    }

    @Override
    public String toString() {
        return String.format("%s[%s:%s]{%s -> %s}%s",
            getClass().getSimpleName(),
            getType(),
            getSubType(),
            getName(),
            getReferencesRaw(),
            isEnforced() ? "" : " [SOFT]");
    }
}
