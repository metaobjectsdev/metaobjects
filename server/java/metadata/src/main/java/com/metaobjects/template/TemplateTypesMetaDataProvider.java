package com.metaobjects.template;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Template Types MetaData provider.
 *
 * <p>Registers the abstract {@code template.base} type plus the three concrete
 * subtypes {@code template.prompt}, {@code template.output} (FR-004 fourth
 * pillar: cross-language prompt construction) and {@code template.toolcall}
 * (ADR-0011: LLM tool-call envelope). Depends on {@code core-types} for
 * {@code metadata.base} inheritance.</p>
 *
 * <p>Discovered via the standard {@link MetaDataTypeProvider} ServiceLoader
 * mechanism — wired through
 * {@code META-INF/services/com.metaobjects.registry.MetaDataTypeProvider}.</p>
 */
public class TemplateTypesMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // Register abstract base type first (declares the union of shared attrs).
        MetaTemplate.registerTypes(registry);

        // Register concrete template subtypes.
        PromptTemplate.registerTypes(registry);
        OutputTemplate.registerTypes(registry);
        // ADR-0011 — toolcall is a sibling subtype that does NOT inherit
        // template.base's shared attrs (no @textRef requirement; the body IS
        // the structured output schema resolved via @payloadRef).
        ToolcallTemplate.registerTypes(registry);

        // Root-level acceptance for template.* is declared on metadata.root in
        // MetaRoot's static initializer alongside object/field/attr/validator/view/
        // identity/relationship — templates are a top-level metadata type.

        // FR-033: the @xmlText field-extract marker (formerly extended onto every
        // registered field subtype here) is re-homed to the metaobjects-prompt
        // concern provider (reads spec/metamodel/prompt.json's field.* extends),
        // alongside the rest of the prompt-construction attrs. This provider now
        // registers ONLY the template TYPE definitions; their attrs are owned by
        // metaobjects-prompt.
    }

    @Override
    public String getProviderId() {
        return "template-types";
    }

    @Override
    public String[] getDependencies() {
        // core-types for metadata.base inheritance (the template TYPE definitions).
        return new String[]{"core-types"};
    }

    @Override
    public String getDescription() {
        return "Template Types (prompt / output / toolcall — FR-004 + ADR-0011 cross-language prompt construction)";
    }
}
