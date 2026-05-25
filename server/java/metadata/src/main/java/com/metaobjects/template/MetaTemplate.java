package com.metaobjects.template;

import com.metaobjects.MetaData;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

import java.util.ArrayList;
import java.util.List;

import static com.metaobjects.template.TemplateConstants.*;

/**
 * Abstract base for the {@code template.*} metatype (FR-004 fourth pillar:
 * cross-language prompt construction). Concrete subtypes: {@link PromptTemplate}
 * ({@code template.prompt}) and {@link OutputTemplate} ({@code template.output}).
 *
 * <p>Shared attributes (both subtypes): {@code @payloadRef}, {@code @textRef},
 * {@code @format}, {@code @maxChars}, {@code @owner}, {@code @since},
 * {@code @requiredTags}. Subtype-specific attributes are declared on the
 * concrete subtype class.
 *
 * <p>Per-subtype required-attribute checks live in
 * {@code ValidationPhase#validateTemplates} (own-only, eager-throw), matching
 * the source/origin/relationship validation pattern.
 */
public abstract class MetaTemplate extends MetaData {

    protected MetaTemplate(String subType, String name) {
        super(TYPE_TEMPLATE, subType, name);
    }

    /**
     * Register the abstract {@code template.base} type. Declares the union of attrs
     * across all concrete subtypes as optional; per-subtype required-checks are
     * enforced in {@code ValidationPhase} (post-load, own-only).
     *
     * <p>Called by {@link TemplateTypesMetaDataProvider}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaTemplate.class, def -> {
            def.type(TYPE_TEMPLATE).subType(SUBTYPE_BASE)
               .description("Abstract base template metadata — FR-004 cross-language prompt construction")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
               // Accept any attr child (extensibility from service providers)
               .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");

            // Generic attrs (both subtypes)
            def.optionalAttributeWithConstraints(ATTR_PAYLOAD_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_TEXT_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            // @format — closed-set enum (Tier-1 invariant; see TemplateConstants.FORMAT_*
            // and TemplateConstants.ALLOWED_FORMATS). Enum-membership is enforced on the
            // concrete subtype (template.prompt / template.output) in
            // ValidationPhase#validateTemplates, matching the pattern used for source.rdb
            // @kind/@role and relationship.* @onDelete/@onUpdate (a withEnum constraint on
            // the abstract base type does not fire for concrete subtypes — see
            // CustomConstraint.applicabilityTest in AttributeConstraintBuilder).
            def.optionalAttributeWithConstraints(ATTR_FORMAT)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_MAX_CHARS)
               .ofType(IntAttribute.SUBTYPE_INT).asSingle();
            def.optionalAttributeWithConstraints(ATTR_OWNER)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_SINCE)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_REQUIRED_TAGS)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
        });
    }

    // -----------------------------------------------------------------------
    // Accessors — own-only attr reads (mirrors MetaOrigin's getFrom/getVia)
    // -----------------------------------------------------------------------

    /** Returns the raw value of {@code @payloadRef}, or {@code null} if absent. */
    public String getPayloadRef() {
        return hasMetaAttr(ATTR_PAYLOAD_REF, false)
            ? getMetaAttr(ATTR_PAYLOAD_REF, false).getValueAsString()
            : null;
    }

    /** Returns the raw value of {@code @textRef}, or {@code null} if absent. */
    public String getTextRef() {
        return hasMetaAttr(ATTR_TEXT_REF, false)
            ? getMetaAttr(ATTR_TEXT_REF, false).getValueAsString()
            : null;
    }

    /**
     * Returns the value of {@code @format} if set, else {@link TemplateConstants#FORMAT_DEFAULT}.
     */
    public String getFormat() {
        if (!hasMetaAttr(ATTR_FORMAT, false)) return FORMAT_DEFAULT;
        String v = getMetaAttr(ATTR_FORMAT, false).getValueAsString();
        return v != null ? v : FORMAT_DEFAULT;
    }

    /** Returns the value of {@code @maxChars}, or {@code null} if absent. */
    public Integer getMaxChars() {
        if (!hasMetaAttr(ATTR_MAX_CHARS, false)) return null;
        // IntAttribute is parameterized on Integer; load-time conversion via
        // DataConverter guarantees getValue() is Integer or null here.
        return (Integer) getMetaAttr(ATTR_MAX_CHARS, false).getValue();
    }

    /** Returns the raw value of {@code @owner}, or {@code null} if absent. */
    public String getOwner() {
        return hasMetaAttr(ATTR_OWNER, false)
            ? getMetaAttr(ATTR_OWNER, false).getValueAsString()
            : null;
    }

    /** Returns the raw value of {@code @since}, or {@code null} if absent. */
    public String getSince() {
        return hasMetaAttr(ATTR_SINCE, false)
            ? getMetaAttr(ATTR_SINCE, false).getValueAsString()
            : null;
    }

    /** Returns the {@code @requiredTags} list, or {@code null} if absent. */
    public List<String> getRequiredTags() {
        if (!hasMetaAttr(ATTR_REQUIRED_TAGS, false)) return null;
        Object v = getMetaAttr(ATTR_REQUIRED_TAGS, false).getValue();
        if (v instanceof List<?> list) {
            List<String> out = new ArrayList<>(list.size());
            for (Object o : list) out.add(String.valueOf(o));
            return out;
        }
        return null;
    }
}
