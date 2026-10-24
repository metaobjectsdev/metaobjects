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

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaDataException;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

/**
 * ADR-0019 Amendment 2 — runs the shared wire-setting corpus
 * ({@code fixtures/wire-conformance/config-blocks.json}) through {@link NeutralConfig#parse},
 * the reader a project's {@code .metaobjects/config.json} goes through.
 */
public class WireConformanceTest {

    private static JsonObject readCorpus() throws IOException {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        if (dir == null) throw new IllegalStateException("could not locate the repository fixtures/ directory");
        String content = new String(
            Files.readAllBytes(dir.resolve("fixtures/wire-conformance/config-blocks.json")), StandardCharsets.UTF_8);
        return JsonParser.parseString(content).getAsJsonObject();
    }

    /** A JSON {@code null} case value means the {@code wire} key is ABSENT. */
    private static WireFormat parse(JsonElement wire, String origin) {
        JsonObject doc = new JsonObject();
        doc.addProperty("schema_version", 1);
        if (wire != null && !wire.isJsonNull()) doc.add("wire", wire);
        return NeutralConfig.parse(doc.toString(), origin).getWireFormat();
    }

    @Test
    public void everyValidBlockResolvesToItsValues() throws IOException {
        int n = 0;
        for (JsonElement el : readCorpus().getAsJsonArray("cases")) {
            JsonObject c = el.getAsJsonObject();
            String name = c.get("name").getAsString();
            WireFormat wire = parse(c.get("wire"), "case:" + name);
            assertEquals(name + ": decimals", c.get("decimals").getAsString(), wire.decimals().wireName());
            assertEquals(name + ": nullMembers", c.get("nullMembers").getAsString(), wire.nullMembers().wireName());
            n++;
        }
        assertEquals(6, n);
    }

    @Test
    public void everyInvalidBlockIsRefused() throws IOException {
        int n = 0;
        for (JsonElement el : readCorpus().getAsJsonArray("invalid")) {
            JsonObject c = el.getAsJsonObject();
            String name = c.get("name").getAsString();
            assertThrows(name, MetaDataException.class, () -> parse(c.get("wire"), "invalid-case:" + name));
            n++;
        }
        assertEquals(8, n);
    }
}
