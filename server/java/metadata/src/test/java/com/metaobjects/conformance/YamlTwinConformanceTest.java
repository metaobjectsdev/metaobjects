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
package com.metaobjects.conformance;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameter;
import org.junit.runners.Parameterized.Parameters;
import org.yaml.snakeyaml.DumperOptions;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Two corpus-wide gates (ADR-0059), mirroring the TypeScript
 * {@code conformance-twin-roundtrip.test.ts}.
 *
 * <p>Gate 1 (YAML twin): each fixture's JSON inputs are loaded as JSON, then the same
 * texts are re-dumped as YAML and loaded as in-memory YAML sources in the same order.
 * The ordered error codes must match; when clean, the canonical serialization (and the
 * effective serialization, when the fixture has {@code expected-effective.json}) must be
 * identical.</p>
 *
 * <p>Gate 2 (round trip): {@code expected.json} is loaded as the only input and must
 * serialize back to itself.</p>
 *
 * <p>Exclusions come from the shared {@code yaml-twin-exclusions.json} and
 * {@code round-trip-exclusions.json}; there are no port-local divergences.</p>
 */
@RunWith(Parameterized.class)
public class YamlTwinConformanceTest {

    static final Path CORPUS = CorpusRoot.locate();

    @Parameters(name = "{0}")
    public static Collection<Object[]> fixtures() {
        List<FixtureDiscovery.Fixture> all = FixtureDiscovery.discover(CORPUS);
        List<Object[]> rows = new ArrayList<>(all.size());
        for (FixtureDiscovery.Fixture f : all) {
            if (f.isDocsOnly() || f.isContractOnly()) continue;
            rows.add(new Object[]{f.name, f});
        }
        return rows;
    }

    @Parameter(0)
    public String fixtureName;

    @Parameter(1)
    public FixtureDiscovery.Fixture fix;

    @Test
    public void yamlTwin() throws IOException {
        if (ConformanceExclusionsTest.twinExclusions().containsKey(fix.name)) return;
        if (!canCompose(fix)) return;
        List<Path> files = ConformanceTest.listInputFiles(fix.inputDir);
        assertTrue(fix.name + ": no input files", !files.isEmpty());
        String loaderName = ConformanceTest.detectLoaderName(files);

        List<String> jsonTexts = new ArrayList<>();
        List<String> yamlTexts = new ArrayList<>();
        DumperOptions dumper = new DumperOptions();
        dumper.setDefaultFlowStyle(DumperOptions.FlowStyle.BLOCK);
        Yaml yaml = new Yaml(dumper);
        for (Path file : files) {
            String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            jsonTexts.add(text);
            yamlTexts.add(yaml.dump(toPlainObject(JsonParser.parseString(text))));
        }

        Outcome base = load(fix, files, jsonTexts, loaderName, MetaDataSource.MetaDataFormat.JSON);
        Outcome twin = load(fix, files, yamlTexts, loaderName, MetaDataSource.MetaDataFormat.YAML);

        assertEquals(fix.name + ": error codes (YAML twin vs JSON)", base.errorCodes, twin.errorCodes);
        if (!base.errorCodes.isEmpty()) return;
        assertEquals(fix.name + ": canonical serialization (YAML twin vs JSON)",
            CanonicalJsonSerializer.canonicalSerialize(base.root).trim(),
            CanonicalJsonSerializer.canonicalSerialize(twin.root).trim());
        if (fix.hasExpectedEffective) {
            assertEquals(fix.name + ": effective serialization (YAML twin vs JSON)",
                CanonicalJsonSerializer.canonicalSerializeEffective(base.root).trim(),
                CanonicalJsonSerializer.canonicalSerializeEffective(twin.root).trim());
        }
    }

    @Test
    public void roundTrip() throws IOException {
        if (!fix.hasExpected) return;
        if (ConformanceExclusionsTest.roundTripExclusions().containsKey(fix.name)) return;
        if (!canCompose(fix)) return;
        Path expectedFile = fix.dir.resolve("expected.json");
        String expected = new String(Files.readAllBytes(expectedFile), StandardCharsets.UTF_8);
        String loaderName = ConformanceTest.detectLoaderName(List.of(expectedFile));
        Outcome o = load(fix, List.of(expectedFile), List.of(expected), loaderName,
            MetaDataSource.MetaDataFormat.JSON);
        assertTrue(fix.name + ": expected.json did not load cleanly: " + o.errorCodes,
            o.errorCodes.isEmpty());
        assertEquals(fix.name + ": expected.json does not round-trip",
            expected.trim(), CanonicalJsonSerializer.canonicalSerialize(o.root).trim());
    }

    /** Fixtures whose providers this port cannot compose are skipped by both gates. */
    private static boolean canCompose(FixtureDiscovery.Fixture f) {
        if (!f.hasProvidersJson) return true;
        for (String required : f.requiredProviders) {
            if (!ConformanceTest.AVAILABLE_PROVIDERS.contains(required)) return false;
        }
        boolean allTestOnly = !f.requiredProviders.isEmpty()
            && f.requiredProviders.stream().allMatch(ConformanceTestProviders.TEST_PROVIDERS::containsKey);
        return !allTestOnly; // composed-error fixtures are decided by compose(), not by a load
    }

    private static final class Outcome {
        final MetaRoot root;
        final List<String> errorCodes;
        Outcome(MetaRoot root, List<String> errorCodes) {
            this.root = root;
            this.errorCodes = errorCodes;
        }
    }

    private static Outcome load(FixtureDiscovery.Fixture f, List<Path> files, List<String> texts,
                                String loaderName, MetaDataSource.MetaDataFormat format) {
        LoaderOptions opts = LoaderOptions.create(false, false, true);
        MetaDataLoader loader = new MetaDataLoader(opts, MetaDataLoader.SUBTYPE_MANUAL, loaderName);
        if (f.hasProvidersJson && f.requiredProviders.contains("example-template-briefing")) {
            com.metaobjects.registry.MetaDataRegistry reg =
                com.metaobjects.registry.MetaDataRegistry.createWithCoreProviders();
            ConformanceTestProviders.BriefingTemplate.registerTypes(reg);
            loader.setTypeRegistry(reg);
        }
        loader.init();
        MetaDataException thrown = null;
        try {
            List<MetaDataSource> sources = new ArrayList<>();
            for (int i = 0; i < files.size(); i++) {
                // Three-argument constructor: the two-argument one silently means JSON.
                sources.add(new InMemoryStringSource(texts.get(i),
                    files.get(i).getFileName().toString(), format));
            }
            loader.load(sources);
        } catch (MetaDataException ex) {
            thrown = ex;
        }
        List<String> codes = new ArrayList<>();
        for (MetaDataException recorded : loader.getErrors()) {
            codes.add(ConformanceTest.extractErrorCode(recorded));
        }
        if (thrown != null) codes.add(ConformanceTest.extractErrorCode(thrown));
        return new Outcome(loader.getRoot(), codes);
    }

    private static Object toPlainObject(JsonElement el) {
        if (el == null || el.isJsonNull()) return null;
        if (el.isJsonObject()) {
            Map<String, Object> map = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> e : el.getAsJsonObject().entrySet()) {
                map.put(e.getKey(), toPlainObject(e.getValue()));
            }
            return map;
        }
        if (el.isJsonArray()) {
            List<Object> list = new ArrayList<>();
            for (JsonElement c : el.getAsJsonArray()) list.add(toPlainObject(c));
            return list;
        }
        com.google.gson.JsonPrimitive prim = el.getAsJsonPrimitive();
        if (prim.isBoolean()) return prim.getAsBoolean();
        if (prim.isNumber()) {
            double d = prim.getAsDouble();
            if (d == Math.rint(d) && !Double.isInfinite(d)) {
                long l = (long) d;
                if ((double) l == d) return l;
            }
            return d;
        }
        return prim.getAsString();
    }
}
