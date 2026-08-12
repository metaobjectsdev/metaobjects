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
        // Register abstract base type first (template.base is attr-free — only the
        // any-attr wildcard).
        MetaTemplate.registerTypes(registry);

        // Register concrete template subtypes. Each registers its OWN attrs inline
        // (including the required @payloadRef / @toolName) — never in a composable
        // concern provider, so a required-attr check can never be silently dropped
        // by omitting an optional provider from a build.
        PromptTemplate.registerTypes(registry);
        OutputTemplate.registerTypes(registry);
        // ADR-0011 — toolcall is a sibling subtype that does NOT inherit
        // template.base's shared attrs (no @textRef requirement; the body IS
        // the structured output schema resolved via @payloadRef).
        ToolcallTemplate.registerTypes(registry);

        // Root-level acceptance for template.* is declared on metadata.root in
        // MetaRoot's static initializer alongside object/field/attr/validator/view/
        // identity/relationship — templates are a top-level metadata type.

        // The @xmlText field-extract marker (a PROJECTION of the prompt concern onto
        // field.*, not intrinsic to template.*) stays homed in the metaobjects-prompt
        // concern provider (reads spec/metamodel/prompt.json's field.* extends).
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
