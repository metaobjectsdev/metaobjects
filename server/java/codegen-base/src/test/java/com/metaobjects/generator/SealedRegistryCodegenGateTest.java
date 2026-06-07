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
package com.metaobjects.generator;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.generator.direct.metadata.ai.MetaDataAIDocumentationGenerator;
import com.metaobjects.generator.direct.metadata.file.json.MetaDataFileJsonSchemaGenerator;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.RegistryManifest;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

/**
 * ADR-0023 — the registration-time hard-fail gate (codegen edition).
 *
 * <p>This proves the central guarantee: a <strong>codegen generator</strong> that
 * attempts to register a metamodel attribute (the {@code ai*} / {@code json*}
 * tooling attrs the doc generators historically self-registered) against the
 * sealed library registry <strong>hard-fails</strong> with
 * {@link ErrorCode#ERR_REGISTRY_SEALED}. "Codegen makes up an attribute" is a
 * build failure, not a silent pollution of the loader's accepted vocabulary.</p>
 *
 * <p>Note this is the REAL doc-generator registration entry point
 * ({@code registerAIDocAttributes} / {@code registerJsonSchemaAttributes}),
 * exercised against a sealed registry — not a synthetic stand-in.</p>
 */
public class SealedRegistryCodegenGateTest {

    private static MetaDataRegistry sealedRegistry() {
        MetaDataRegistry registry = RegistryManifest.composeMetamodelRegistry();
        registry.seal();
        return registry;
    }

    @Test
    public void aiDocGenerator_registeringMetamodelAttrs_hardFailsWhenSealed() {
        MetaDataRegistry registry = sealedRegistry();
        try {
            MetaDataAIDocumentationGenerator.registerAIDocAttributes(registry);
            fail("A codegen generator registering ai* attrs into a sealed registry must hard-fail");
        } catch (MetaDataException e) {
            assertEquals("codegen self-registration must hard-fail with ERR_REGISTRY_SEALED",
                    java.util.Optional.of(ErrorCode.ERR_REGISTRY_SEALED), e.getCode());
        }
    }

    @Test
    public void jsonSchemaGenerator_registeringMetamodelAttrs_hardFailsWhenSealed() {
        MetaDataRegistry registry = sealedRegistry();
        try {
            MetaDataFileJsonSchemaGenerator.registerJsonSchemaAttributes(registry);
            fail("A codegen generator registering json* attrs into a sealed registry must hard-fail");
        } catch (MetaDataException e) {
            assertEquals("codegen self-registration must hard-fail with ERR_REGISTRY_SEALED",
                    java.util.Optional.of(ErrorCode.ERR_REGISTRY_SEALED), e.getCode());
        }
    }

    @Test
    public void docGenAttrs_areNotInTheDefaultLoaderVocabulary() {
        // The pivot's payoff: the sealed default loader registry — the one real
        // meta:gen/runtime loads measure — never carries the ai*/json* tooling attrs
        // even though THIS module's classpath has the polluting SPI providers.
        MetaDataRegistry def = RegistryManifest.defaultLoaderRegistry();
        // findType throws if the type is missing; field.string is always present.
        // The ai*/json* attrs are extensions to field.base/field.string/object.base;
        // assert the manifest (the measured logical vocabulary) is free of them.
        String manifest = RegistryManifest.emit(def);
        org.junit.Assert.assertFalse("ai* attrs must not be in the default loader vocabulary",
                manifest.contains("\"aiDescription\"") || manifest.contains("\"aiVersion\""));
        org.junit.Assert.assertFalse("json* schema attrs must not be in the default loader vocabulary",
                manifest.contains("\"jsonTitle\"") || manifest.contains("\"jsonSchemaVersion\""));
    }
}
