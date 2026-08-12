package com.metaobjects.registry;

import com.metaobjects.MetaDataTypeId;

/**
 * Builder for extending existing MetaData types with new attributes and child requirements.
 *
 * <p>This class enables service providers to add optional attributes and child requirements
 * to existing types without modifying the original type definitions. It's used by the
 * service provider pattern to extend types with service-specific attributes.</p>
 *
 * <strong>Usage Pattern:</strong>:
 * <pre>{@code
 * // Service provider extending string fields with database attributes
 * registry.findType("field", "string")
 *     .optionalAttribute("column", "string")
 *     .optionalAttribute("maxLength", "int")
 *     .optionalChild("validator", "required", "*");
 * }</pre>
 *
 * @since 6.0.0
 */
public class TypeExtensionBuilder {

    private final MetaDataRegistry registry;
    private final TypeDefinition existingDefinition;
    private final MetaDataTypeId typeId;
    private final TypeDefinitionBuilder builder;

    /**
     * Create extension builder for an existing type definition.
     *
     * @param registry The registry that owns the type
     * @param existingDefinition The existing type definition to extend
     * @param typeId The type identifier
     */
    public TypeExtensionBuilder(MetaDataRegistry registry, TypeDefinition existingDefinition, MetaDataTypeId typeId) {
        this.registry = registry;
        this.existingDefinition = existingDefinition;
        this.typeId = typeId;
        this.builder = TypeDefinitionBuilder.from(existingDefinition);
    }

    /**
     * Add an optional attribute to the type.
     *
     * @param name The attribute name
     * @param attributeType The attribute type (e.g., "string", "int", "boolean")
     * @return This builder for method chaining
     */
    public TypeExtensionBuilder optionalAttribute(String name, String attributeType) {
        builder.optionalAttribute(name, attributeType);
        updateRegistration();
        return this;
    }

    /**
     * Add a required attribute to the type.
     *
     * <p><strong>ADR-0050:</strong> this builder only ever reaches an already-registered
     * type (it is constructed from {@link MetaDataRegistry#findType} against an
     * {@code existingDefinition}), so anything added through it is, by construction, a
     * PROJECTION onto a type this call site does not own. A concern provider can be
     * composed out; a required attr arriving this way makes the target type's validity
     * depend on that optional provider, and the failure is silent — the type stays
     * registered while its required-attr rule simply stops firing. If the attr is
     * genuinely required, it is OWN and belongs with the type, in the type's own
     * provider (this is exactly how FR-033 broke {@code template.*}'s
     * {@code @payloadRef} / {@code @toolName}). Always throws {@code ERR_EXTEND_REQUIRED_ATTR}.
     *
     * @param name The attribute name
     * @param attributeType The attribute type (e.g., "string", "int", "boolean")
     * @return never returns
     * @throws com.metaobjects.MetaDataException always, with code {@code ERR_EXTEND_REQUIRED_ATTR}
     */
    public TypeExtensionBuilder requiredAttribute(String name, String attributeType) {
        throw new com.metaobjects.MetaDataException(
            "TypeExtensionBuilder.requiredAttribute: attribute '" + name + "' being added to "
                + typeId.toQualifiedName() + " is REQUIRED. A provider may only project OPTIONAL "
                + "attributes onto a type it does not own — a required attr registered this way "
                + "disappears, silently, whenever that provider is composed out. Declare it with the "
                + "type instead (ADR-0050).",
            com.metaobjects.ErrorCode.ERR_EXTEND_REQUIRED_ATTR);
    }

    /**
     * Add an optional child requirement to the type.
     *
     * @param childType The child type (e.g., "field", "validator")
     * @param childSubType The child subtype (e.g., "string", "*" for any)
     * @param childName The child name pattern (e.g., "required", "*" for any)
     * @return This builder for method chaining
     */
    public TypeExtensionBuilder optionalChild(String childType, String childSubType, String childName) {
        builder.optionalChild(childType, childSubType, childName);
        updateRegistration();
        return this;
    }

    /**
     * Add a required child requirement to the type.
     *
     * @param childType The child type (e.g., "field", "validator")
     * @param childSubType The child subtype (e.g., "string", "*" for any)
     * @param childName The child name pattern (e.g., "required", "*" for any)
     * @return This builder for method chaining
     */
    public TypeExtensionBuilder requiredChild(String childType, String childSubType, String childName) {
        builder.requiredChild(childType, childSubType, childName);
        updateRegistration();
        return this;
    }

    /**
     * Add multiple optional attributes at once.
     *
     * @param attributeType The common attribute type for all attributes
     * @param attributeNames The attribute names to add
     * @return This builder for method chaining
     */
    public TypeExtensionBuilder optionalAttributes(String attributeType, String... attributeNames) {
        for (String attributeName : attributeNames) {
            builder.optionalAttribute(attributeName, attributeType);
        }
        updateRegistration();
        return this;
    }

    /**
     * Add an attribute with a default value.
     *
     * @param name The attribute name
     * @param attributeType The attribute type
     * @param defaultValue The default value as a string
     * @return This builder for method chaining
     */
    public TypeExtensionBuilder optionalAttributeWithDefault(String name, String attributeType, String defaultValue) {
        builder.optionalAttribute(name, attributeType);
        // Note: Default value handling would need to be added to TypeDefinitionBuilder if needed
        updateRegistration();
        return this;
    }

    /**
     * Update the type registration in the registry with current extensions.
     */
    private void updateRegistration() {
        try {
            // Build the extended type definition
            TypeDefinition extendedDefinition = builder.build();

            // Update the registry with the extended definition
            registry.register(extendedDefinition);

        } catch (com.metaobjects.MetaDataException e) {
            // ADR-0023: a sealed-registry violation is a HARD failure (the
            // registration-time gate — codegen must not invent metamodel attrs
            // post-bootstrap). Propagate it rather than swallowing it. Other
            // MetaDataExceptions also propagate (a malformed extension is a real bug).
            throw e;
        } catch (Exception e) {
            // Log warning but don't fail - service provider pattern should be resilient
            System.err.println("Warning: Failed to extend type " + typeId + ": " + e.getMessage());
        }
    }

    /**
     * Get the type identifier being extended.
     *
     * @return The MetaDataTypeId
     */
    public MetaDataTypeId getTypeId() {
        return typeId;
    }

    /**
     * Get a description of the type being extended.
     *
     * @return Description string
     */
    public String getDescription() {
        return existingDefinition.getDescription();
    }

    /**
     * Check if this type extends another type.
     *
     * @return True if the type has a parent type
     */
    public boolean hasParentType() {
        return existingDefinition.getParentType() != null;
    }

    /**
     * Get the parent type identifier if this type extends another.
     *
     * @return Parent type identifier, or null if no parent
     */
    public String getParentType() {
        return existingDefinition.getParentType();
    }
}