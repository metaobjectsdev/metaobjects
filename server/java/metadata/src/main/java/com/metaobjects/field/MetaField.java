/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.field;

import com.metaobjects.*;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.constraint.PlacementConstraint;
import com.metaobjects.constraint.RegexConstraint;
import com.metaobjects.util.DataConverter;
import com.metaobjects.origin.MetaOrigin;
import com.metaobjects.validator.MetaValidator;
import com.metaobjects.validator.MetaValidatorNotFoundException;
import com.metaobjects.view.MetaView;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.TypeDefinition;
import com.metaobjects.registry.ChildRequirement;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.*;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * MetaField represents a field definition within a MetaObject, functioning as both 
 * a metadata descriptor and a type-safe accessor for object properties.
 * 
 * <p>MetaField follows the same <strong>READ-OPTIMIZED WITH CONTROLLED MUTABILITY</strong> 
 * pattern as other MetaData objects. Field definitions are loaded once during application 
 * startup and then provide ultra-fast, thread-safe access to object properties throughout 
 * the application lifetime.</p>
 * 
 * <strong>Field as Metadata Pattern</strong>:
 * <p>Similar to {@code java.lang.reflect.Field}, MetaField serves dual purposes:</p>
 * <ul>
 * <li><strong>Metadata Descriptor</strong>: Defines field name, type, validation rules, display preferences</li>
 * <li><strong>Value Accessor</strong>: Type-safe getter/setter operations on object instances</li>
 * <li><strong>Validation Engine</strong>: Enforces data integrity through constraint system</li>
 * <li><strong>Serialization Guide</strong>: Controls JSON/XML serialization behavior</li>
 * </ul>
 * 
 * <strong>Usage Examples</strong>:
 * <pre>{@code
 * // Loading Phase - Field definition
 * MetaObject userMeta = loader.getMetaObjectByName("User");
 * MetaField<String> emailField = userMeta.getMetaField("email");
 * 
 * // Runtime Phase - Value operations (thread-safe, high-performance)
 * String email = emailField.getValue(userObject);           // Type-safe get
 * emailField.setValue(userObject, "user@example.com");      // Type-safe set
 * boolean isValid = emailField.validate(userObject);        // Constraint validation
 * }</pre>
 * 
 * <strong>Type Safety</strong>:
 * <p>MetaField is parameterized with the expected Java type {@code <T>} for compile-time 
 * type safety. This prevents ClassCastException and provides IDE support for auto-completion.</p>
 * 
 * <strong>Performance Characteristics</strong>:
 * <ul>
 * <li><strong>Field Lookup</strong>: O(1) cached access from parent MetaObject</li>
 * <li><strong>Value Access</strong>: Direct reflection or optimized accessors</li>
 * <li><strong>Validation</strong>: Cached constraint evaluation</li>
 * <li><strong>Memory</strong>: Permanent field definitions, no per-instance overhead</li>
 * </ul>
 * 
 * @param <T> the Java type that this field represents (String, Integer, etc.)
 * @author Doug Mealing
 * @version 6.0.0
 * @since 1.0
 * @see MetaObject
 * @see DataTypes
 * @see com.metaobjects.constraint.Constraint
 */
public abstract class MetaField<T> extends MetaData  implements DataTypeAware<T> {

    private static final Logger log = LoggerFactory.getLogger(MetaField.class);

    // === TYPE AND SUBTYPE CONSTANTS ===
    /** Field type constant - MetaField owns this concept */
    public static final String TYPE_FIELD = "field";

    /** Base field subtype for inheritance */
    public static final String SUBTYPE_BASE = "base";

    // === FIELD-LEVEL ATTRIBUTE NAME CONSTANTS ===
    // These apply to ALL field types and are inherited by concrete field implementations

    /** Required field marker attribute - MetaField owns this concept */
    public static final String ATTR_REQUIRED = "required";

    /** Default value specification attribute - MetaField owns this concept */
    public static final String ATTR_DEFAULT_VALUE = "defaultValue";

    /**
     * The generalized {@code @default} attribute (string) — the absent-fill default for ANY
     * field type. When the field is ABSENT from a model response, tolerant extract fills this
     * value (coerced to the field's kind) and classifies the field {@code DEFAULTED} (which
     * satisfies {@code required}); it is also the single source consumed by
     * {@link com.metaobjects.object.MetaObject#setDefaultValues(Object)} at {@code newInstance}
     * time. Generalized from FR-011's enum-only {@code @default}. Loader-validated per field
     * type (numeric parse, boolean {@code true|false}, enum membership). Distinct from the
     * framework's legacy {@code @defaultValue} (column default), which {@link #getDefaultValue()}
     * still honors as a fallback for back-compat.
     * Cross-language vocabulary: {@code @default} in canonical JSON.
     */
    public static final String ATTR_DEFAULT = "default";

    /** Default view specification attribute - MetaField owns this concept */
    public static final String ATTR_DEFAULT_VIEW = "defaultView";

    // === CROSS-PORT LOGICAL FIELD ATTRIBUTES (SP-G) ===
    // These are part of the cross-port logical vocabulary the registry-conformance
    // canonical declares on EVERY field subtype (registered on field.base, inherited
    // by all concrete field subtypes via the inheritsFrom snapshot). They are
    // additive in SP-G Unit 4 — the parallel physical db* attrs coexist until the
    // Unit 7 physical-vocabulary convergence.

    /** FR-013: read-only field marker (boolean). */
    public static final String ATTR_READ_ONLY = "readOnly";

    /** Auto-set policy (string) — when/how the runtime auto-populates the field. */
    public static final String ATTR_AUTO_SET = "autoSet";

    /** Project D: field is filterable in generated query endpoints (boolean). */
    public static final String ATTR_FILTERABLE = "filterable";

    /** Project D: field is sortable in generated query endpoints (boolean). */
    public static final String ATTR_SORTABLE = "sortable";

    /** Project D: default sort order for a sortable field (string: asc / desc). */
    public static final String ATTR_SORTABLE_DEFAULT_ORDER = "sortableDefaultOrder";

    /** Logical "this column is indexed" marker (boolean). Cross-port key {@code db.indexed}. */
    public static final String ATTR_DB_INDEXED = "db.indexed";

    /** Logical max length (int) — cross-port name (peer of the physical dbLength). */
    public static final String ATTR_MAX_LENGTH = "maxLength";

    /** Logical numeric precision (int). */
    public static final String ATTR_PRECISION = "precision";

    /** Logical numeric scale (int). */
    public static final String ATTR_SCALE = "scale";

    /** Logical uniqueness marker (boolean). */
    public static final String ATTR_UNIQUE = "unique";

    /** Storage shape for owned-object data (string: flattened / jsonb / subdocument). */
    public static final String ATTR_STORAGE = "storage";

    /** Object-reference target for object-valued fields (string). */
    public static final String ATTR_OBJECT_REF = "objectRef";

    /** Physical column name (string). Cross-port name {@code column}. */
    public static final String ATTR_COLUMN = "column";

    /** Physical column-type escape hatch (string). Cross-port name {@code dbColumnType}. */
    public static final String ATTR_DB_COLUMN_TYPE = "dbColumnType";

    /** Universal array modifier - any field can be an array */
    public static final String ATTR_IS_ARRAY = "isArray";

    /**
     * Optional free-text example for this field — FR-010 output-format prompt fragment.
     * Surfaces as a concrete usage sample in the generated prompt fragment.
     */
    public static final String ATTR_EXAMPLE = "example";

    /**
     * Optional free-text instruction for this field — FR-010 output-format prompt fragment.
     * Provides LLM-facing guidance on how to populate the field.
     */
    public static final String ATTR_INSTRUCTION = "instruction";

    // === KEY-RELATED ATTRIBUTES DEPRECATED ===
    // These attributes have been moved to MetaIdentity (v6.2.7+)
    // Use MetaIdentity instead of field-level key attributes

    // Unified registry self-registration
    /**
     * Register MetaField types using the standardized registerTypes() pattern.
     * This method registers the base field type that other field types inherit from.
     *
     * @param registry The MetaDataRegistry to register with
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(MetaField.class, def -> {
                def.type(TYPE_FIELD).subType(SUBTYPE_BASE)
                   .description("Base field metadata with common field attributes")
                   // ACCEPTS ANY ATTRIBUTES, VALIDATORS, VIEWS, AND ORIGINS (all field types inherit these)
                   .optionalChild(MetaAttribute.TYPE_ATTR, "*")
                   .optionalChild(MetaValidator.TYPE_VALIDATOR, "*")
                   .optionalChild(MetaView.TYPE_VIEW, "*")
                   .optionalChild(MetaOrigin.TYPE_ORIGIN, "*");

                // FIELD-SPECIFIC ATTRIBUTES WITH FLUENT CONSTRAINTS
                def.optionalAttributeWithConstraints(ATTR_IS_ABSTRACT)
                   .ofType(BooleanAttribute.SUBTYPE_BOOLEAN)
                   .asSingle();

                // Allow flexible attribute types for defaultValue to support value-based detection
                def.optionalChild(MetaAttribute.TYPE_ATTR, ATTR_DEFAULT_VALUE);

                def.optionalAttributeWithConstraints(ATTR_DEFAULT_VIEW)
                   .ofType(StringAttribute.SUBTYPE_STRING)
                   .asSingle();

                def.optionalAttributeWithConstraints(ATTR_IS_ARRAY)
                   .ofType(BooleanAttribute.SUBTYPE_BOOLEAN)
                   .asSingle();

                // FR-010 teaching attrs — optional on any field subtype (inherited via field.base)
                def.optionalAttributeWithConstraints(ATTR_EXAMPLE)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
                def.optionalAttributeWithConstraints(ATTR_INSTRUCTION)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

                // Phase B: generalized @default absent-fill string — optional on ANY field
                // subtype (inherited via field.base). Per-type value validation (numeric parse,
                // boolean true|false, enum membership) runs post-load in ValidationPhase
                // (ERR_BAD_ATTR_VALUE). Generalized from FR-011's enum-only @default.
                def.optionalAttributeWithConstraints(ATTR_DEFAULT)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

                // === SP-G cross-port logical field attrs (declared on EVERY field
                // subtype via the field.base inheritance snapshot). Registered here
                // (pre-snapshot) so they propagate to all concrete subtypes — the
                // registry-conformance canonical declares them on every field row.
                // The `required` marker is ALSO enforced via a placement constraint;
                // it is declared here as a named attr so it surfaces in the manifest.

                def.optionalAttributeWithConstraints(ATTR_REQUIRED)
                   .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
                def.optionalAttributeWithConstraints(ATTR_READ_ONLY)
                   .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
                def.optionalAttributeWithConstraints(ATTR_AUTO_SET)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
                def.optionalAttributeWithConstraints(ATTR_FILTERABLE)
                   .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
                def.optionalAttributeWithConstraints(ATTR_SORTABLE)
                   .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
                def.optionalAttributeWithConstraints(ATTR_SORTABLE_DEFAULT_ORDER)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
                def.optionalAttributeWithConstraints(ATTR_DB_INDEXED)
                   .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
                def.optionalAttributeWithConstraints(ATTR_MAX_LENGTH)
                   .ofType(IntAttribute.SUBTYPE_INT).asSingle();
                def.optionalAttributeWithConstraints(ATTR_PRECISION)
                   .ofType(IntAttribute.SUBTYPE_INT).asSingle();
                def.optionalAttributeWithConstraints(ATTR_SCALE)
                   .ofType(IntAttribute.SUBTYPE_INT).asSingle();
                def.optionalAttributeWithConstraints(ATTR_UNIQUE)
                   .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
                def.optionalAttributeWithConstraints(ATTR_STORAGE)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
                def.optionalAttributeWithConstraints(ATTR_OBJECT_REF)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
                def.optionalAttributeWithConstraints(ATTR_COLUMN)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
                def.optionalAttributeWithConstraints(ATTR_DB_COLUMN_TYPE)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            });

            log.debug("Registered base MetaField type with unified registry");

            // Register cross-cutting field constraints using consolidated registry
            registerCrossCuttingFieldConstraints(registry);

        } catch (Exception e) {
            log.error("Failed to register MetaField type with unified registry", e);
        }
    }


    private T defaultValue = null;
    private boolean lookedForDefault = false;

    private int length = -1;

    private DataTypes dataType;

    /** Native isArray property - whether this field represents an array of values */
    private boolean isArray = false;
    
    


    /**
     * Construct a MetaField with enhanced validation and metrics
     * @param subtype SubType name for the MetaField
     * @param name Name of the MetaField
     * @param dataType The DataTypes enum used for values
     */
    public MetaField(String subtype, String name, DataTypes dataType) {
        super(TYPE_FIELD, subtype, name);
        this.dataType = dataType;
        
        log.debug("Created MetaField: {}:{}:{} with dataType: {}", TYPE_FIELD, subtype, name, dataType);
    }


    // Note: getMetaDataClass() is now inherited from MetaData base class

    /**
     * Returns the specific MetaClass in which this class is declared.<br>
     * WARNING: This may not return the MetaClass from which this MetaField was retrieved.
     *
     * @return The declaring MetaClass
     */
    public MetaObject getDeclaringObject() {
        if ( getParent() instanceof MetaRoot) return null;
        if ( getParent() instanceof MetaObject ) return (MetaObject) getParent();
        throw new InvalidMetaDataException(this, "MetaFields can only be attached to MetaObjects " +
                "or the metadata root as abstracts");
    }

    /**
     * Sets the Super Field
     * @param superField the super field to set for this field
     */
    public void setSuperField(MetaField superField) {
        setSuperData(superField);
    }

    /**
     * Gets the Super Field
     * @return the super field for this field, or null if none set
     */
    public MetaField getSuperField() {
        return (MetaField) getSuperData();
    }

    /**
     * Sets an attribute of the MetaClass
     */
    //public MetaField addMetaAttr(MetaAttribute attr) {
    //    return addChild(attr);
    //}

    /**
     * Get an ObjectReference for the MetaField
     */
    //public ObjectReference getFirstObjectReference() {
    //    return (ObjectReference) getFirstChildOfType(ObjectReference.TYPE_OBJECTREF);
    //}


    /**
     * Gets the default field value
     * @return the default value for this field, or null if none set
     */
    public T getDefaultValue() {

        if ( defaultValue == null && !lookedForDefault ) {

            // Phase B unification: the generalized @default (MetaField.ATTR_DEFAULT) is the
            // single absent-fill default source shared by tolerant extract and newInstance-time
            // population (MetaObject.setDefaultValues). It is preferred; the legacy @defaultValue
            // (column default) remains a fallback for back-compat.
            if (hasMetaAttr(MetaField.ATTR_DEFAULT)) {
                Object o = getMetaAttr(MetaField.ATTR_DEFAULT).getValue();
                defaultValue = convertDefaultValue(o);
            } else if (hasMetaAttr(MetaField.ATTR_DEFAULT_VALUE)) {
                Object o = getMetaAttr(MetaField.ATTR_DEFAULT_VALUE).getValue();
                defaultValue = convertDefaultValue(o);
            }

            lookedForDefault = true;
        }

        return defaultValue;
    }

    /**
     * Converts the provided object to the field's value type
     * @param o the object to convert
     * @return the converted value of type T
     */
    protected T convertDefaultValue(Object o) {
        if (!getValueClass().isInstance(o)) {
            // Convert as needed
            return DataConverter.toTypeSafe(getDataType(), o, (Class<T>) getValueClass());
        } else {
            return (T) o;
        }
    }

    // === KEY-RELATED ACCESSOR METHODS ===

    // === DEPRECATED KEY METHODS ===
    // These methods have been deprecated in favor of MetaIdentity (v6.2.7+)
    // Use MetaObject.getIdentities() or MetaObject.getPrimaryIdentity() instead

    /**
     * @deprecated Use MetaObject.getSecondaryIdentities() instead
     */
    @Deprecated
    public boolean isSecondaryKey() {
        // For backward compatibility, check if this field is part of any secondary identity
        return isPartOfSecondaryIdentity();
    }

    // === NEW IDENTITY-AWARE METHODS ===

    /**
     * Returns true if this field is part of the primary identity.
     */
    public boolean isPartOfPrimaryIdentity() {
        if (getParent() instanceof com.metaobjects.object.MetaObject) {
            com.metaobjects.object.MetaObject metaObject = (com.metaobjects.object.MetaObject) getParent();
            return metaObject.getIdentities().stream()
                .filter(identity -> identity.isPrimary())
                .anyMatch(identity -> identity.getFields().contains(getName()));
        }
        return false;
    }

    /**
     * Returns true if this field is part of any secondary identity.
     */
    public boolean isPartOfSecondaryIdentity() {
        if (getParent() instanceof com.metaobjects.object.MetaObject) {
            com.metaobjects.object.MetaObject metaObject = (com.metaobjects.object.MetaObject) getParent();
            return metaObject.getIdentities().stream()
                .filter(identity -> identity.isSecondary())
                .anyMatch(identity -> identity.getFields().contains(getName()));
        }
        return false;
    }

    /**
     * Returns true if this field is part of any identity (primary or secondary).
     */
    public boolean isPartOfAnyIdentity() {
        return isPartOfPrimaryIdentity() || isPartOfSecondaryIdentity();
    }

    /** Flush the caches and set local flags to false */
    @Override
    protected void flushCaches() {
        lookedForDefault = false;
        super.flushCaches();
    }

    /**
     * Returns the type of value
     */
    @Override
    public DataTypes getDataType() {
        return dataType;
    }

    /**
     * Gets the type of value object class returned
     * @return the Java class type for values of this field
     */
    public Class<?> getValueClass() {
        return getDataType().getValueClass();
    }
    
    // ========== ENHANCED FIELD-SPECIFIC METHODS ==========
    
    /**
     * Get the expected Java class type for a given attribute on this field type.
     * This method consults the MetaDataRegistry to determine what Java type an
     * attribute should be converted to during parsing.
     *
     * @param attributeName the name of the attribute (e.g., "required", "maxLength", "column")
     * @return the expected Java class for the attribute, or String.class if not found
     */
    public Class<?> getExpectedAttributeType(String attributeName) {

        try {
            MetaDataRegistry registry = getLoader().getTypeRegistry();

            // Get the type definition for this specific field type
            TypeDefinition typeDef = registry.getTypeDefinition(this.getType(), this.getSubType());
            if (typeDef != null) {
                // Look up the child requirement for this attribute
                ChildRequirement attrReq = typeDef.getChildRequirement(attributeName);
                if (attrReq != null && MetaAttribute.TYPE_ATTR.equals(attrReq.getExpectedType())) {
                    // Map the attribute subType to Java class
                    return mapAttributeSubTypeToJavaClass(attrReq.getExpectedSubType());
                }
            }

            // Fallback to String for unknown attributes
            return String.class;

        } catch (Exception e) {
            log.debug("Registry lookup failed for attribute [{}] on [{}], defaulting to String: {}",
                attributeName, this.getClass().getSimpleName(), e.getMessage());
            return String.class;
        }
    }

    /**
     * Map attribute subType to Java class for type-safe parsing.
     * This method maps the registry's attribute subType definitions to actual Java classes.
     *
     * @param subType The subType from the registry (e.g., "boolean", "int", "string")
     * @return Java class for the subType, defaults to String.class
     */
    private Class<?> mapAttributeSubTypeToJavaClass(String subType) {
        if (subType == null) {
            return String.class;
        }

        switch (subType.toLowerCase()) {
            case "boolean":
                return Boolean.class;
            case "int":
            case "integer":
                return Integer.class;
            case "long":
                return Long.class;
            case "double":
                return Double.class;
            case "float":
                return Float.class;
            case "string":
            default:
                return String.class;
        }
    }
    
    
    
    /**
     * Safe default value getter with Optional wrapper
     * @return Optional containing the default value, or empty if none set
     */
    public Optional<T> getDefaultValueSafe() {
        return Optional.ofNullable(getDefaultValue());
    }
    
    /**
     * Check if this field has a default value
     * @return true if this field has a default value, false otherwise
     */
    public boolean hasDefaultValue() {
        return getDefaultValue() != null;
    }
    
    /**
     * Enhanced setDefaultValue with validation and tracking
     * @param defVal the default value to set for this field
     */
    public void setDefaultValueEnhanced(T defVal) {
        Instant start = Instant.now();
        T oldValue = this.defaultValue;
        
        try {
            // Set the default value directly (replaces the removed deprecated method)
            this.defaultValue = defVal;
            
            if (defVal != null && !getValueClass().isInstance(defVal)) {
                // Convert as needed
                this.defaultValue = DataConverter.toTypeSafe(getDataType(), defVal, (Class<T>) getValueClass());
            }
            
            
            log.debug("MetaField {} default value changed from {} to {}", getName(), oldValue, defVal);
            
        } catch (Exception e) {
            
            log.error("Failed to set default value for MetaField {}: {}", getName(), e.getMessage(), e);
            throw e; // Re-throw to maintain existing behavior
        }
    }

    // === UNIVERSAL ARRAY SUPPORT METHODS ===

    /**
     * Check if this field is configured as an array type.
     * @return true if @isArray=true is set on this field, false otherwise
     */
    public boolean isArrayType() {
        // Prefer the native flag (set by the canonical parser for structural
        // `isArray: true`) and fall back to a child MetaAttribute for callers
        // that may set the attribute directly.
        if (isArray) return true;
        if (hasMetaAttr(ATTR_IS_ARRAY)) {
            MetaAttribute attr = getMetaAttr(ATTR_IS_ARRAY);
            String value = attr.getValueAsString();
            if ("true".equalsIgnoreCase(value)) return true;
            if ("false".equalsIgnoreCase(value)) return false;
            return Boolean.parseBoolean(value);
        }
        return false;
    }

    /**
     * Get the effective data type for this field, considering array modifier.
     * @return array equivalent if @isArray=true, otherwise the base data type
     */
    public DataTypes getEffectiveDataType() {
        if (isArrayType()) {
            return getDataType().getArrayEquivalent();
        }
        return getDataType();
    }

    /**
     * Get the effective value class for this field, considering array modifier.
     * @return List.class if @isArray=true, otherwise the base value class
     */
    public Class<?> getEffectiveValueClass() {
        if (isArrayType()) {
            return java.util.List.class;
        }
        return getValueClass();
    }


    /** Add Child to the Field */
    //@Override
    //public MetaField addChild(MetaData data) throws InvalidMetaDataException {
    //    return super.addChild( data );
    //}

    /** Wrap the MetaField */
    //@Override
    //public MetaField overload() {
    //    return super.overload();
    //}

    /**
     * Sets the object attribute represented by this MetaField
     * @param obj the object to set the attribute on
     * @param val the value to set for the attribute
     */
    protected void setObjectAttribute(Object obj, Object val) {

        // Ensure the data types are accurate
        if (val != null && !getValueClass().isInstance(val))
            throw new InvalidValueException("Invalid value [" + val + "], expected class [" + getValueClass().getName() + "]");

        // Perform validation -- Disabled for performance reasons
        //performValidation( obj, val );

        // Set the value on the object
        getDeclaringObject().setValue(this, obj, val);
    }

    /**
     * Gets the object attribute represented by this MetaField
     * @param obj the object to get the attribute from
     * @return the value of the attribute for the specified object
     */
    protected Object getObjectAttribute(Object obj) {
        return getObjectValue(obj);
    }

    /**
     * Gets the object attribute represented by this MetaField
     */
    private Object getObjectValue(Object obj) {
        Object val = getDeclaringObject().getValue(this, obj);
        if (!getValueClass().isInstance(val)) {
            val = DataConverter.toType(dataType, val);
        }
        return val;
    }

    // === ARRAY SUPPORT METHODS ===

    /**
     * Indicates whether this field type supports array functionality.
     * Default implementation returns true - derivative classes can override to restrict.
     *
     * @return true if this field type can be an array, false otherwise
     */
    public boolean supportsArrays() {
        return true; // Most field types support arrays by default
    }

    /**
     * Get whether this field represents an array of values.
     *
     * @return true if this field is an array type
     */
    public boolean isArray() {
        return isArray;
    }

    /**
     * Set whether this field represents an array of values.
     *
     * @param isArray true if this field should be an array type
     * @throws UnsupportedOperationException if arrays are not supported by this field type
     */
    public void setArray(boolean isArray) {
        if (isArray && !supportsArrays()) {
            throw new UnsupportedOperationException(
                "Field type " + getSubType() + " does not support arrays");
        }
        this.isArray = isArray;
    }

    ////////////////////////////////////////////////////
    // VIEW METHODS

    /**
     * Whether the named MetaView exists
     */
    public boolean hasView(String name) {
        return findView(name).isPresent();
    }

    /**
     * Adds a MetaView to this MetaField
     *
     * @param <T> the type of MetaField to return
     * @param view MetaView to add
     * @return this MetaField instance for method chaining
     */
    public <T extends MetaField> T addMetaView(MetaView view) {
        addChild(view);
        return (T) this;
    }

    /**
     * Adds a MetaView to this MetaField (type-safe version)
     * @param view MetaView to add
     * @return This MetaField instance for method chaining
     */
    public MetaField<T> addMetaViewSafe(MetaView view) {
        addChild(view);
        return this;
    }

    /**
     * Adds a MetaView to this MetaField
     *
     * @param view MetaView to add
     */
    public void addView(MetaView view) {
        addChild(view);
    }

    public Collection<MetaView> getViews() {
        return getChildren(MetaView.class, true);
    }

    public MetaView getDefaultView() {
        if (hasMetaAttr(ATTR_DEFAULT_VIEW))
            return getView(getMetaAttr(ATTR_DEFAULT_VIEW).getValueAsString());
        else
            return getFirstChild(MetaView.class);
    }

    public MetaView getView(String name) {
        try {
            return (MetaView) getChild(name, MetaView.class);
        } catch (MetaDataNotFoundException e) {
            throw MetaDataNotFoundException.forView(name, this);
        }
    }

    /**
     * Find a MetaView by name using modern Optional-based API.
     * 
     * <p>This method provides safe, null-free access to views associated with this field.
     * Views control how field values are displayed, formatted, or rendered in different contexts.</p>
     * 
     * @param name the name of the view to find
     * @return Optional containing the MetaView if found, empty Optional otherwise
     * @since 5.1.0
     * @see #requireView(String)
     * @see #hasView(String)
     */
    public Optional<MetaView> findView(String name) {
        return findChild(name, MetaView.class);
    }

    /**
     * Require a MetaView by name, throwing an exception if not found.
     * 
     * <p>This method is useful when you know a view must exist and want to fail fast
     * if it's missing. Use {@link #findView(String)} for safer optional access.</p>
     * 
     * @param name the name of the view to retrieve
     * @return the MetaView with the specified name
     * @throws MetaDataNotFoundException if no view with the given name exists
     * @since 5.1.0
     * @see #findView(String)
     */
    public MetaView requireView(String name) {
        return findView(name)
            .orElseThrow(() -> MetaDataNotFoundException.forView(name, this));
    }

    /**
     * Get all views associated with this field as a Stream for functional operations.
     * 
     * <p>This method enables functional programming patterns like filtering, mapping,
     * and collecting views based on various criteria.</p>
     * 
     * <p><b>Example usage:</b><br>
     * {@code field.getViewsStream().filter(v -> v.isType("html")).collect(toList())}</p>
     * 
     * @return Stream of all MetaView objects associated with this field
     * @since 5.1.0
     * @see #getViews()
     */
    public Stream<MetaView> getViewsStream() {
        return findChildren(MetaView.class);
    }

    ////////////////////////////////////////////////////
    // VALIDATOR METHODS

    /**
     * Performs validation on the specified object
     * @param obj the object to validate
     */
    public void performValidation(Object obj) {
        if ( obj != null ) {
            performValidation(obj, getObjectAttribute(obj));
        } else {
            throw new InvalidValueException("Cannot perform validation on a null object: "+toString());
        }
    }

    protected void performValidation(Object obj, Object val)  {
        // Run the default
        getDefaultValidatorList().forEach(v -> v.validate(obj, val));
    }

    /**
     * Returns all validators attached to this MetaField.
     * Validation is now calculated based on actual MetaValidator children,
     * eliminating the need for explicit validation attribute configuration.
     *
     * @return List of validators to use for default validation checks
     */
    public List<MetaValidator> getDefaultValidatorList() {

        return useCache( "getDefaultValidatorList()", () -> {
                // Always use all MetaValidator children - no more attribute-based validation
                return getValidators();
            });
    }

    /**
     * Whether the named MetaValidator exists
     * @param name the name of the validator to check for
     * @return true if a validator with the specified name exists, false otherwise
     */
    public boolean hasValidator(String name) {
        return findValidator(name).isPresent();
    }

    public void addMetaValidator(MetaValidator validator) {
        flushCaches();
        addChild(validator);
    }

    public List<MetaValidator> getValidators() {
        return getChildren(MetaValidator.class, true);
    }

    /**
     * This method returns the list of validators based on the
     * comma delimited string name provided
     * @param listAttr comma-delimited string of validator names
     * @return list of MetaValidator objects matching the specified names
     */
    public List<MetaValidator> getValidatorList(String listAttr)
    {
        return useCache( "getValidatorList()", listAttr, list -> {

            List<MetaValidator> validators = new ArrayList<MetaValidator>();
            while (list != null) {

                String validator = null;

                int i = list.indexOf(',');
                if (i >= 0) {
                    validator = list.substring(0, i).trim();
                    list = list.substring(i + 1);
                } else {
                    validator = list.trim();
                    list = null;
                }

                if (validator.length() > 0)
                    validators.add(getValidator(validator));
            }
            return validators;
        });
    }


    public MetaValidator getValidator(String validatorName) {
        return useCache( "getValidator()", validatorName, name -> {
            return (MetaValidator) getChild(name, MetaValidator.class);
        });
    }

    /**
     * Find a MetaValidator by name using modern Optional-based API.
     * 
     * <p>This method provides safe, null-free access to validators associated with this field.
     * Validators are used to enforce business rules and data integrity constraints on field values.</p>
     * 
     * @param name the name of the validator to find
     * @return Optional containing the MetaValidator if found, empty Optional otherwise
     * @since 5.1.0
     * @see #requireValidator(String)
     * @see #hasValidator(String)
     */
    public Optional<MetaValidator> findValidator(String name) {
        return findChild(name, MetaValidator.class);
    }

    /**
     * Require a MetaValidator by name, throwing an exception if not found.
     * 
     * <p>This method is useful when you know a validator must exist and want to fail fast
     * if it's missing. Use {@link #findValidator(String)} for safer optional access.</p>
     * 
     * @param name the name of the validator to retrieve
     * @return the MetaValidator with the specified name
     * @throws MetaValidatorNotFoundException if no validator with the given name exists
     * @since 5.1.0
     * @see #findValidator(String)
     */
    public MetaValidator requireValidator(String name) {
        return findValidator(name)
            .orElseThrow(() -> new MetaValidatorNotFoundException(
                "MetaValidator '" + name + "' not found in MetaField '" + getName() + "'", name));
    }

    /**
     * Get all validators associated with this field as a Stream for functional operations.
     * 
     * <p>This method enables functional programming patterns for working with validators,
     * such as filtering by type, collecting specific validators, or applying transformations.</p>
     * 
     * <p><b>Example usage:</b><br>
     * {@code field.getValidatorsStream().filter(v -> v.isRequired()).count()}</p>
     * 
     * @return Stream of all MetaValidator objects associated with this field
     * @since 5.1.0
     * @see #getValidators()
     */
    public Stream<MetaValidator> getValidatorsStream() {
        return findChildren(MetaValidator.class);
    }

    
    
    

    ////////////////////////////////////////////////////
    // OBJECT SETTER METHODS

    /**
     * Sets a Boolean value on the specified object
     * @param obj the object to set the value on
     * @param value the Boolean value to set
     */
    public void setBoolean(Object obj, Boolean value){
        setObject(obj, value );
    }

    public void setByte(Object obj, Byte value){
        setObject(obj, value );
    }

    public void setShort(Object obj, Short value){
        setObject(obj, value );
    }

    public void setInt(Object obj, Integer value){
        setObject(obj, value );
    }

    public void setLong(Object obj, Long value){
        setObject(obj, value );
    }

    public void setFloat(Object obj, Float value ){
        setObject(obj, value );
    }

    public void setDouble(Object obj, Double value){
        setObject(obj, value );
    }

    public void setDecimal(Object obj, java.math.BigDecimal value){
        setObject(obj, value );
    }

    public void setString(Object obj, String value) {
        setObject(obj, value );
    }

    public void setStringArray(Object obj, List<String> value) {
        setObject(obj, value );
    }

    public void setDate(Object obj, Date value) {
        setObject(obj, value );
    }

    public void setObject(Object obj, Object value) {
        setObjectAttribute(obj, DataConverter.toType(getDataType(), value ));
    }

    public void setObjectArray(Object obj, List<?> value) {
        // Support both old OBJECT_ARRAY type and new universal @isArray pattern
        if ( getDataType() != DataTypes.OBJECT_ARRAY && !isArrayType() ) throw new InvalidValueException(
                "Cannot set List to non ObjectArray type ["+getDataType()+"] and field is not marked as array type" );
        setObjectAttribute(obj, value);
    }

    public void addToObjectArray(Object o, Object value) {
        if ( value == null ) return;
        List<Object> values = getObjectArray(o);
        if ( values == null ) {
            values = new ArrayList<>();
            setObjectArray(o,values);
        }
        values.add( value );
    }


    ////////////////////////////////////////////////////
    // OBJECT GETTER METHODS

    /**
     * Gets a Boolean value from the specified object
     * @param obj the object to get the value from
     * @return the Boolean value from the object
     */
    public Boolean getBoolean(Object obj) {
        return DataConverter.toBoolean(getObjectAttribute(obj));
    }

    public Byte getByte(Object obj) {
        return DataConverter.toByte(getObjectAttribute(obj));
    }

    public Short getShort(Object obj) {
        return DataConverter.toShort(getObjectAttribute(obj));
    }

    public Integer getInt(Object obj) {
        return DataConverter.toInt(getObjectAttribute(obj));
    }

    public Long getLong(Object obj) {
        return DataConverter.toLong(getObjectAttribute(obj));
    }

    public Float getFloat(Object obj) {
        return DataConverter.toFloat(getObjectAttribute(obj));
    }

    public Double getDouble(Object obj) {
        return DataConverter.toDouble(getObjectAttribute(obj));
    }

    public java.math.BigDecimal getDecimal(Object obj) {
        return DataConverter.toBigDecimal(getObjectAttribute(obj));
    }

    public String getString(Object obj) {
        return DataConverter.toString(getObjectAttribute(obj));
    }

    public List<String> getStringArray(Object obj) {
        return DataConverter.toStringArray(getObjectAttribute(obj));
    }

    public Date getDate(Object obj) {
        return DataConverter.toDate(getObjectAttribute(obj));
    }

    public Object getObject(Object obj) {
        return getObjectAttribute(obj);
    }

    public List<Object> getObjectArray(Object obj) {
        return DataConverter.toObjectArray(getObjectAttribute(obj));
    }

    ////////////////////////////////////////////////////
    // MISC METHODS

    /** Clone the MetaField */
    @Override
    public Object clone() {
        MetaField mf = (MetaField) super.clone();
        mf.defaultValue = defaultValue;
        mf.lookedForDefault = lookedForDefault;
        mf.length = length;
        return mf;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        if (!super.equals(o)) return false;
        MetaField<?> metaField = (MetaField<?>) o;
        return length == metaField.length &&
                Objects.equals(defaultValue, metaField.defaultValue) &&
                dataType == metaField.dataType;
    }

    @Override
    public int hashCode() {
        return Objects.hash(super.hashCode(), defaultValue, length, dataType);
    }

    /** Get the toString Prefix */
    @Override
    protected String getToStringPrefix() {
        return  super.getToStringPrefix() + "{dataType=" + dataType + ", defaultValue=" + defaultValue + "}";
    }
    
    /**
     * Register cross-cutting field constraints that apply to all field types using consolidated registry
     *
     * @param registry The MetaDataRegistry to use for constraint registration
     */
    private static void registerCrossCuttingFieldConstraints(MetaDataRegistry registry) {
        try {

            // PLACEMENT CONSTRAINT: All fields CAN have required attribute
            registry.addConstraint(PlacementConstraint.allowAttributeOnAnyField(
                "field.required.placement",
                "Fields can optionally have required attribute",
                BooleanAttribute.SUBTYPE_BOOLEAN, ATTR_REQUIRED
            ));

            // VALIDATION CONSTRAINT: Field names must follow identifier pattern
            registry.addConstraint(new RegexConstraint(
                "field.naming.pattern",
                "Field names must follow identifier pattern",
                "field",                    // Target type
                "*",                        // Any subtype
                "*",                        // Any field name
                "^[a-zA-Z][a-zA-Z0-9_]*$",  // Identifier pattern
                false                       // Don't allow null (required)
            ));
            log.debug("Registered cross-cutting field constraints using consolidated registry");

        } catch (Exception e) {
            log.error("Failed to register cross-cutting field constraints", e);
        }
    }
}
