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
import com.metaobjects.registry.MetaDataRegistry;

/** {@code api.operational} (ADR-0030): a named, packaged request/response surface. */
@SuppressWarnings("serial")
public class OperationalApi extends MetaApi {

    public OperationalApi(String name) {
        super(ApiConstants.API_SUBTYPE_OPERATIONAL, name);
    }

    /** Register {@code api.base} and {@code api.operational}; text and children come from {@code spec/metamodel/api.json}. */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaApi.class, def -> def
            .type(ApiConstants.TYPE_API).subType(MetaData.SUBTYPE_BASE)
            .description("Registry anchor for the declared API surface")
            .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
            // Like template.base: the any-attr wildcard lets an undeclared attr reach the
            // strict-load ERR_UNKNOWN_ATTR diagnostic instead of failing placement.
            .optionalChild(com.metaobjects.attr.MetaAttribute.TYPE_ATTR, "*", "*"));
        registry.registerType(OperationalApi.class, def -> def
            .type(ApiConstants.TYPE_API).subType(ApiConstants.API_SUBTYPE_OPERATIONAL)
            .description("A named, packaged request/response surface whose children are operations.")
            .inheritsFrom(ApiConstants.TYPE_API, MetaData.SUBTYPE_BASE)
            .optionalChild(ApiConstants.TYPE_OPERATION, "*", "*"));
    }
}
