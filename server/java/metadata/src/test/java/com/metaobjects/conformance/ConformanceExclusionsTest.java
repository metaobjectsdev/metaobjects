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

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.Assert.assertTrue;

/** Loads the shared gate exclusion files and asserts every named fixture exists. */
public class ConformanceExclusionsTest {

    static Map<String, String> twinExclusions() {
        return read("yaml-twin-exclusions.json");
    }

    static Map<String, String> roundTripExclusions() {
        return read("round-trip-exclusions.json");
    }

    private static Map<String, String> read(String file) {
        try {
            Path p = CorpusRoot.locate().resolve(file);
            JsonObject root = JsonParser.parseString(
                new String(Files.readAllBytes(p), StandardCharsets.UTF_8)).getAsJsonObject();
            Map<String, String> out = new LinkedHashMap<>();
            root.getAsJsonObject("exclusions").entrySet()
                .forEach(e -> out.put(e.getKey(), e.getValue().getAsString()));
            return out;
        } catch (IOException ex) {
            throw new UncheckedIOException(ex);
        }
    }

    @Test
    public void everyExclusionNamesAFixture() {
        Path corpus = CorpusRoot.locate();
        for (String name : twinExclusions().keySet()) {
            assertTrue("yaml-twin-exclusions.json names a fixture that does not exist: " + name,
                Files.isDirectory(corpus.resolve(name)));
        }
        for (String name : roundTripExclusions().keySet()) {
            assertTrue("round-trip-exclusions.json names a fixture that does not exist: " + name,
                Files.isDirectory(corpus.resolve(name)));
        }
    }
}
