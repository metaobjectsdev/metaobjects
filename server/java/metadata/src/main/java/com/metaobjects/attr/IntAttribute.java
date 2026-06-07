/*
 * Copyright 2002 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.attr;

import com.metaobjects.DataTypes;
import com.metaobjects.constraint.RegexConstraint;
import com.metaobjects.registry.MetaDataRegistry;

import static com.metaobjects.attr.MetaAttribute.TYPE_ATTR;
import static com.metaobjects.attr.MetaAttribute.SUBTYPE_BASE;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * An Integer Attribute with provider-based registration.
 */
public class IntAttribute extends MetaAttribute<Integer> {

    public final static String SUBTYPE_INT = "int";

    /**
     * Constructs the Integer MetaAttribute
     */
    public IntAttribute(String name ) {
        super( SUBTYPE_INT, name, DataTypes.INT);
    }

    /**
     * Universal @isArray support - handles both single integers and integer arrays
     */
    @Override
    public void setValueAsString(String value) {
        if (isArrayType()) {
            // Array mode: Parse comma-delimited format for integers
            if (value == null) {
                setValueAsObject(null);
                return;
            }

            // Empty string should result in empty list, not null
            if (value.trim().isEmpty()) {
                setValueAsObject(new ArrayList<>());
                return;
            }

            // Parse comma-delimited format: "1,2,3" or single value "42"
            if (value.contains(",")) {
                // Comma-delimited: 1,2,3
                String[] items = value.split(",");
                List<Integer> list = new ArrayList<>();
                for (String item : items) {
                    String trimmed = item.trim();
                    if (!trimmed.isEmpty()) {
                        try {
                            list.add(Integer.parseInt(trimmed));
                        } catch (NumberFormatException e) {
                            throw new IllegalArgumentException("Invalid integer value in array: " + trimmed, e);
                        }
                    }
                }
                setValueAsObject(list);
            } else {
                // Single value
                try {
                    Integer intValue = Integer.parseInt(value.trim());
                    setValueAsObject(Arrays.asList(intValue));
                } catch (NumberFormatException e) {
                    throw new IllegalArgumentException("Invalid integer value: " + value, e);
                }
            }
        } else {
            // Single value mode: Standard integer handling
            if (value == null) {
                setValueAsObject(null);
            } else {
                try {
                    setValueAsObject(Integer.parseInt(value.trim()));
                } catch (NumberFormatException e) {
                    throw new IllegalArgumentException("Invalid integer value: " + value, e);
                }
            }
        }
    }

    /**
     * Register this type with the MetaDataRegistry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(IntAttribute.class, def -> def
            .type(TYPE_ATTR).subType(SUBTYPE_INT)
            .description("Integer attribute for numeric metadata values")
            .inheritsFrom(TYPE_ATTR, SUBTYPE_BASE)
        );

        // Register IntAttribute-specific constraints
        setupIntAttributeConstraints(registry);
    }
    
    /**
     * Setup IntAttribute-specific constraints using consolidated registry
     *
     * @param registry The MetaDataRegistry to use for constraint registration
     */
    private static void setupIntAttributeConstraints(com.metaobjects.registry.MetaDataRegistry registry) {
        // VALIDATION CONSTRAINT: Integer attribute values
        registry.addConstraint(new RegexConstraint(
            "intattribute.value.validation",
            "IntAttribute values must be valid integers",
            "attr",                     // Target type
            "int",                      // Integer subtype
            "*",                        // Any name
            "^-?\\d+$",                 // Integer pattern (optional negative sign, digits)
            true                        // Allow null/empty
        ));
    }

    /**
     * Manually create an Integer MetaAttribute with a value
     */
    public static IntAttribute create(String name, Integer value ) {
        IntAttribute a = new IntAttribute( name );
        a.setValue( value );
        return a;
    }
}
