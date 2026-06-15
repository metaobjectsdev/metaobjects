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
package com.metaobjects.registry;

/**
 * Definition of a "common attribute" — one that is valid on any metadata node
 * (every type / every subType). Used by the cross-language commonAttrs
 * contract (documentation provider in TS / C# / Python / Java).
 *
 * @param name        bare attribute name (no {@code @} prefix; e.g. {@code "description"})
 * @param valueType   attribute value subtype (e.g. {@code StringAttribute.SUBTYPE_STRING},
 *                    {@code BooleanAttribute.SUBTYPE_BOOLEAN})
 * @param isArray     {@code true} if the attribute holds an array of {@code valueType}
 *                    (e.g. {@code aliases}, {@code seeAlso}, {@code replacedBy})
 * @param description FR-033 — the human/AI-facing documentation prose, sourced from the
 *                    universal {@code *.*} entry of the embedded {@code spec/metamodel/
 *                    documentation.json}. {@code ""} when not sourced (back-compat). The
 *                    registry-conformance manifest emits this on each common attr.
 */
public record CommonAttributeDef(String name, String valueType, boolean isArray, String description) {

    /** Back-compat constructor — no description (empty string). */
    public CommonAttributeDef(String name, String valueType, boolean isArray) {
        this(name, valueType, isArray, "");
    }

    /** A copy of this def carrying the given FR-033 description. */
    public CommonAttributeDef withDescription(String description) {
        return new CommonAttributeDef(name, valueType, isArray, description != null ? description : "");
    }
}
