package com.metaobjects.template;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
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
     * Register the abstract {@code template.base} type. Carries zero attrs of its own
     * (only the any-attr wildcard, for extensibility from service providers); every
     * concrete subtype registers its own attrs directly (see below).
     *
     * <p>Called by {@link TemplateTypesMetaDataProvider}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaTemplate.class, def -> {
            def.type(TYPE_TEMPLATE).subType(SUBTYPE_BASE)
               .description("Abstract base template metadata — FR-004 cross-language prompt construction")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
               // ADR-0051 EXCEPTION, deliberately retained. Removing this wildcard trips
               // ERR_BAD_ATTR_VALUE on `abstract: true`: Java models isAbstract as an ATTR
               // (declared on metadata.base) while applyStrictAttrScoping prunes each type
               // to its spec-declared set, which for template.* does not include it. TS has
               // no such problem because isAbstract is a NATIVE FIELD on MetaData there, so
               // it never passes through attr scoping. Closing this door needs isAbstract
               // homed consistently across ports first -- see ADR-0051's deferred section.
               .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");

            // SP-G Unit 6a: the shared template attrs (@payloadRef / @textRef / @format /
            // @maxChars / @owner / @since / @requiredTags) are declared on the CONCRETE
            // subtypes (PromptTemplate / OutputTemplate), each carrying exactly its own set
            // with the correct required-ness — matching the cross-port canonical
            // (template.base is attr-free). template.toolcall does not inherit these at all
            // (it binds directly to metadata.base; see ToolcallTemplate).
        });
    }

    // These are OWN attrs, registered directly on each concrete subtype's own
    // registerTypes(...) (PromptTemplate / OutputTemplate / ToolcallTemplate) — never in
    // a composable concern provider. @payloadRef and @toolName are REQUIRED there: an
    // attribute a type is not meaningfully itself without belongs to the type's own
    // provider, always. A required attr living in a provider that can be composed out of
    // a build (e.g. metaobjects-prompt) would silently delete the required-attr rule
    // along with the provider — compose without it and the type would stay registered
    // with zero attrs, so ERR_MISSING_REQUIRED_ATTR would simply stop firing. See the
    // TS reference fix (commit 4e701247) this Java port mirrors.

    // -----------------------------------------------------------------------
    // Accessors — resolving attr reads (ADR-0039 default)
    //
    // ADR-0039: template.* is a registered type that can be an `extends` target, so
    // its attrs inherit — the resolving read (includeParentData=true, the default) is
    // correct, matching the TS reference + C# (which resolve template attrs). A
    // template's declared refs (@payloadRef/@textRef/@format/@maxChars/@owner/@since/
    // @requiredTags) resolve through the extends chain into an effective form.
    // -----------------------------------------------------------------------

    /** Returns the raw value of {@code @payloadRef}, or {@code null} if absent. */
    public String getPayloadRef() {
        return hasMetaAttr(ATTR_PAYLOAD_REF)
            ? getMetaAttr(ATTR_PAYLOAD_REF).getValueAsString()
            : null;
    }

    /** Returns the raw value of {@code @textRef}, or {@code null} if absent. */
    public String getTextRef() {
        return hasMetaAttr(ATTR_TEXT_REF)
            ? getMetaAttr(ATTR_TEXT_REF).getValueAsString()
            : null;
    }

    /**
     * Returns the value of {@code @format} if set, else {@link TemplateConstants#FORMAT_DEFAULT}.
     */
    public String getFormat() {
        if (!hasMetaAttr(ATTR_FORMAT)) return FORMAT_DEFAULT;
        String v = getMetaAttr(ATTR_FORMAT).getValueAsString();
        return v != null ? v : FORMAT_DEFAULT;
    }

    /** Returns the value of {@code @maxChars}, or {@code null} if absent. */
    public Integer getMaxChars() {
        if (!hasMetaAttr(ATTR_MAX_CHARS)) return null;
        // IntAttribute is parameterized on Integer; load-time conversion via
        // DataConverter guarantees getValue() is Integer or null here.
        return (Integer) getMetaAttr(ATTR_MAX_CHARS).getValue();
    }

    /** Returns the raw value of {@code @owner}, or {@code null} if absent. */
    public String getOwner() {
        return hasMetaAttr(ATTR_OWNER)
            ? getMetaAttr(ATTR_OWNER).getValueAsString()
            : null;
    }

    /** Returns the raw value of {@code @since}, or {@code null} if absent. */
    public String getSince() {
        return hasMetaAttr(ATTR_SINCE)
            ? getMetaAttr(ATTR_SINCE).getValueAsString()
            : null;
    }

    /** Returns the {@code @requiredTags} list, or {@code null} if absent. */
    public List<String> getRequiredTags() {
        if (!hasMetaAttr(ATTR_REQUIRED_TAGS)) return null;
        Object v = getMetaAttr(ATTR_REQUIRED_TAGS).getValue();
        if (v instanceof List<?> list) {
            List<String> out = new ArrayList<>(list.size());
            for (Object o : list) out.add(String.valueOf(o));
            return out;
        }
        return null;
    }
}
