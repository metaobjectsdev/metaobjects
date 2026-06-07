/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.validator;

import java.util.ArrayList;
import java.util.Collection;

import com.metaobjects.*;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.apache.commons.validator.GenericValidator;

import static com.metaobjects.validator.MetaValidator.TYPE_VALIDATOR;
import static com.metaobjects.validator.MetaValidator.SUBTYPE_BASE;

/**
 * Numeric Validator that ensures a value is a number and (optionally) within a
 * {@code @min}/{@code @max} value range — the cross-port numeric-bound contract
 * shared with TS / C# / Python / Kotlin (see the SP-C validator-parity contract).
 */
@SuppressWarnings("serial")
public class NumericValidator extends MetaValidator {

    public final static String SUBTYPE_NUMERIC = "numeric";

    /** Cross-port minimum-value attribute ({@code @min}). */
    public final static String ATTR_MIN = "min";
    /** Cross-port maximum-value attribute ({@code @max}). */
    public final static String ATTR_MAX = "max";

    /**
     * Register this type with the MetaDataRegistry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(NumericValidator.class, def -> {
            def.type(TYPE_VALIDATOR).subType(SUBTYPE_NUMERIC)
               .description("Numeric validator ensuring values are numbers within an optional min/max range")
               .inheritsFrom(TYPE_VALIDATOR, SUBTYPE_BASE);

            // Cross-port int-typed value bounds (the value-under-test is still
            // parsed as a double; the bound attrs are read via getValueAsString).
            def.optionalAttributeWithConstraints(ATTR_MIN)
               .ofType(IntAttribute.SUBTYPE_INT)
               .asSingle();
            def.optionalAttributeWithConstraints(ATTR_MAX)
               .ofType(IntAttribute.SUBTYPE_INT)
               .asSingle();
        });
    }

    public NumericValidator(String name) {
        super(SUBTYPE_NUMERIC, name);
    }

    /**
     * Validates the value of the field in the specified object
     */
    public void validate(Object object, Object value) {

        String val = (value == null) ? null : value.toString();

        if (GenericValidator.isBlankOrNull(val)) return;

        double num;
        try {
            num = Double.parseDouble(val.trim());
        } catch (NumberFormatException e) {
            throw new InvalidValueException(getMessage("The value is not a valid number"));
        }

        if (hasMetaAttr(ATTR_MIN)) {
            double min = Double.parseDouble(getMetaAttr(ATTR_MIN).getValueAsString());
            if (num < min) {
                throw new InvalidValueException(getMessage("The value must be >= " + min));
            }
        }
        if (hasMetaAttr(ATTR_MAX)) {
            double max = Double.parseDouble(getMetaAttr(ATTR_MAX).getValueAsString());
            if (num > max) {
                throw new InvalidValueException(getMessage("The value must be <= " + max));
            }
        }
    }
}
