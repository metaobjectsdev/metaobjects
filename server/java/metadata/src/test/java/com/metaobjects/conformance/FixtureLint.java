/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.conformance;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Corpus-integrity linter for conformance fixtures.
 *
 * <p>Java port of the C# {@code FixtureLint}. Validates that
 * each fixture's {@code expected-errors.json} only references error codes
 * registered in the shared {@code ERROR-CODES.json}. Detects malformed
 * {@code expected-errors.json} / {@code script.json} shape.</p>
 *
 * <p>The Java runner does NOT execute operation scripts in v1 (the {@code script.json}
 * navigate/invoke grammar is not yet implemented in the Java conformance
 * harness — fixtures with a {@code script.json} are intentionally ledgered).
 * This linter still validates basic {@code script.json} shape and the
 * navigate-segment grammar so any future Java script runner has a clean
 * corpus to consume.</p>
 */
public final class FixtureLint {

    // Colon segment: type:name (name has no '[')
    private static final Pattern COLON_SEG =
        Pattern.compile("^[a-z][a-z0-9-]*:[^\\[]+$");

    // Bracket segment: type[subType]
    private static final Pattern BRACKET_SEG =
        Pattern.compile("^[a-z][a-z0-9-]*\\[[a-zA-Z][a-zA-Z0-9-]*\\]$");

    private FixtureLint() {
        // Utility class — no instantiation.
    }

    /**
     * Lint one fixture against the registered-error-codes registry.
     *
     * @param fix                  the fixture to lint
     * @param registeredErrorCodes the set of codes from {@code ERROR-CODES.json}
     * @return list of problem strings (empty = clean)
     */
    public static List<String> lintFixture(FixtureDiscovery.Fixture fix,
                                            Set<String> registeredErrorCodes) {
        List<String> problems = new ArrayList<>();

        // expected-errors.json — each code must be in the registry
        if (fix.hasExpectedErrors) {
            try {
                JsonElement parsed = readJson(fix.dir.resolve("expected-errors.json").toString(),
                    Files.readAllBytes(fix.dir.resolve("expected-errors.json")));
                List<String> codes = parseExpectedErrors(parsed);
                for (String code : codes) {
                    if (!registeredErrorCodes.contains(code)) {
                        problems.add(fix.name + ": unregistered error code '" + code + "'");
                    }
                }
            } catch (Exception ex) {
                problems.add(fix.name + ": malformed expected-errors.json — " + ex.getMessage());
                return problems;
            }
        }

        // script.json — shape + navigate-segment grammar
        if (fix.hasScript) {
            try {
                JsonElement parsed = readJson(fix.dir.resolve("script.json").toString(),
                    Files.readAllBytes(fix.dir.resolve("script.json")));
                lintScriptShape(fix, parsed, problems);
            } catch (Exception ex) {
                problems.add(fix.name + ": malformed script.json — " + ex.getMessage());
            }
        }

        return problems;
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    private static JsonElement readJson(String path, byte[] bytes) {
        return JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8));
    }

    /**
     * Parse the {@code expected-errors.json} payload into an ordered list of code
     * strings. Accepts both shapes seen in the corpus:
     * <ul>
     *   <li>An array of strings (e.g. {@code ["ERR_BAD_ATTR_VALUE"]})</li>
     *   <li>An array of objects with a {@code "code"} string</li>
     * </ul>
     */
    static List<String> parseExpectedErrors(JsonElement el) {
        if (!el.isJsonArray()) {
            throw new IllegalArgumentException("expected-errors.json must be a JSON array");
        }
        JsonArray arr = el.getAsJsonArray();
        List<String> codes = new ArrayList<>(arr.size());
        for (JsonElement item : arr) {
            if (item.isJsonPrimitive() && item.getAsJsonPrimitive().isString()) {
                codes.add(item.getAsString());
            } else if (item.isJsonObject()) {
                JsonObject obj = item.getAsJsonObject();
                JsonElement code = obj.get("code");
                if (code == null || !code.isJsonPrimitive() || !code.getAsJsonPrimitive().isString()) {
                    throw new IllegalArgumentException(
                        "expected-errors entry object must have a string 'code' field");
                }
                codes.add(code.getAsString());
            } else {
                throw new IllegalArgumentException(
                    "expected-errors entry must be a string or an object with a 'code' field");
            }
        }
        return codes;
    }

    /**
     * Validate that {@code script.json} has the expected
     * {@code {"operations": [{"navigate": [...]}...]}} shape and that each
     * navigate segment matches the bracket-or-colon grammar.
     */
    private static void lintScriptShape(FixtureDiscovery.Fixture fix, JsonElement parsed,
                                         List<String> problems) {
        if (!parsed.isJsonObject()) {
            problems.add(fix.name + ": script.json root must be an object");
            return;
        }
        JsonElement opsEl = parsed.getAsJsonObject().get("operations");
        if (opsEl == null || !opsEl.isJsonArray()) {
            problems.add(fix.name + ": script.json must have an 'operations' array");
            return;
        }
        JsonArray ops = opsEl.getAsJsonArray();
        for (int i = 0; i < ops.size(); i++) {
            JsonElement opEl = ops.get(i);
            if (!opEl.isJsonObject()) {
                problems.add(fix.name + ": operation " + i + " is not an object");
                continue;
            }
            JsonElement navEl = opEl.getAsJsonObject().get("navigate");
            if (navEl == null || !navEl.isJsonArray()) {
                problems.add(fix.name + ": operation " + i + " has no 'navigate' array");
                continue;
            }
            for (JsonElement segEl : navEl.getAsJsonArray()) {
                if (!segEl.isJsonPrimitive() || !segEl.getAsJsonPrimitive().isString()) {
                    problems.add(fix.name + ": operation " + i + " navigate segment is not a string");
                    continue;
                }
                String seg = segEl.getAsString();
                if (!BRACKET_SEG.matcher(seg).matches()
                    && !COLON_SEG.matcher(seg).matches()) {
                    problems.add(fix.name + ": navigate segment '" + seg
                        + "' has malformed syntax (expected 'type:name' or 'type[subType]')");
                }
            }
        }
    }

    /**
     * Load all registered error codes from {@code ERROR-CODES.json} at the
     * corpus root.
     *
     * @param corpusRoot the corpus root path
     * @return the immutable set of registered codes
     */
    static Set<String> loadRegisteredCodes(java.nio.file.Path corpusRoot) {
        java.nio.file.Path codesFile = corpusRoot.resolve("ERROR-CODES.json");
        try {
            JsonElement parsed = JsonParser.parseString(
                new String(Files.readAllBytes(codesFile), StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) {
                throw new IllegalStateException(
                    "ERROR-CODES.json must be a JSON object");
            }
            JsonElement codesEl = parsed.getAsJsonObject().get("codes");
            if (codesEl == null || !codesEl.isJsonObject()) {
                throw new IllegalStateException(
                    "ERROR-CODES.json does not contain the expected { \"codes\": { ... } } shape");
            }
            java.util.LinkedHashSet<String> codes = new java.util.LinkedHashSet<>();
            for (java.util.Map.Entry<String, JsonElement> entry
                : codesEl.getAsJsonObject().entrySet()) {
                codes.add(entry.getKey());
            }
            return java.util.Collections.unmodifiableSet(codes);
        } catch (IOException e) {
            throw new AssertionError("Failed to read ERROR-CODES.json at " + codesFile, e);
        }
    }
}
