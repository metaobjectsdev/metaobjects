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
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/** {@code operation.command} and {@code operation.query} (ADR-0030, ADR-0066), registered with {@code operation.base}. */
@SuppressWarnings("serial")
public class CommandOperation extends MetaOperation {

    public CommandOperation(String name) {
        super(ApiConstants.OPERATION_SUBTYPE_COMMAND, name);
    }

    /** Register {@code operation.base}, {@code operation.command} and {@code operation.query}. */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaOperation.class, def -> {
            def.type(ApiConstants.TYPE_OPERATION).subType(MetaData.SUBTYPE_BASE)
               .description("Registry anchor for the attributes every operation shares")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
               .optionalChild(ApiConstants.TYPE_BINDING, "*", "*")
               // Like template.base: the any-attr wildcard lets an undeclared attr reach the
               // strict-load ERR_UNKNOWN_ATTR diagnostic instead of failing placement.
               .optionalChild(com.metaobjects.attr.MetaAttribute.TYPE_ATTR, "*", "*");
            for (String ref : new String[] {ApiConstants.ATTR_INPUT_REF, ApiConstants.ATTR_OUTPUT_REF,
                    ApiConstants.ATTR_OBJECT_REF, ApiConstants.ATTR_PERMISSION}) {
                def.optionalAttributeWithConstraints(ref).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            }
            def.optionalAttributeWithConstraints(ApiConstants.ATTR_PUBLIC)
               .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
        });
        registry.registerType(CommandOperation.class, def -> {
            def.type(ApiConstants.TYPE_OPERATION).subType(ApiConstants.OPERATION_SUBTYPE_COMMAND)
               .description("A named operation that changes state.")
               .inheritsFrom(ApiConstants.TYPE_OPERATION, MetaData.SUBTYPE_BASE);
            def.optionalAttributeWithConstraints(ApiConstants.ATTR_TRANSITIONS)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
            def.optionalAttributeWithConstraints(ApiConstants.ATTR_ERRORS)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
        });
        registry.registerType(QueryOperation.class, def -> {
            def.type(ApiConstants.TYPE_OPERATION).subType(ApiConstants.OPERATION_SUBTYPE_QUERY)
               .description("A named operation that reads.")
               .inheritsFrom(ApiConstants.TYPE_OPERATION, MetaData.SUBTYPE_BASE);
            def.optionalAttributeWithConstraints(ApiConstants.ATTR_MANY)
               .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
        });
    }
}
