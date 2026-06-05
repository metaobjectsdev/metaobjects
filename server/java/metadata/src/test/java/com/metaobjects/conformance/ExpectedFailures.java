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

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Expected-failures ledger loader and per-fixture classifier.
 *
 * <p>Java port of the C# {@code ExpectedFailures} class. The ledger lives at
 * {@code server/java/metadata/conformance-expected-failures.json} and lists
 * every fixture name that is a known Java gap.</p>
 *
 * <p>Classification rules (identical across all language ports):</p>
 * <ul>
 *   <li>passed + not-listed   → {@code "pass"}</li>
 *   <li>passed + listed       → {@code "fixed-but-listed"} (un-gate the ledger)</li>
 *   <li>not-passed + listed   → {@code "known-gap"} (acceptable)</li>
 *   <li>not-passed + unlisted → {@code "fail"} (a regression)</li>
 * </ul>
 */
public final class ExpectedFailures {

    /** Loaded ledger contents. */
    public static final class Ledger {
        public final String language;
        public final Set<String> fixtures;

        Ledger(String language, Set<String> fixtures) {
            this.language = language;
            this.fixtures = fixtures;
        }

        public static Ledger empty(String language) {
            return new Ledger(language, Collections.emptySet());
        }
    }

    private ExpectedFailures() {
        // Utility class — no instantiation.
    }

    /**
     * Load the ledger from disk. A missing file returns an empty ledger
     * (no-known-gaps mode).
     *
     * @param ledgerPath absolute path to the ledger JSON
     * @return the loaded ledger, possibly empty
     */
    public static Ledger load(Path ledgerPath) {
        if (!Files.isRegularFile(ledgerPath)) {
            return Ledger.empty("java");
        }
        try {
            JsonElement parsed = JsonParser.parseString(
                new String(Files.readAllBytes(ledgerPath), StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) {
                return Ledger.empty("java");
            }
            JsonObject obj = parsed.getAsJsonObject();
            String language = "java";
            JsonElement langEl = obj.get("language");
            if (langEl != null && langEl.isJsonPrimitive()
                && langEl.getAsJsonPrimitive().isString()) {
                language = langEl.getAsString();
            }
            LinkedHashSet<String> fixtures = new LinkedHashSet<>();
            JsonElement fixturesEl = obj.get("fixtures");
            if (fixturesEl != null && fixturesEl.isJsonArray()) {
                JsonArray arr = fixturesEl.getAsJsonArray();
                for (JsonElement el : arr) {
                    if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isString()) {
                        fixtures.add(el.getAsString());
                    }
                }
            }
            return new Ledger(language, Collections.unmodifiableSet(fixtures));
        } catch (IOException e) {
            // Missing or unreadable ledger → treat as empty.
            return Ledger.empty("java");
        }
    }

    /**
     * Classify one fixture's pass/fail status against the ledger.
     *
     * @param passed       whether all conformance checks for this fixture passed
     * @param fixtureName  the fixture's directory name
     * @param ledger       the loaded ledger
     * @return one of {@code "pass"}, {@code "known-gap"}, {@code "fixed-but-listed"}, {@code "fail"}
     */
    public static String classify(boolean passed, String fixtureName, Ledger ledger) {
        boolean listed = ledger.fixtures.contains(fixtureName);
        if (!passed) {
            return listed ? "known-gap" : "fail";
        }
        return listed ? "fixed-but-listed" : "pass";
    }
}
