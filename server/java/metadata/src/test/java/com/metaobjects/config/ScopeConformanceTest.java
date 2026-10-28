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
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Runs the shared scope corpus against this port. Reads the single committed
 * {@code fixtures/scope-conformance/cases.json} — no per-port fixture. The corpus is
 * the contract; {@code server/typescript/packages/metadata/src/scope.ts} is the
 * reference it was authored against.
 */
public class ScopeConformanceTest {

    private static JsonArray cases() throws IOException {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        assertNotNull("could not locate the repository fixtures/ directory", dir);
        Path corpus = dir.resolve("fixtures/scope-conformance/cases.json");
        String content = new String(Files.readAllBytes(corpus), StandardCharsets.UTF_8);
        return JsonParser.parseString(content).getAsJsonObject().getAsJsonArray("cases");
    }

    private static List<String> strings(JsonObject scope, String key) {
        List<String> out = new ArrayList<>();
        if (!scope.has(key)) return out;
        for (JsonElement e : scope.getAsJsonArray(key)) out.add(e.getAsString());
        return out;
    }

    @Test
    public void everyCorpusCaseMatchesTheReference() throws IOException {
        JsonArray cases = cases();
        // Guard against a runner that silently reads nothing; the corpus grows, so no
        // hard-coded count.
        assertTrue("scope corpus is empty", cases.size() > 0);
        for (JsonElement caseEl : cases) {
            JsonObject c = caseEl.getAsJsonObject();
            String name = c.get("name").getAsString();
            JsonObject scope = c.getAsJsonObject("scope");
            Scope.Compiled compiled =
                    Scope.compileScope(strings(scope, "include"), strings(scope, "exclude"));
            for (JsonElement expEl : c.getAsJsonArray("expect")) {
                JsonObject exp = expEl.getAsJsonObject();
                String fqn = exp.get("fqn").getAsString();
                assertEquals(name + ": " + fqn, exp.get("matches").getAsBoolean(),
                        Scope.matchesScope(fqn, compiled));
            }
        }
    }

    // --- Pattern errors: not in the corpus (which is matches-only), so pinned here ---

    private static void assertInvalid(String pattern) {
        try {
            Scope.compilePattern(pattern);
            fail("expected ERR_SCOPE_PATTERN_INVALID for \"" + pattern + "\"");
        } catch (MetaDataException e) {
            assertEquals(ErrorCode.ERR_SCOPE_PATTERN_INVALID, e.getCode().orElse(null));
        }
    }

    @Test
    public void anEmptyPatternIsRefused() {
        assertInvalid("");
    }

    @Test
    public void anEmptySegmentIsRefused() {
        assertInvalid("acme::::Order");
        assertInvalid("::Order");
    }

    @Test
    public void aTrailingSeparatorIsRefusedNotDropped() {
        // Java's default String.split discards trailing empties; the reference keeps them.
        assertInvalid("acme::");
    }

    @Test
    public void anOddColonRunIsRefusedNotSilentlyUnmatchable() {
        assertInvalid("acme:::Order");
        assertInvalid("acme:Order");
    }

    @Test
    public void aTrailingNewlineInTheNameNeverMatches() {
        Scope.Compiled compiled =
                Scope.compileScope(Collections.singletonList("acme::Order"), null);
        assertTrue(Scope.matchesScope("acme::Order", compiled));
        assertFalse(Scope.matchesScope("acme::Order\n", compiled));
    }

    @Test
    public void aStarAdjacentToAMetacharacterKeepsTheLiteral() {
        Scope.Compiled compiled =
                Scope.compileScope(Arrays.asList("acme::a*.b", "acme::(x)*"), null);
        assertTrue(Scope.matchesScope("acme::aXY.b", compiled));
        assertFalse(Scope.matchesScope("acme::aXYxb", compiled));
        assertTrue(Scope.matchesScope("acme::(x)tail", compiled));
        assertTrue(Scope.matchesScope("acme::(x)", compiled));
    }
}
