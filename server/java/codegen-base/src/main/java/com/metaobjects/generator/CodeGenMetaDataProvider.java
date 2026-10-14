package com.metaobjects.generator;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Code Generation MetaData provider that registers type extensions for code generation.
 *
 * <p>This provider holds the extension logic and constants itself, not the generators it serves,
 * so a generator copied out with {@code mvn metaobjects:eject} owns emit code only: the attributes
 * a loaded model may carry are metamodel vocabulary and stay with the loader. It supports JSON
 * Schema generation and AI documentation generation by extending existing MetaData types with
 * generation-specific attributes.</p>
 *
 * <h3>Generators Supported:</h3>
 * <ul>
 * <li><strong>MetaDataFileJsonSchemaGenerator:</strong> Attributes for JSON Schema generation</li>
 * <li><strong>MetaDataAIDocumentationGenerator:</strong> Attributes for AI documentation generation</li>
 * </ul>
 *
 * <h3>Priority:</h3>
 * <p>Priority 200 - Runs after database services (100-199) but before web services (300+).
 * This ensures that code generation attributes are available for web framework extensions.</p>
 *
 * @since 6.0.0
 */
public class CodeGenMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // Register JSON Schema generation type extensions
        registerJsonSchemaAttributes(registry);

        // Register AI Documentation generation type extensions
        registerAIDocAttributes(registry);
    }

    // JSON Schema generation attribute constants
    public static final String JSON_SCHEMA_VERSION = "jsonSchemaVersion";
    public static final String JSON_SCHEMA_ID = "jsonSchemaId";
    public static final String JSON_TITLE = "jsonTitle";
    public static final String JSON_DESCRIPTION = "jsonDescription";
    public static final String JSON_FORMAT = "jsonFormat";
    public static final String JSON_PATTERN = "jsonPattern";
    public static final String JSON_ENUM = "jsonEnum";
    public static final String JSON_MINIMUM = "jsonMinimum";
    public static final String JSON_MAXIMUM = "jsonMaximum";

    // AI Documentation generation attribute constants
    public static final String AI_VERSION = "aiVersion";
    public static final String AI_DESCRIPTION = "aiDescription";
    public static final String AI_BUSINESS_RULE = "aiBusinessRule";
    public static final String AI_USAGE_CONTEXT = "aiUsageContext";
    public static final String AI_VALIDATION_RULES = "aiValidationRules";
    public static final String AI_EXAMPLES = "aiExamples";
    public static final String AI_CONSTRAINTS = "aiConstraints";
    public static final String AI_EXTENSION_GUIDANCE = "aiExtensionGuidance";
    public static final String AI_CROSS_LANGUAGE_INFO = "aiCrossLanguageInfo";

    /**
     * Registers JSON Schema generation attributes for use by the service provider pattern.
     * Called by {@link #registerTypes} to extend existing MetaData types with JSON Schema-specific attributes.
     */
    public static void registerJsonSchemaAttributes(MetaDataRegistry registry) {
        // Object-level JSON Schema attributes
        registry.findType("object", "base")
            .optionalAttribute(JSON_SCHEMA_VERSION, "string")
            .optionalAttribute(JSON_SCHEMA_ID, "string")
            .optionalAttribute(JSON_TITLE, "string")
            .optionalAttribute(JSON_DESCRIPTION, "string")
            // Codegen object-level flags (template conditionals). Formerly registered on
            // object.pojo; moved to object.base so the entity/value subtypes inherit them
            // after the pojo/proxy/map subtype registrations were retired (ADR-0005).
            .optionalAttribute("hasAuditing", "boolean")
            .optionalAttribute("hasJpa", "boolean")
            .optionalAttribute("hasValidation", "boolean");

        // Field-level JSON Schema attributes
        registry.findType("field", "base")
            .optionalAttribute(JSON_TITLE, "string")
            .optionalAttribute(JSON_DESCRIPTION, "string")
            .optionalAttribute(JSON_FORMAT, "string")
            .optionalAttribute(JSON_PATTERN, "string")
            .optionalAttribute(JSON_ENUM, "string");

        registry.findType("field", "string")
            .optionalAttribute(JSON_PATTERN, "string")
            .optionalAttribute(JSON_FORMAT, "string");

        registry.findType("field", "int")
            .optionalAttribute(JSON_MINIMUM, "int")
            .optionalAttribute(JSON_MAXIMUM, "int");

        registry.findType("field", "long")
            .optionalAttribute(JSON_MINIMUM, "long")
            .optionalAttribute(JSON_MAXIMUM, "long");
    }

    /**
     * Registers AI Documentation generation attributes for use by the service provider pattern.
     * Called by {@link #registerTypes} to extend existing MetaData types with AI documentation-specific attributes.
     */
    public static void registerAIDocAttributes(MetaDataRegistry registry) {
        // Object-level AI Documentation attributes
        registry.findType("object", "base")
            .optionalAttribute(AI_VERSION, "string")
            .optionalAttribute(AI_DESCRIPTION, "string")
            .optionalAttribute(AI_BUSINESS_RULE, "string")
            .optionalAttribute(AI_USAGE_CONTEXT, "string")
            .optionalAttribute(AI_EXTENSION_GUIDANCE, "string")
            .optionalAttribute(AI_CROSS_LANGUAGE_INFO, "string");

        // Field-level AI Documentation attributes
        registry.findType("field", "base")
            .optionalAttribute(AI_DESCRIPTION, "string")
            .optionalAttribute(AI_BUSINESS_RULE, "string")
            .optionalAttribute(AI_USAGE_CONTEXT, "string")
            .optionalAttribute(AI_VALIDATION_RULES, "string")
            .optionalAttribute(AI_EXAMPLES, "string")
            .optionalAttribute(AI_CONSTRAINTS, "string");

        registry.findType("field", "string")
            .optionalAttribute(AI_EXAMPLES, "string")
            .optionalAttribute(AI_VALIDATION_RULES, "string");

        registry.findType("field", "int")
            .optionalAttribute(AI_CONSTRAINTS, "string")
            .optionalAttribute(AI_EXAMPLES, "string");
    }

    @Override
    public String getProviderId() {
        return "codegen-extensions";
    }

    @Override
    public String[] getDependencies() {
        // Depends on core types since it generates from field and object metadata
        return new String[]{"field-types", "object-types", "attribute-types"};
    }

    @Override
    public String getDescription() {
        return "Code Generation MetaData Provider - XSD, JSON Schema, and AI Documentation extensions";
    }
}