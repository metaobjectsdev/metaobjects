/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Draagon Software
 * LLC. Use is subject to license terms.
 */
package com.metaobjects.validator;

import com.metaobjects.*;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.apache.commons.validator.GenericValidator;

import static com.metaobjects.validator.MetaValidator.TYPE_VALIDATOR;
import static com.metaobjects.validator.MetaValidator.SUBTYPE_BASE;

/**
 * Regular expression validator that ensures a field value matches the specific expression mask.
 */
public class RegexValidator extends MetaValidator {

    public final static String SUBTYPE_REGEX = "regex";

    /**
     * Cross-port pattern attribute ({@code @pattern}) — the canonical regex source
     * shared with TS / C# / Python / Kotlin (see the SP-C validator-parity contract).
     */
    public final static String ATTR_PATTERN = "pattern";

    /**
     * Register this type with the MetaDataRegistry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(RegexValidator.class, def -> {
            def.type(TYPE_VALIDATOR).subType(SUBTYPE_REGEX)
               .description("Regular expression validator for pattern matching")
               .inheritsFrom(TYPE_VALIDATOR, SUBTYPE_BASE);

            // REGEX-SPECIFIC ATTRIBUTES WITH FLUENT CONSTRAINTS
            // @pattern (cross-port canonical) supplies the regex. The cross-port
            // contract also declares the inherited int-typed @min/@max bounds here.
            def.optionalAttributeWithConstraints(ATTR_PATTERN)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .asSingle();
            def.optionalAttributeWithConstraints(ATTR_MIN)
               .ofType(IntAttribute.SUBTYPE_INT)
               .asSingle();
            def.optionalAttributeWithConstraints(ATTR_MAX)
               .ofType(IntAttribute.SUBTYPE_INT)
               .asSingle();
        });
    }

    /** Resolve the regex source — the cross-port canonical {@code @pattern}. */
    public String resolvePattern() {
        if (hasMetaAttr(ATTR_PATTERN)) return getMetaAttr(ATTR_PATTERN).getValueAsString();
        return null;
    }

    public RegexValidator(String name) {
        super(SUBTYPE_REGEX, name);
    }

    /**
     * Validates the value of the field in the specified object
     */
    public void validate(Object object, Object value)
    //throws MetaException
    {
        String mask = resolvePattern();
        String msg = getMessage("Invalid value format");

        String val = (value == null) ? null : value.toString();

        if (mask != null
                && !GenericValidator.isBlankOrNull(val)
                && !GenericValidator.matchRegexp(val, mask)) {
            throw new InvalidValueException(msg);
        }
    }
}
