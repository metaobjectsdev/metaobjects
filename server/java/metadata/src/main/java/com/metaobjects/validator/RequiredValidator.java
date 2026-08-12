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
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);
               // ADR-0051: NO any-attr wildcard. An undeclared attribute is ERR_UNKNOWN_ATTR in
               // every port; extension is REGISTRATION -- a downstream provider declares its
               // attrs. A wildcard would also swallow a TYPO'd core attr, silently.

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
