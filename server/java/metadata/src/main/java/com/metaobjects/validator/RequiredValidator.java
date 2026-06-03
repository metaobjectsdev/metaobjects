/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Draagon Software
 * LLC. Use is subject to license terms.
 */
package com.metaobjects.validator;

import com.metaobjects.*;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.registry.MetaDataRegistry;

import org.apache.commons.validator.GenericValidator;

import static com.metaobjects.validator.MetaValidator.TYPE_VALIDATOR;

/**
 * A Required validator that ensures a field has a value and is not null with provider-based registration.
 */
@SuppressWarnings("serial")
public class RequiredValidator extends MetaValidator
{
    public final static String SUBTYPE_REQUIRED = "required";

    /**
     * Register this type with the MetaDataRegistry (called by provider).
     *
     * <p>Unlike the other validator subtypes, {@code required} carries NO
     * value-bound attrs — the cross-port contract gives it an empty attr list
     * (the {@code @min}/{@code @max} pair is meaningless for a presence check).
     * It therefore inherits from {@code metadata.base} (not {@code validator.base})
     * and re-declares only the wildcard attr child + {@code @isAbstract} marker,
     * so it never picks up the base validator's {@code @min}/{@code @max}.</p>
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(RequiredValidator.class, def -> {
            def.type(TYPE_VALIDATOR).subType(SUBTYPE_REQUIRED)
               .description("Required validator ensures field has a value and is not null")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
               .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");

            def.optionalAttributeWithConstraints(ATTR_IS_ABSTRACT)
               .ofType(BooleanAttribute.SUBTYPE_BOOLEAN)
               .asSingle();
        });
    }

    public RequiredValidator(String name) {
        super(SUBTYPE_REQUIRED, name);
    }

    /**
     * Validates the value of the field in the specified object
     */
    public void validate(Object object, Object value) {

        String msg = getMessage("A value is required on field "+getParent().getShortName());
        String val = (value == null) ? null : value.toString();

        if (GenericValidator.isBlankOrNull(val)) {
            throw new InvalidValueException(msg);
        }
    }
}
