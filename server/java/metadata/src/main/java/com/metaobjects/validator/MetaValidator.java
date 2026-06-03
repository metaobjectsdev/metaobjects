/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Draagon Software
 * LLC. Use is subject to license terms.
 */
package com.metaobjects.validator;

import com.metaobjects.InvalidMetaDataException;
import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.field.MetaField;
import com.metaobjects.util.MetaDataUtil;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * MetaValidator that performs validations on a MetaField
 */
public abstract class MetaValidator extends MetaData {

    private static final Logger log = LoggerFactory.getLogger(MetaValidator.class);

    public final static String TYPE_VALIDATOR = "validator";
    public final static String SUBTYPE_BASE = "base";

    /** Cross-port minimum-bound attribute ({@code @min}). */
    public final static String ATTR_MIN = "min";
    /** Cross-port maximum-bound attribute ({@code @max}). */
    public final static String ATTR_MAX = "max";

    /**
     * Register this type with the MetaDataRegistry (called by provider)
     * @param registry the MetaDataRegistry to register with
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaValidator.class, def -> {
            def.type(TYPE_VALIDATOR).subType(SUBTYPE_BASE)
               .description("Base validator metadata with common validator attributes")
               .inheritsFrom("metadata", "base")
               .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");

            // VALIDATOR-SPECIFIC ATTRIBUTES WITH FLUENT CONSTRAINTS
            def.optionalAttributeWithConstraints(ATTR_IS_ABSTRACT)
               .ofType(BooleanAttribute.SUBTYPE_BOOLEAN)
               .asSingle();

            // Cross-port numeric-bound attrs declared on the base validator
            // (subtypes that interpret them re-declare with their own semantics).
            def.optionalAttributeWithConstraints(ATTR_MIN)
               .ofType(IntAttribute.SUBTYPE_INT)
               .asSingle();
            def.optionalAttributeWithConstraints(ATTR_MAX)
               .ofType(IntAttribute.SUBTYPE_INT)
               .asSingle();
        });
    }

    public MetaValidator(String subtype, String name) {
        super(TYPE_VALIDATOR, subtype, name);
    }

    // Note: getMetaDataClass() is now inherited from MetaData base class

    /** Add Child to the MetaValidator */
    //public MetaValidator addChild(MetaData data) throws InvalidMetaDataException {
    //    return super.addChild( data );
    //}

    /** Wrap the MetaValidator */
    //public MetaValidator overload() {
    //    return super.overload();
    //}

    /**
     * Sets an attribute of the MetaClass
     */
    //public MetaValidator addMetaAttr(MetaAttribute attr) {
    //    return addChild(attr);
    //}

    /**
     * Gets the declaring meta field.<br>
     * NOTE: This may not be the MetaField from which the view
     * was retrieved, so be careful!
     * @return the MetaField that declares this validator, or null if attached to the metadata root
     */
    public MetaField getDeclaringMetaField() {
        if ( getParent() instanceof MetaRoot) return null;
        if ( getParent() instanceof MetaField ) return (MetaField) getParent();
        throw new InvalidMetaDataException(this, "MetaValidators can only be attached to MetaFields " +
                "or the metadata root as abstracts");
    }

    /**
     * Retrieves the MetaField for this view associated
     * with the specified object.
     * @param obj the object to get the MetaField for
     * @return the MetaField associated with the object
     */
    public MetaField getMetaField(Object obj) {
        MetaObject mo = MetaDataUtil.findMetaObject(obj, this);
        MetaField mf = getDeclaringMetaField();
        if ( mo != null ) {
            return mo.getMetaField(mf.getName());
        }
        else if ( mf != null ) {
            return mf;
        }
        return null;
    }

    /**
     * Sets the Super Validator
     * @param superValidator the super validator to set
     */
    public void setSuperValidator(MetaValidator superValidator) {
        setSuperData(superValidator);
    }

    /**
     * Gets the Super Validator
     * @return the super validator
     */
    protected MetaValidator getSuperValidator() {
        return getSuperData();
    }

    /////////////////////////////////////////////////////////////
    // VALIDATION METHODS

    /**
     * Validates the value of the field in the specified object
     * @param object the object containing the field to validate
     * @param value the value to validate
     */
    public abstract void validate(Object object, Object value);

    /////////////////////////////////////////////////////////////
    // HELPER METHODS

    /**
     * Retrieves the message to use for displaying errors.
     *
     * <p>The cross-port validator vocabulary does not carry a custom-message attr,
     * so this simply returns the supplied default. Kept as a seam so subtypes /
     * downstream extensions can override messaging without touching call sites.</p>
     *
     * @param defMsg the default message to use
     * @return the error message to display
     */
    public String getMessage(String defMsg) {
        return defMsg;
    }
}
