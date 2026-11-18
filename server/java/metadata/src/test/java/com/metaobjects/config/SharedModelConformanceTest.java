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
package com.metaobjects.config;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.registry.RegistryManifest;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameter;
import org.junit.runners.Parameterized.Parameters;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Runs the shared FR-023 publish corpus against this port (Java; Kotlin publishes through the same
 * engine and Maven plugin). Reads the single committed {@code fixtures/shared-model-conformance/cases.json}.
 * The reference is {@code codegen-ts/src/shared-model/build-shared-model.ts}; {@link SharedModel} is this
 * port's counterpart. Every publish case pins the artifact and the manifest BYTES; every refusal pins its
 * reason (and, for {@code not-closed}, the exhaustive sorted pairs). The message text is not the contract.
 */
@RunWith(Parameterized.class)
public class SharedModelConformanceTest {

    /** The corpus's {@code secret-handling} provider: one common string attribute no core provider ships. */
    static final class SecretHandlingProvider implements MetaDataTypeProvider {
        @Override
        public String getProviderId() {
            return "secret-handling";
        }

        @Override
        public void registerTypes(MetaDataRegistry registry) {
            registry.registerCommonAttribute("secretHandling", StringAttribute.SUBTYPE_STRING, false);
        }
    }

    static Path corpusDir() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        assertNotNull("could not locate the repository fixtures/ directory", dir);
        return dir.resolve("fixtures/shared-model-conformance");
    }

    private static List<String> strings(JsonObject o, String key) {
        List<String> out = new ArrayList<>();
        if (o.has(key)) for (JsonElement e : o.getAsJsonArray(key)) out.add(e.getAsString());
        return out;
    }

    @Parameters(name = "{0}")
    public static Collection<Object[]> cases() throws IOException {
        String content = Files.readString(corpusDir().resolve("cases.json"), StandardCharsets.UTF_8);
        JsonArray arr = JsonParser.parseString(content).getAsJsonObject().getAsJsonArray("cases");
        List<Object[]> rows = new ArrayList<>();
        for (JsonElement el : arr) rows.add(new Object[]{el.getAsJsonObject().get("name").getAsString(), el.getAsJsonObject()});
        return rows;
    }

    @Parameter(0)
    public String caseName;

    @Parameter(1)
    public JsonObject testCase;

    @Test
    public void publishesLikeTheReference() throws IOException {
        JsonObject input = testCase.getAsJsonObject("input");
        List<Path> files = new ArrayList<>();
        for (String f : strings(input, "files")) files.add(corpusDir().resolve(f));
        List<MetaDataTypeProvider> providers = new ArrayList<>();
        for (String p : strings(input, "providers")) {
            if (!"secret-handling".equals(p)) fail("unknown corpus provider " + p);
            providers.add(new SecretHandlingProvider());
        }
        SharedModel.Input in = new SharedModel.Input(input.get("name").getAsString(), files,
                strings(input, "include"), strings(input, "exclude"), providers,
                input.has("requirements") && input.get("requirements").getAsBoolean());

        if (testCase.has("expectRefusal")) {
            JsonObject refusal = testCase.getAsJsonObject("expectRefusal");
            try {
                SharedModel.build(in);
                fail("expected a refusal (" + refusal.get("reason").getAsString() + ") but the publish succeeded");
            } catch (SharedModel.Refusal r) {
                assertEquals(refusal.get("reason").getAsString(), r.reason().id());
                if (refusal.has("pairs")) {
                    List<SharedModel.Pair> expected = new ArrayList<>();
                    for (JsonElement p : refusal.getAsJsonArray("pairs")) {
                        JsonObject po = p.getAsJsonObject();
                        expected.add(new SharedModel.Pair(po.get("referrer").getAsString(), po.get("target").getAsString()));
                    }
                    assertEquals(expected, r.pairs());
                }
            }
            return;
        }

        SharedModel.Files out = SharedModel.render(SharedModel.build(in), input.get("version").getAsString());
        String expectedArtifact = Files.readString(corpusDir().resolve(testCase.get("expectArtifact").getAsString()), StandardCharsets.UTF_8);
        String expectedManifest = Files.readString(corpusDir().resolve(testCase.get("expectManifest").getAsString()), StandardCharsets.UTF_8)
                .replace("@@METAMODEL_VERSION@@", RegistryManifest.METAMODEL_VERSION);
        assertEquals(expectedArtifact, out.artifact());
        assertEquals(expectedManifest, out.manifest());
        assertEquals(input.get("name").getAsString() + ".metaobjects.json", out.artifactPath());
        assertEquals("metaobjects.pkg.json", out.manifestPath());
    }

    @Test
    public void theCorpusIsNotEmpty() throws IOException {
        assertTrue(cases().size() > 0);
    }
}
