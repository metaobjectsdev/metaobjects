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
package com.metaobjects.transition;

import com.metaobjects.MetaData;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.ExpressionAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/** {@code transition.action} (ADR-0063): an allowed move between two values of a {@code field.enum}. */
@SuppressWarnings("serial")
public class ActionTransition extends MetaTransition {

    public ActionTransition(String name) {
        super(TransitionConstants.SUBTYPE_ACTION, name);
    }

    /** Register {@code transition.base} and {@code transition.action}; text comes from {@code spec/metamodel/transition.json}. */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaTransition.class, def -> {
            def.type(TransitionConstants.TYPE_TRANSITION).subType(MetaData.SUBTYPE_BASE)
               .description("Registry anchor for the attributes every lifecycle move shares")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
               // Like template.base: the any-attr wildcard lets an undeclared attr reach the
               // strict-load ERR_UNKNOWN_ATTR diagnostic instead of failing placement.
               .optionalChild(com.metaobjects.attr.MetaAttribute.TYPE_ATTR, "*", "*");
            def.optionalAttributeWithConstraints(TransitionConstants.ATTR_PERMISSION)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(TransitionConstants.ATTR_PUBLIC)
               .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
        });
        registry.registerType(ActionTransition.class, def -> {
            def.type(TransitionConstants.TYPE_TRANSITION).subType(TransitionConstants.SUBTYPE_ACTION)
               .description("An allowed move between two values of a field.enum.")
               .inheritsFrom(TransitionConstants.TYPE_TRANSITION, MetaData.SUBTYPE_BASE);
            def.requiredAttributeWithConstraints(TransitionConstants.ATTR_FROM)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
            def.requiredAttributeWithConstraints(TransitionConstants.ATTR_TO)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(TransitionConstants.ATTR_CONDITION)
               .ofType(ExpressionAttribute.SUBTYPE_EXPRESSION).asSingle();
        });
    }
}
