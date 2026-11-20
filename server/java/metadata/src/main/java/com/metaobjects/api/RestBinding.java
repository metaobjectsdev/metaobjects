/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.api;

import com.metaobjects.MetaData;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/** {@code binding.rest} (ADR-0030): the HTTP method and path of an operation, declared only to override the derived ones. */
@SuppressWarnings("serial")
public class RestBinding extends MetaBinding {

    public RestBinding(String name) {
        super(ApiConstants.BINDING_SUBTYPE_REST, name);
    }

    /** Register {@code binding.base} and {@code binding.rest}. */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaBinding.class, def -> def
            .type(ApiConstants.TYPE_BINDING).subType(MetaData.SUBTYPE_BASE)
            .description("Registry anchor for protocol bindings")
            .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
            // Like template.base: the any-attr wildcard lets an undeclared attr reach the
            // strict-load ERR_UNKNOWN_ATTR diagnostic instead of failing placement.
            .optionalChild(com.metaobjects.attr.MetaAttribute.TYPE_ATTR, "*", "*"));
        registry.registerType(RestBinding.class, def -> {
            def.type(ApiConstants.TYPE_BINDING).subType(ApiConstants.BINDING_SUBTYPE_REST)
               .description("The HTTP method and path of an operation.")
               .inheritsFrom(ApiConstants.TYPE_BINDING, MetaData.SUBTYPE_BASE);
            def.optionalAttributeWithConstraints(ApiConstants.ATTR_METHOD)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(ApiConstants.BINDING_METHODS.toArray(new String[0]));
            def.optionalAttributeWithConstraints(ApiConstants.ATTR_PATH)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }
}
