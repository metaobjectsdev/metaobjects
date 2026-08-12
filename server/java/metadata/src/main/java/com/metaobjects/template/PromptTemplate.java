package com.metaobjects.template;

import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

import java.util.ArrayList;
import java.util.List;

import static com.metaobjects.template.TemplateConstants.*;

/**
 * LLM-targeted template ({@code template.prompt}) — FR-004.
 *
 * <p>In addition to the shared {@link MetaTemplate} attributes, prompts carry
 * the LLM overlay: {@code @maxTokens}, {@code @requiredSlots}, {@code @model}.
 */
public final class PromptTemplate extends MetaTemplate {

    public PromptTemplate(String name) {
        super(SUBTYPE_PROMPT, name);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(PromptTemplate.class, def -> {
            def.type(TYPE_TEMPLATE).subType(SUBTYPE_PROMPT)
               .description("Template (LLM prompt) — FR-004")
               .inheritsFrom(TYPE_TEMPLATE, SUBTYPE_BASE);

            // OWN attrs, registered here — never in a composable concern provider —
            // because @payloadRef is REQUIRED (see MetaTemplate's note on why a
            // required attr must never live somewhere that can be composed out).
            // Matches spec/metamodel/template.json's template.prompt declaration
            // exactly. The any-attr wildcard is inherited from template.base.

            // Shared reference + governance attrs (peer of template.output's set).
            def.requiredAttributeWithConstraints(ATTR_PAYLOAD_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_TEXT_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_FORMAT)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(FORMAT_TEXT, FORMAT_HTML, FORMAT_XML, FORMAT_CSV,
                         FORMAT_JSON, FORMAT_MARKDOWN, FORMAT_SPREADSHEET);
            def.optionalAttributeWithConstraints(ATTR_MAX_CHARS)
               .ofType(IntAttribute.SUBTYPE_INT).asSingle();
            def.optionalAttributeWithConstraints(ATTR_OWNER)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_SINCE)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_REQUIRED_TAGS)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();

            // LLM overlay (template.prompt only).
            def.optionalAttributeWithConstraints(ATTR_MAX_TOKENS)
               .ofType(IntAttribute.SUBTYPE_INT).asSingle();
            def.optionalAttributeWithConstraints(ATTR_REQUIRED_SLOTS)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
            def.optionalAttributeWithConstraints(ATTR_MODEL)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_RESPONSE_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }

    // ADR-0039: template.* attrs (@requiredSlots/@maxTokens/@model/@responseRef) resolve
    // through extends (includeParentData=true, the default) — a template is a registered
    // type that can be an `extends` target, matching the TS reference + C#.

    /** Returns the {@code @requiredSlots} list, or {@code null} if absent. */
    public List<String> getRequiredSlots() {
        if (!hasMetaAttr(ATTR_REQUIRED_SLOTS)) return null;
        Object v = getMetaAttr(ATTR_REQUIRED_SLOTS).getValue();
        if (v instanceof List<?> list) {
            List<String> out = new ArrayList<>(list.size());
            for (Object o : list) out.add(String.valueOf(o));
            return out;
        }
        return null;
    }

    /** Returns the value of {@code @maxTokens}, or {@code null} if absent. */
    public Integer getMaxTokens() {
        if (!hasMetaAttr(ATTR_MAX_TOKENS)) return null;
        // IntAttribute is parameterized on Integer; load-time conversion via
        // DataConverter guarantees getValue() is Integer or null here.
        return (Integer) getMetaAttr(ATTR_MAX_TOKENS).getValue();
    }

    /** Returns the raw value of {@code @model}, or {@code null} if absent. */
    public String getModel() {
        return hasMetaAttr(ATTR_MODEL)
            ? getMetaAttr(ATTR_MODEL).getValueAsString()
            : null;
    }

    /** Returns the raw value of {@code @responseRef}, or {@code null} if absent. */
    public String getResponseRef() {
        return hasMetaAttr(ATTR_RESPONSE_REF)
            ? getMetaAttr(ATTR_RESPONSE_REF).getValueAsString()
            : null;
    }
}
