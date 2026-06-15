package com.metaobjects.template;

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

            // FR-033: the shared template attrs (@payloadRef [REQUIRED] / @textRef /
            // @format / @maxChars / @owner / @since / @requiredTags) and the prompt
            // overlay (@maxTokens / @requiredSlots / @model / @responseRef) are
            // re-homed to the metaobjects-prompt concern provider (reads
            // spec/metamodel/prompt.json's template.prompt extends). The any-attr
            // wildcard is inherited from template.base. Accessors below read the
            // attr values at runtime, independent of where the schema is registered.
        });
    }

    /** Returns the {@code @requiredSlots} list, or {@code null} if absent. */
    public List<String> getRequiredSlots() {
        if (!hasMetaAttr(ATTR_REQUIRED_SLOTS, false)) return null;
        Object v = getMetaAttr(ATTR_REQUIRED_SLOTS, false).getValue();
        if (v instanceof List<?> list) {
            List<String> out = new ArrayList<>(list.size());
            for (Object o : list) out.add(String.valueOf(o));
            return out;
        }
        return null;
    }

    /** Returns the value of {@code @maxTokens}, or {@code null} if absent. */
    public Integer getMaxTokens() {
        if (!hasMetaAttr(ATTR_MAX_TOKENS, false)) return null;
        // IntAttribute is parameterized on Integer; load-time conversion via
        // DataConverter guarantees getValue() is Integer or null here.
        return (Integer) getMetaAttr(ATTR_MAX_TOKENS, false).getValue();
    }

    /** Returns the raw value of {@code @model}, or {@code null} if absent. */
    public String getModel() {
        return hasMetaAttr(ATTR_MODEL, false)
            ? getMetaAttr(ATTR_MODEL, false).getValueAsString()
            : null;
    }

    /** Returns the raw value of {@code @responseRef}, or {@code null} if absent. */
    public String getResponseRef() {
        return hasMetaAttr(ATTR_RESPONSE_REF, false)
            ? getMetaAttr(ATTR_RESPONSE_REF, false).getValueAsString()
            : null;
    }
}
