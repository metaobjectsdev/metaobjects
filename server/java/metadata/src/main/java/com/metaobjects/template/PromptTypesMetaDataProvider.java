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
package com.metaobjects.template;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.registry.spec.SpecMetamodelReader;

import java.util.Map;

/**
 * FR-033 — the {@code metaobjects-prompt} concern provider.
 *
 * <p>Re-homes the prompt / extract metamodel attrs that PROJECT the prompt concern
 * onto someone else's type — never an attribute a type is not meaningfully itself
 * without — out of the CORE type classes (field / enum / object.value) and into a
 * data-driven concern provider that reads the embedded
 * {@code spec/metamodel/prompt.json} {@code extends} directives — matching TS +
 * Python. It owns:</p>
 * <ul>
 *   <li>{@code field.*}: {@code @xmlText}, {@code @example}, {@code @instruction}.</li>
 *   <li>{@code field.enum}: {@code @enumAlias}, {@code @enumDoc},
 *       {@code @coerceDefault}, {@code @normalize}.</li>
 *   <li>{@code object.value}: {@code @normalize}.</li>
 * </ul>
 *
 * <p><strong>{@code template.prompt} / {@code template.output} / {@code
 * template.toolcall} attrs are NOT owned here</strong> (moved back out — see the TS
 * fix in commit {@code 4e701247}, mirrored in this port): {@code @payloadRef} and
 * {@code @toolName} are REQUIRED, and an attribute intrinsic to a type (the type is
 * invalid without it) must register WITH the type, in the type's own provider,
 * always — never in a concern provider that can be composed out of a build, which
 * would silently make the required-attr check stop firing. Those attrs are
 * registered directly by {@link PromptTemplate#registerTypes}, {@link
 * OutputTemplate#registerTypes} and {@link ToolcallTemplate#registerTypes}.</p>
 *
 * <p>The template TYPE definitions ({@code template.base}/{@code prompt}/{@code output}/
 * {@code toolcall}) are registered by {@link TemplateTypesMetaDataProvider}
 * (id {@code template-types}). Depends on {@code template-types} / {@code field-types}
 * / {@code object-types} so those subtypes exist before it extends them (the
 * {@code template-types} dependency predates the field/enum/value-only scope above
 * and is kept for provider-ordering safety, though this provider no longer extends
 * any {@code template.*} subtype).</p>
 */
public class PromptTypesMetaDataProvider implements MetaDataTypeProvider {

    /** The provider name — matches {@code prompt.json}'s {@code "provider"} field. */
    public static final String PROVIDER_ID = "metaobjects-prompt";

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // The field.* wildcard expands to the currently-registered field subtypes
        // (empty expansion map → registered-subtype fallback). The exact
        // (field.enum / object.value) directives resolve directly. prompt.json no
        // longer declares any template.* extends block (moved back to each
        // template subtype's own provider — see the class doc above), so this
        // simply processes fewer directives than it used to; no logic change needed.
        registry.applyProviderExtends(SpecMetamodelReader.load(), PROVIDER_ID, Map.of());
    }

    @Override
    public String getProviderId() {
        return PROVIDER_ID;
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"template-types", "field-types", "object-types"};
    }

    @Override
    public String getDescription() {
        return "MetaObjects prompt-construction concern attrs (xmlText/example/instruction, enum extract attrs, object.value @normalize) — FR-033";
    }
}
