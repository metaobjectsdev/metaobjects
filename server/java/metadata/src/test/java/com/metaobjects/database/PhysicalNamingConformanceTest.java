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
package com.metaobjects.database;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaDataException;
import com.metaobjects.config.NeutralConfig;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.source.SourceResolution;
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
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.fail;

/**
 * ADR-0058 — runs the shared physical-naming corpus
 * ({@code fixtures/naming-conformance/physical-names/cases.json}) against this port: each
 * {@code naming} block is parsed with {@link NeutralConfig} (the same reader the project-aware
 * load path uses), applied to the {@code meta.naming.json} model's loaded root, and every
 * expected table/column name resolved through the SAME resolvers codegen and OMDB use
 * ({@code SourceResolution} + {@link ColumnNaming#resolve(MetaField)}). Each {@code invalid}
 * block must be refused by {@link NeutralConfig#parse}.
 *
 * <p>Not parameterized per corpus case for the valid/invalid split — a single {@code @Test}
 * per corpus section keeps the one-model-shared-across-rules structure explicit (the corpus
 * loads {@code meta.naming.json} once per {@code naming} rule combination, never per
 * assertion).</p>
 */
@RunWith(Parameterized.class)
public class PhysicalNamingConformanceTest extends SharedRegistryTestBase {

    private record Case(String name, JsonElement naming, Map<String, String> tables,
                         Map<String, String> columns) {}

    private record InvalidCase(String name, JsonElement naming) {}

    static Path corpusDir() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        if (dir == null) {
            throw new IllegalStateException(
                "could not locate the repository fixtures/ directory from " + Paths.get("").toAbsolutePath());
        }
        return dir.resolve("fixtures/naming-conformance/physical-names");
    }

    private static JsonObject readCorpus() throws IOException {
        String content = new String(
            Files.readAllBytes(corpusDir().resolve("cases.json")), StandardCharsets.UTF_8);
        return JsonParser.parseString(content).getAsJsonObject();
    }

    /**
     * Materializes the case's {@code naming} block into a minimal {@code .metaobjects/config.json}
     * document and parses it with {@link NeutralConfig#parse} — the same reader a project's
     * {@code .metaobjects/config.json} goes through, without touching the filesystem. A JSON
     * {@code null} means the whole {@code "naming"} key is ABSENT (the "default" case), never a
     * literal {@code "naming": null} (which {@code NeutralConfig} refuses as non-an-object).
     */
    private static PhysicalNaming parseNaming(JsonElement naming, String origin) {
        JsonObject doc = new JsonObject();
        doc.addProperty("schema_version", 1);
        if (naming != null && !naming.isJsonNull()) {
            doc.add("naming", naming);
        }
        return NeutralConfig.parse(doc.toString(), origin).getPhysicalNaming();
    }

    @Parameters(name = "{0}")
    public static Collection<Object[]> cases() throws IOException {
        JsonObject root = readCorpus();
        List<Object[]> rows = new ArrayList<>();
        for (JsonElement el : root.getAsJsonArray("cases")) {
            JsonObject c = el.getAsJsonObject();
            String name = c.get("name").getAsString();

            Map<String, String> tables = new java.util.LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("tables").entrySet()) {
                tables.put(e.getKey(), e.getValue().getAsString());
            }
            Map<String, String> columns = new java.util.LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("columns").entrySet()) {
                columns.put(e.getKey(), e.getValue().getAsString());
            }
            rows.add(new Object[]{name, new Case(name, c.get("naming"), tables, columns)});
        }
        return rows;
    }

    /** First arg drives the JUnit display name. */
    @Parameter(0)
    public String caseName;

    @Parameter(1)
    public Case testCase;

    private MetaDataLoader loadModel() throws IOException {
        Path metaFile = corpusDir().resolve("meta.naming.json");
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL,
            "naming_conformance_" + caseName.replaceAll("[^a-zA-Z0-9]+", "_"));
        loader.init();
        loader.load(List.of(new com.metaobjects.loader.FileSource(metaFile)));
        if (!loader.getErrors().isEmpty()) {
            fail(caseName + ": expected a clean load, got: " + loader.getErrors());
        }
        return loader;
    }

    private static MetaObject findObject(MetaDataLoader loader, String shortName) {
        for (MetaObject obj : loader.getMetaObjects()) {
            if (shortName.equals(obj.getShortName())) return obj;
        }
        fail("object '" + shortName + "' not found in meta.naming.json");
        return null;
    }

    @Test
    public void resolvesEveryTableAndColumnUnderThisNamingRule() throws IOException {
        PhysicalNaming naming = parseNaming(testCase.naming(), "case:" + caseName);
        MetaDataLoader loader = loadModel();
        loader.getRoot().setPhysicalNaming(naming);

        for (Map.Entry<String, String> e : testCase.tables().entrySet()) {
            MetaObject obj = findObject(loader, e.getKey());
            String actual = SourceResolution.primaryRdbSource(obj).getPhysicalName();
            assertEquals(caseName + ": table name for " + e.getKey(), e.getValue(), actual);
        }

        for (Map.Entry<String, String> e : testCase.columns().entrySet()) {
            String[] parts = e.getKey().split("\\.", 2);
            MetaObject obj = findObject(loader, parts[0]);
            MetaField<?> field = obj.getMetaField(parts[1]);
            String actual = ColumnNaming.resolve(field);
            assertEquals(caseName + ": column name for " + e.getKey(), e.getValue(), actual);
        }
    }

    /** Separate suite over the corpus's {@code invalid} array — each must be refused. */
    @RunWith(Parameterized.class)
    public static class Invalid {

        @Parameters(name = "{0}")
        public static Collection<Object[]> invalidCases() throws IOException {
            JsonObject root = readCorpus();
            List<Object[]> rows = new ArrayList<>();
            for (JsonElement el : root.getAsJsonArray("invalid")) {
                JsonObject c = el.getAsJsonObject();
                String name = c.get("name").getAsString();
                rows.add(new Object[]{name, new InvalidCase(name, c.get("naming"))});
            }
            return rows;
        }

        @Parameter(0)
        public String caseName;

        @Parameter(1)
        public InvalidCase testCase;

        @Test
        public void isRefused() {
            assertThrows(MetaDataException.class,
                () -> parseNaming(testCase.naming(), "invalid-case:" + caseName));
        }
    }
}
