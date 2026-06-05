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
package com.metaobjects.documentation;

import com.metaobjects.attr.StringArrayAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Documentation common-attrs provider — cross-language doc layer (TS/C# parity).
 *
 * <p>Registers the 7 universal documentation attributes via
 * {@link MetaDataRegistry#registerCommonAttribute(String, String, boolean)} so
 * they are accepted on any node (every type / every subType):</p>
 *
 * <ul>
 *   <li>{@code @description}, {@code @title}, {@code @notes}, {@code @deprecated},
 *       {@code @replacedBy} — single-string attrs</li>
 *   <li>{@code @seeAlso}, {@code @aliases} — string-array attrs</li>
 * </ul>
 *
 * <p>The {@code @notes} attribute is the internal-only rationale slot — per the
 * cross-language contract it must never be emitted to user-facing doc-gen
 * (JSDoc / XML-doc / Postgres {@code COMMENT ON} / Mermaid prose). It is
 * registered here so the loader accepts it on any node, but doc-emitters
 * downstream are expected to skip it.</p>
 */
public class DocumentationMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public String getProviderId() {
        return "metaobjects-documentation";
    }

    @Override
    public String[] getDependencies() {
        // Depends on core-types because the common-attr registration references
        // StringAttribute.SUBTYPE_STRING (a core type subtype).
        return new String[]{"core-types"};
    }

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // DocumentationSchema.COMMON_DOC_ATTRS is the single source of truth for
        // the 7 attrs (mirrored across TS/C#/Python). The registry stores value
        // class + arrayness separately, so derive isArray from the schema's
        // SUBTYPE_STRING_ARRAY marker and register the underlying string class.
        for (DocumentationSchema.CommonDocAttr attr : DocumentationSchema.COMMON_DOC_ATTRS) {
            boolean isArray = StringArrayAttribute.SUBTYPE_STRING_ARRAY.equals(attr.valueType());
            registry.registerCommonAttribute(attr.name(), StringAttribute.SUBTYPE_STRING, isArray);
        }
    }

    @Override
    public String getDescription() {
        return "Documentation Provider - cross-language doc attrs (description/title/notes/deprecated/replacedBy/seeAlso/aliases)";
    }
}
