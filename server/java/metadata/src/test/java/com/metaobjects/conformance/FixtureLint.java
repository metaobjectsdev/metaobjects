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
                JsonElement parsed = readJsonFile(fix.dir.resolve("expected-errors.json"));
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
                JsonElement parsed = readJsonFile(fix.dir.resolve("script.json"));
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

    private static JsonElement readJsonFile(java.nio.file.Path path) throws IOException {
        return JsonParser.parseString(
            new String(Files.readAllBytes(path), StandardCharsets.UTF_8));
    }

    /**
     * One expected source token (FR5a / ADR-0009 envelope shape).
     */
    public static final class ExpectedErrorSource {
        public final String format;
        public final List<String> files;
        public final String jsonPath;  // nullable
        // FR5d — referrer + target are required for format=resolved, optional otherwise.
        public final String referrer;  // nullable
        public final String target;    // nullable
        public ExpectedErrorSource(String format, List<String> files, String jsonPath,
                                   String referrer, String target) {
            this.format = format;
            this.files = files;
            this.jsonPath = jsonPath;
            this.referrer = referrer;
            this.target = target;
        }
    }

    /** One expected error (envelope shape). */
    public static final class ExpectedError {
        public final String code;
        public final ExpectedErrorSource source; // nullable in legacy shape
        public ExpectedError(String code, ExpectedErrorSource source) {
            this.code = code;
            this.source = source;
        }
    }

    /** Parsed expected-errors.json — envelope-shape-aware. */
    public static final class ExpectedErrorsEnvelope {
        public final List<ExpectedError> errors;
        public final int warningsCount;
        public final boolean legacy;
        public ExpectedErrorsEnvelope(List<ExpectedError> errors, int warningsCount, boolean legacy) {
            this.errors = errors;
            this.warningsCount = warningsCount;
            this.legacy = legacy;
        }
    }

    /**
     * Parse the {@code expected-errors.json} payload — accepts both
     * shapes seen in the corpus:
     * <ul>
     *   <li>Legacy: an array of strings or {@code {"code":"ERR_X"}} objects.</li>
     *   <li>FR5a envelope: {@code {"errors": [{code, source: {format, files, jsonPath}}], "warnings": []}}.</li>
     * </ul>
     */
    public static ExpectedErrorsEnvelope parseExpectedErrorsEnvelope(JsonElement el) {
        // Legacy: array.
        if (el.isJsonArray()) {
            JsonArray arr = el.getAsJsonArray();
            List<ExpectedError> errors = new ArrayList<>(arr.size());
            for (JsonElement item : arr) {
                if (item.isJsonPrimitive() && item.getAsJsonPrimitive().isString()) {
                    errors.add(new ExpectedError(item.getAsString(), null));
                } else if (item.isJsonObject()) {
                    JsonObject obj = item.getAsJsonObject();
                    JsonElement code = obj.get("code");
                    if (code == null || !code.isJsonPrimitive() || !code.getAsJsonPrimitive().isString()) {
                        throw new IllegalArgumentException(
                            "expected-errors entry object must have a string 'code' field");
                    }
                    errors.add(new ExpectedError(code.getAsString(), null));
                } else {
                    throw new IllegalArgumentException(
                        "expected-errors entry must be a string or an object with a 'code' field");
                }
            }
            return new ExpectedErrorsEnvelope(errors, 0, true);
        }
        // FR5a envelope.
        if (!el.isJsonObject()) {
            throw new IllegalArgumentException(
                "expected-errors.json must be either an array (legacy) or an object with 'errors'");
        }
        JsonObject root = el.getAsJsonObject();
        JsonElement errorsEl = root.get("errors");
        if (errorsEl == null || !errorsEl.isJsonArray()) {
            throw new IllegalArgumentException("expected-errors.json: 'errors' must be an array");
        }
        List<ExpectedError> errors = new ArrayList<>();
        int idx = 0;
        for (JsonElement item : errorsEl.getAsJsonArray()) {
            if (!item.isJsonObject()) {
                throw new IllegalArgumentException(
                    "expected-errors.json entry " + idx + " is not an object");
            }
            JsonObject obj = item.getAsJsonObject();
            JsonElement code = obj.get("code");
            if (code == null || !code.isJsonPrimitive() || !code.getAsJsonPrimitive().isString()) {
                throw new IllegalArgumentException(
                    "expected-errors.json entry " + idx + " missing string 'code' field");
            }
            ExpectedErrorSource source = null;
            JsonElement srcEl = obj.get("source");
            if (srcEl != null && srcEl.isJsonObject()) {
                JsonObject srcObj = srcEl.getAsJsonObject();
                JsonElement fmtEl = srcObj.get("format");
                if (fmtEl == null || !fmtEl.isJsonPrimitive() || !fmtEl.getAsJsonPrimitive().isString()) {
                    throw new IllegalArgumentException(
                        "expected-errors.json entry " + idx + " source.format must be a string");
                }
                JsonElement filesEl = srcObj.get("files");
                if (filesEl == null || !filesEl.isJsonArray()) {
                    throw new IllegalArgumentException(
                        "expected-errors.json entry " + idx + " source.files must be a string[]");
                }
                List<String> files = new ArrayList<>();
                for (JsonElement fe : filesEl.getAsJsonArray()) {
                    if (!fe.isJsonPrimitive() || !fe.getAsJsonPrimitive().isString()) {
                        throw new IllegalArgumentException(
                            "expected-errors.json entry " + idx + " source.files contains non-string");
                    }
                    files.add(fe.getAsString());
                }
                String jsonPath = null;
                JsonElement jpEl = srcObj.get("jsonPath");
                if (jpEl != null && jpEl.isJsonPrimitive() && jpEl.getAsJsonPrimitive().isString()) {
                    jsonPath = jpEl.getAsString();
                }
                String referrer = null;
                JsonElement refEl = srcObj.get("referrer");
                if (refEl != null && refEl.isJsonPrimitive() && refEl.getAsJsonPrimitive().isString()) {
                    referrer = refEl.getAsString();
                }
                String target = null;
                JsonElement tgtEl = srcObj.get("target");
                if (tgtEl != null && tgtEl.isJsonPrimitive() && tgtEl.getAsJsonPrimitive().isString()) {
                    target = tgtEl.getAsString();
                }
                // FR5d — format=resolved requires both referrer and target.
                String fmt = fmtEl.getAsString();
                if ("resolved".equals(fmt)) {
                    if (referrer == null) {
                        throw new IllegalArgumentException(
                            "expected-errors.json entry " + idx + " source.referrer is required when format='resolved'");
                    }
                    if (target == null) {
                        throw new IllegalArgumentException(
                            "expected-errors.json entry " + idx + " source.target is required when format='resolved'");
                    }
                }
                source = new ExpectedErrorSource(fmt, files, jsonPath, referrer, target);
            }
            errors.add(new ExpectedError(code.getAsString(), source));
            idx++;
        }
        int warningsCount = 0;
        JsonElement warnEl = root.get("warnings");
        if (warnEl != null && warnEl.isJsonArray()) {
            warningsCount = warnEl.getAsJsonArray().size();
        }
        return new ExpectedErrorsEnvelope(errors, warningsCount, false);
    }

    /** Backward-compat helper — returns just the codes from either shape. */
    static List<String> parseExpectedErrors(JsonElement el) {
        ExpectedErrorsEnvelope env = parseExpectedErrorsEnvelope(el);
        List<String> codes = new ArrayList<>(env.errors.size());
        for (ExpectedError e : env.errors) codes.add(e.code);
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
