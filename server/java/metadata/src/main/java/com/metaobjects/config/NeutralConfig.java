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
import com.google.gson.JsonSyntaxException;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import com.google.gson.stream.MalformedJsonException;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.database.PhysicalNaming;

import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The port-neutral subset of {@code .metaobjects/config.json}.
 *
 * <p>Reads only {@code schema_version}, {@code sources}, {@code dependencies} (FR-023, the
 * declared cross-repo metadata dependencies), {@code scope.include} and {@code migrate.scope}
 * (read only for the dependency-exclusion rules), {@code naming} (ADR-0058, the project's
 * physical-naming rules) and {@code wire} (ADR-0019 Amendment 2, the output form of a
 * generated REST surface). The file also carries TypeScript-owned keys
 * ({@code pending_in_git}, {@code confidence_thresholds}, {@code extract}, the rest of
 * {@code migrate} and {@code scope}); those are IGNORED rather than modeled, so a new TS-only
 * key never becomes a five-port change. Like Python, this port never applies {@code scope} to
 * its OWN generated output — {@code scope.include} is read for the explicit-include rule alone
 * ({@link Dependencies#explicitlyIncludes}).
 */
public final class NeutralConfig {

    /**
     * The DEFAULT value of {@code sources} when the key is absent or empty — never a
     * requirement, and never assumed to exist by any other code path.
     */
    public static final String DEFAULT_METADATA_DIR = "metaobjects";

    private static final String METAOBJECTS_DIR = ".metaobjects";
    private static final String CONFIG_FILE = "config.json";
    private static final int SUPPORTED_SCHEMA_VERSION = 1;

    private final List<Map<String, String>> sources;
    private final List<Map<String, String>> dependencies;
    private final List<String> scopeInclude;
    private final List<String> migrateScope;
    private final PhysicalNaming physicalNaming;
    private final WireFormat wireFormat;

    private NeutralConfig(List<Map<String, String>> sources, List<Map<String, String>> dependencies,
                          List<String> scopeInclude, List<String> migrateScope,
                          PhysicalNaming physicalNaming, WireFormat wireFormat) {
        this.sources = List.copyOf(sources);
        this.dependencies = List.copyOf(dependencies);
        this.scopeInclude = List.copyOf(scopeInclude);
        this.migrateScope = migrateScope == null ? null : List.copyOf(migrateScope);
        this.physicalNaming = physicalNaming;
        this.wireFormat = wireFormat;
    }

    /**
     * Each entry is a raw source spec (e.g. {@code {"path": "model"}},
     * {@code {"resource": "com/acme/model"}}) — kind interpretation belongs to
     * {@link SourceResolver}, not here.
     */
    public List<Map<String, String>> getSources() {
        return sources;
    }

    /**
     * FR-023 — the declared {@code dependencies}, each already validated (DESIGN §3.1): a
     * {@code name}, exactly one transport key ({@code path} | {@code npm} | {@code python}),
     * and {@code dir} only beside {@code npm}/{@code python}. Empty when the key is absent.
     * Resolving a transport to bytes is the Node {@code meta deps sync}'s job; this port reads
     * the committed snapshot instead.
     */
    public List<Map<String, String>> getDependencies() {
        return dependencies;
    }

    /**
     * FR-023 §11.1 item 2 — the declared {@code scope.include} patterns, read only for the
     * explicit-include rule. Empty when {@code scope} or {@code scope.include} is absent.
     */
    public List<String> getScopeInclude() {
        return scopeInclude;
    }

    /**
     * FR-023 §11.1 item 2 — the declared {@code migrate.scope} patterns, or {@code null} when
     * the key is absent (distinct from an empty list, which is a declared scope that matches
     * nothing).
     */
    public List<String> getMigrateScope() {
        return migrateScope;
    }

    /**
     * ADR-0058 — the project's physical-naming rules ({@code naming} in this file), each
     * absent rule at its default. Never {@code null}.
     */
    public PhysicalNaming getPhysicalNaming() {
        return physicalNaming;
    }

    /**
     * ADR-0019 Amendment 2 — the project's wire-format setting ({@code wire} in this file), each
     * absent key at its {@code native} default. Never {@code null}.
     */
    public WireFormat getWireFormat() {
        return wireFormat;
    }

    /**
     * Returns empty when {@code <configDir>/.metaobjects/config.json} does not exist.
     * A file that EXISTS but is malformed throws — swallowing it would make a typo'd
     * config behave identically to no config at all, silently loading from a possibly
     * stale default directory instead. The exact {@link ErrorCode} used for the
     * malformed path is deliberately NOT part of the cross-port contract (only the
     * raise-don't-degrade behavior is) — callers should match on the raise, not the
     * code, for this path.
     */
    public static Optional<NeutralConfig> read(Path configDir) {
        Path path = configDir.resolve(METAOBJECTS_DIR).resolve(CONFIG_FILE);
        if (!Files.isRegularFile(path)) return Optional.empty();

        String content;
        try {
            content = new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new MetaDataException(
                    path + " exists but could not be read: " + e.getMessage(),
                    ErrorCode.ERR_MALFORMED_JSON);
        }

        return Optional.of(parse(content, path.toString()));
    }

    /**
     * Parses {@code content} as a {@code .metaobjects/config.json} document, raised
     * messages naming {@code origin} rather than a filesystem path — for a runtime that has
     * no project directory to resolve against (ADR-0058's classpath-runtime case: give the
     * loader this file's bytes, however it reads them — a classpath resource included),
     * and gets the project's physical-naming rules back without ever supplying a rule value
     * of its own.
     *
     * @param content the file's raw bytes, decoded as UTF-8
     * @param origin   identifies the source in a raised message (a path, a classpath URI, …)
     */
    public static NeutralConfig parse(String content, String origin) {
        // `JsonParser.parseString` ALWAYS parses leniently, no matter how the
        // caller would like to configure it — a well-known Gson quirk: both
        // `JsonParser.parseReader` and `Gson#fromJson(JsonReader, ...)` force
        // `setLenient(true)` on the reader internally before walking it, so
        // unquoted keys, single-quoted strings, and `NaN`/`Infinity` literals all
        // parse clean — silently accepting a file that is not actually valid JSON,
        // contradicting this class's own javadoc and diverging from every other
        // port's stock JSON parser (TS `JSON.parse`, Python `json.loads`, C#
        // `System.Text.Json`, all strict by default). A `JsonReader` walked
        // directly with `setLenient(false)` is the only way to get genuinely
        // strict parsing out of Gson; used here purely to VALIDATE (the walked
        // structure is discarded — `JsonParser.parseString` below still builds the
        // actual `JsonElement` tree, unchanged).
        try (JsonReader strict = new JsonReader(new StringReader(content))) {
            strict.setLenient(false);
            strict.skipValue();
            if (strict.peek() != JsonToken.END_DOCUMENT) {
                throw new MalformedJsonException("trailing content after the top-level value");
            }
        } catch (IOException e) {
            throw new MetaDataException(
                    origin + " exists but could not be parsed as JSON: " + e.getMessage(),
                    ErrorCode.ERR_MALFORMED_JSON);
        }

        JsonElement parsed;
        try {
            parsed = JsonParser.parseString(content);
        } catch (JsonSyntaxException e) {
            throw new MetaDataException(
                    origin + " exists but could not be parsed as JSON: " + e.getMessage(),
                    ErrorCode.ERR_MALFORMED_JSON);
        }

        if (!parsed.isJsonObject()) {
            throw new MetaDataException(
                    origin + " must contain a JSON object",
                    ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT);
        }
        JsonObject root = parsed.getAsJsonObject();

        JsonElement version = root.get("schema_version");
        // Compared as a double, not getAsInt(): Gson's getAsInt() on a non-integral
        // BigDecimal TRUNCATES rather than raising, so a typo'd `schema_version: 1.5`
        // silently read as 1 and passed. getAsDouble() still accepts an
        // integral-valued float like `1.0` (equal to 1, and valid JSON — every other
        // port accepts it too, C#'s NeutralConfig.cs for the identical reason) while
        // correctly rejecting a genuinely non-integral value.
        if (version == null || !version.isJsonPrimitive() || !version.getAsJsonPrimitive().isNumber()
                || version.getAsDouble() != SUPPORTED_SCHEMA_VERSION) {
            throw new MetaDataException(
                    origin + ": unsupported schema_version (expected " + SUPPORTED_SCHEMA_VERSION + ")",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
        }

        List<Map<String, String>> specs = new ArrayList<>();
        JsonElement srcs = root.get("sources");
        // A present `sources` key that is not an array must RAISE, not silently
        // read as "absent" — the latter would fall back to the default directory
        // with no diagnostic, exactly the "typo'd config behaves like no config"
        // failure this class exists to prevent (see the class javadoc). This is
        // the GENERAL rule: a present-but-JSON-null `sources` is just as wrong-
        // typed as a present-but-object `sources` — it is not a special case.
        if (srcs != null && !srcs.isJsonArray()) {
            throw new MetaDataException(
                    origin + ": \"sources\" must be an array",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        if (srcs != null) {
            for (JsonElement el : srcs.getAsJsonArray()) {
                if (!el.isJsonObject()) {
                    throw new MetaDataException(
                            origin + ": each \"sources\" entry must be an object",
                            ErrorCode.ERR_BAD_ATTR_VALUE);
                }
                JsonObject entry = el.getAsJsonObject();
                if (entry.size() != 1) {
                    throw new MetaDataException(
                            origin + ": each \"sources\" entry must have exactly one key",
                            ErrorCode.ERR_BAD_ATTR_VALUE);
                }
                Map<String, String> spec = new LinkedHashMap<>();
                for (Map.Entry<String, JsonElement> e : entry.entrySet()) {
                    JsonElement v = e.getValue();
                    if (!v.isJsonPrimitive() || !v.getAsJsonPrimitive().isString()) {
                        // Every source-spec value (`path`/`resource`/`package`) is a
                        // string — a bare number/boolean/object/array silently
                        // stringified (the prior behavior) would let
                        // {"path": 123} load a directory literally named "123"
                        // rather than failing loudly on the typo'd config.
                        throw new MetaDataException(
                                origin + ": \"sources\" entry \"" + e.getKey() + "\" must be a string",
                                ErrorCode.ERR_BAD_ATTR_VALUE);
                    }
                    String value = v.getAsString();
                    if (value.strip().isEmpty()) {
                        throw new MetaDataException(
                                origin + ": \"sources\" entry \"" + e.getKey() + "\" must not be empty",
                                ErrorCode.ERR_BAD_ATTR_VALUE);
                    }
                    spec.put(e.getKey(), value);
                }
                specs.add(spec);
            }
        }

        List<Map<String, String>> dependencies = parseDependencies(root.get("dependencies"), origin);
        List<String> scopeInclude = parseScopeInclude(root.get("scope"), origin);
        List<String> migrateScope = parseMigrateScope(root.get("migrate"), origin);

        // ADR-0058 — the project's physical-naming rules. An unknown key, an unknown value,
        // or a non-object `naming` is refused (never silently defaulted — a typo would
        // otherwise bind a whole schema to the wrong names and report success).
        String columns = PhysicalNaming.DEFAULT_COLUMNS;
        String tables = PhysicalNaming.DEFAULT_TABLES;
        JsonElement naming = root.get("naming");
        if (naming != null && !(naming.isJsonObject())) {
            throw new MetaDataException(
                    origin + ": \"naming\" must be an object",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        if (naming != null) {
            JsonObject namingObj = naming.getAsJsonObject();
            for (String key : namingObj.keySet()) {
                if (!"columns".equals(key) && !"tables".equals(key)) {
                    throw new MetaDataException(
                            origin + ": \"naming\" has unknown key \"" + key
                                    + "\"; expected \"columns\" and/or \"tables\"",
                            ErrorCode.ERR_BAD_ATTR_VALUE);
                }
            }
            JsonElement columnsEl = namingObj.get("columns");
            if (columnsEl != null) {
                if (!columnsEl.isJsonPrimitive() || !columnsEl.getAsJsonPrimitive().isString()) {
                    throw new MetaDataException(
                            origin + ": \"naming.columns\" must be a string",
                            ErrorCode.ERR_BAD_ATTR_VALUE);
                }
                columns = columnsEl.getAsString();
            }
            JsonElement tablesEl = namingObj.get("tables");
            if (tablesEl != null) {
                if (!tablesEl.isJsonPrimitive() || !tablesEl.getAsJsonPrimitive().isString()) {
                    throw new MetaDataException(
                            origin + ": \"naming.tables\" must be a string",
                            ErrorCode.ERR_BAD_ATTR_VALUE);
                }
                tables = tablesEl.getAsString();
            }
        }
        // PhysicalNaming.of validates the values themselves (unknown columns/tables rule).
        PhysicalNaming physicalNaming = PhysicalNaming.of(columns, tables);

        WireFormat wireFormat = parseWire(root.get("wire"), origin);

        // Unknown top-level keys, and every key of `scope`/`migrate` but the two read above,
        // are IGNORED by design — see the class javadoc.
        return new NeutralConfig(specs, dependencies, scopeInclude, migrateScope, physicalNaming,
                wireFormat);
    }

    /** Mirrors the TS {@code DependencyName} regex (DESIGN §3.1). */
    private static final java.util.regex.Pattern DEPENDENCY_NAME =
            java.util.regex.Pattern.compile("^[a-z0-9][a-z0-9._-]*$");

    private static final List<String> DEPENDENCY_TRANSPORTS = List.of("path", "npm", "python");

    private static MetaDataException bad(String message) {
        return new MetaDataException(message, ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    /**
     * FR-023 — validate the {@code dependencies} array exactly as the TS
     * {@code DependencySpecSchema} and Python {@code _validate_dependency_spec} do. {@code mode} is
     * removed (§11.3) and so is an ordinary unknown key.
     */
    private static List<Map<String, String>> parseDependencies(JsonElement raw, String origin) {
        List<Map<String, String>> out = new ArrayList<>();
        if (raw == null) return out;
        if (!raw.isJsonArray()) throw bad(origin + ": \"dependencies\" must be an array");
        java.util.Set<String> names = new java.util.HashSet<>();
        for (JsonElement el : raw.getAsJsonArray()) {
            String ctx = origin + ": invalid \"dependencies\" entry (";
            if (!el.isJsonObject()) throw bad(ctx + "must be an object)");
            JsonObject dep = el.getAsJsonObject();

            JsonElement nameEl = dep.get("name");
            if (nameEl == null || !nameEl.isJsonPrimitive() || !nameEl.getAsJsonPrimitive().isString()
                    || !DEPENDENCY_NAME.matcher(nameEl.getAsString()).matches()) {
                throw bad(ctx + "'name' must match ^[a-z0-9][a-z0-9._-]*$)");
            }
            List<String> transports = new ArrayList<>();
            for (String t : DEPENDENCY_TRANSPORTS) if (dep.has(t)) transports.add(t);
            if (transports.size() != 1) {
                throw bad(ctx + "exactly one of 'path' / 'npm' / 'python' is required)");
            }
            String transport = transports.get(0);
            Map<String, String> spec = new LinkedHashMap<>();
            spec.put("name", nameEl.getAsString());
            spec.put(transport, nonEmptyString(dep.get(transport), ctx + "'" + transport + "' must be a non-empty string)"));

            java.util.Set<String> allowed = new java.util.HashSet<>(List.of("name", transport));
            if (!transport.equals("path")) allowed.add("dir");
            List<String> extra = new ArrayList<>();
            for (String k : dep.keySet()) if (!allowed.contains(k)) extra.add(k);
            if (!extra.isEmpty()) {
                java.util.Collections.sort(extra);
                throw bad(ctx + "unknown key(s): " + extra + ")");
            }
            if (dep.has("dir")) {
                spec.put("dir", nonEmptyString(dep.get("dir"), ctx + "'dir' must be a non-empty string)"));
            }
            if (!names.add(spec.get("name"))) {
                throw bad(origin + ": \"dependencies\" names must be unique");
            }
            out.add(spec);
        }
        return out;
    }

    private static String nonEmptyString(JsonElement el, String message) {
        if (el == null || !el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString()
                || el.getAsString().strip().isEmpty()) {
            throw bad(message);
        }
        return el.getAsString();
    }

    private static List<String> stringArray(JsonElement el, String field, String origin) {
        if (!el.isJsonArray()) throw bad(origin + ": \"" + field + "\" must be an array of non-empty strings");
        List<String> out = new ArrayList<>();
        for (JsonElement v : el.getAsJsonArray()) {
            out.add(nonEmptyString(v, origin + ": \"" + field + "\" must be an array of non-empty strings"));
        }
        return out;
    }

    /** {@code scope.include}; every other key inside {@code scope} is ignored. */
    private static List<String> parseScopeInclude(JsonElement scope, String origin) {
        if (scope == null || scope.isJsonNull()) return List.of();
        if (!scope.isJsonObject()) throw bad(origin + ": \"scope\" must be an object");
        JsonElement include = scope.getAsJsonObject().get("include");
        if (include == null || include.isJsonNull()) return List.of();
        return stringArray(include, "scope.include", origin);
    }

    /** {@code migrate.scope}, or {@code null} when absent; every other {@code migrate} key is ignored. */
    private static List<String> parseMigrateScope(JsonElement migrate, String origin) {
        if (migrate == null || migrate.isJsonNull()) return null;
        if (!migrate.isJsonObject()) throw bad(origin + ": \"migrate\" must be an object");
        JsonElement scope = migrate.getAsJsonObject().get("scope");
        if (scope == null || scope.isJsonNull()) return null;
        return stringArray(scope, "migrate.scope", origin);
    }

    /**
     * ADR-0019 Amendment 2 — the {@code wire} block. Refused exactly as {@code naming} is: an
     * unknown key, an unknown value, or a non-object block.
     */
    private static WireFormat parseWire(JsonElement wire, String origin) {
        if (wire == null) return WireFormat.DEFAULT;
        if (!wire.isJsonObject()) {
            throw new MetaDataException(origin + ": \"wire\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        JsonObject wireObj = wire.getAsJsonObject();
        WireFormat.Decimals decimals = WireFormat.Decimals.NATIVE;
        WireFormat.NullMembers nullMembers = WireFormat.NullMembers.NATIVE;
        for (String key : wireObj.keySet()) {
            JsonElement el = wireObj.get(key);
            String raw = el.isJsonPrimitive() && el.getAsJsonPrimitive().isString() ? el.getAsString() : null;
            switch (key) {
                case "decimals" -> {
                    decimals = raw == null ? null : WireFormat.decimalsOf(raw);
                    if (decimals == null) {
                        throw new MetaDataException(
                                origin + ": \"wire.decimals\" must be one of \"native\", \"string\"",
                                ErrorCode.ERR_BAD_ATTR_VALUE);
                    }
                }
                case "nullMembers" -> {
                    nullMembers = raw == null ? null : WireFormat.nullMembersOf(raw);
                    if (nullMembers == null) {
                        throw new MetaDataException(
                                origin + ": \"wire.nullMembers\" must be one of \"native\", \"emit\", \"omit\"",
                                ErrorCode.ERR_BAD_ATTR_VALUE);
                    }
                }
                default -> throw new MetaDataException(
                        origin + ": \"wire\" has unknown key \"" + key
                                + "\"; expected \"decimals\" and/or \"nullMembers\"",
                        ErrorCode.ERR_BAD_ATTR_VALUE);
            }
        }
        return new WireFormat(decimals, nullMembers);
    }
}
