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
    private EnumDefaults enumDefaults = EnumDefaults.DEFAULT;
    private ApiSettings apiSettings = ApiSettings.DEFAULT;
    private List<String> requirementsInherit = List.of();

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
     * {@code name}, exactly one transport key ({@code path} | {@code npm} | {@code python} |
     * {@code maven} | {@code nuget}), a {@code version} beside {@code maven}/{@code nuget}, and
     * {@code dir} beside any transport but {@code path}. Empty when the key is absent.
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
     * FR-023 — the declared {@code requirements.inherit} patterns: the dependencies whose
     * requirements this project takes on as its own ledger ({@link DependencySet#inLedger}).
     * Empty when the key is absent.
     */
    public List<String> getRequirementsInherit() {
        return requirementsInherit;
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
     * The project's {@code api} block ({@code api.pagination}, {@code api.unknownFields}), absent
     * keys at their defaults (no page size, {@code reject}). Never {@code null}.
     */
    public ApiSettings getApiSettings() {
        return apiSettings;
    }

    /** The project's enum storage defaults ({@code enums} in this file). Never {@code null}. */
    public EnumDefaults getEnumDefaults() {
        return enumDefaults;
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
        String collections = null;
        JsonElement naming = root.get("naming");
        if (naming != null && !(naming.isJsonObject())) {
            throw new MetaDataException(
                    origin + ": \"naming\" must be an object",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        if (naming != null) {
            JsonObject namingObj = naming.getAsJsonObject();
            for (String key : namingObj.keySet()) {
                if (!"columns".equals(key) && !"tables".equals(key) && !"collections".equals(key)) {
                    throw new MetaDataException(
                            origin + ": \"naming\" has unknown key \"" + key
                                    + "\"; expected \"columns\", \"tables\" and/or \"collections\"",
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
            // The pluralizer an object without @collectionName takes its collection name from.
            JsonElement collectionsEl = namingObj.get("collections");
            if (collectionsEl != null) {
                if (!collectionsEl.isJsonPrimitive() || !collectionsEl.getAsJsonPrimitive().isString()) {
                    throw new MetaDataException(
                            origin + ": \"naming.collections\" must be a string naming a pluralizer",
                            ErrorCode.ERR_BAD_ATTR_VALUE);
                }
                collections = collectionsEl.getAsString();
            }
        }
        // PhysicalNaming.of validates the values against the NamingStrategies registry (a
        // built-in or an application-registered name; ADR-0058 Amendment 1).
        PhysicalNaming physicalNaming = PhysicalNaming.of(columns, tables, collections);

        WireFormat wireFormat = parseWire(root.get("wire"), origin);

        // Unknown top-level keys, and every key of `scope`/`migrate` but the two read above,
        // are IGNORED by design — see the class javadoc.
        NeutralConfig cfg = new NeutralConfig(specs, dependencies, scopeInclude, migrateScope, physicalNaming,
                wireFormat);
        cfg.enumDefaults = parseEnums(root.get("enums"), origin);
        cfg.apiSettings = parseApi(root.get("api"), origin);
        cfg.requirementsInherit = parseRequirementsInherit(root.get("requirements"), origin);
        return cfg;
    }

    /**
     * The {@code api} block: {@code pagination} ({@code defaultLimit} and {@code maxLimit}, both
     * positive integers, {@code defaultLimit <= maxLimit}) and {@code unknownFields}
     * ({@code "reject"} | {@code "drop"}). Refused like {@code naming}: an unknown key, a
     * wrong-typed value or a non-object block. The messages match the TypeScript reader's.
     */
    private static ApiSettings parseApi(JsonElement api, String origin) {
        if (api == null) return ApiSettings.DEFAULT;
        if (!api.isJsonObject()) throw bad(origin + ": \"api\" must be an object");
        ApiSettings.Pagination pagination = null;
        ApiSettings.UnknownFields unknownFields = ApiSettings.UnknownFields.REJECT;
        JsonObject obj = api.getAsJsonObject();
        for (String key : obj.keySet()) {
            JsonElement v = obj.get(key);
            switch (key) {
                case "pagination" -> pagination = parsePagination(v, origin);
                case "unknownFields" -> {
                    unknownFields = v.isJsonPrimitive() && v.getAsJsonPrimitive().isString()
                            ? ApiSettings.unknownFieldsOf(v.getAsString()) : null;
                    if (unknownFields == null) {
                        throw bad(origin + ": \"api.unknownFields\" must be \"reject\" or \"drop\"");
                    }
                }
                default -> throw bad(origin + ": \"api\" has an unknown key \"" + key
                        + "\" (expected \"pagination\" or \"unknownFields\")");
            }
        }
        return new ApiSettings(pagination, unknownFields);
    }

    private static ApiSettings.Pagination parsePagination(JsonElement el, String origin) {
        if (!el.isJsonObject()) throw bad(origin + ": \"api.pagination\" must be an object");
        JsonObject obj = el.getAsJsonObject();
        for (String key : obj.keySet()) {
            if (!"defaultLimit".equals(key) && !"maxLimit".equals(key)) {
                throw bad(origin + ": \"api.pagination\" has an unknown key \"" + key
                        + "\" (expected \"defaultLimit\" and \"maxLimit\")");
            }
        }
        if (!obj.has("defaultLimit") || !obj.has("maxLimit")) {
            throw bad(origin + ": \"api.pagination\" needs both \"defaultLimit\" and \"maxLimit\"");
        }
        long defaultLimit = pageSize(obj.get("defaultLimit"), "defaultLimit", origin);
        long maxLimit = pageSize(obj.get("maxLimit"), "maxLimit", origin);
        if (defaultLimit > maxLimit) {
            throw bad(origin + ": \"api.pagination.defaultLimit\" must not exceed \"api.pagination.maxLimit\"");
        }
        return new ApiSettings.Pagination(defaultLimit, maxLimit);
    }

    private static long pageSize(JsonElement v, String key, String origin) {
        java.math.BigDecimal n = v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber()
                ? v.getAsBigDecimal() : null;
        if (n == null || n.signum() <= 0 || n.stripTrailingZeros().scale() > 0 || n.compareTo(java.math.BigDecimal.valueOf(Integer.MAX_VALUE)) > 0) {
            throw bad(origin + ": \"api.pagination." + key + "\" must be a positive integer");
        }
        return n.longValueExact();
    }

    /**
     * The {@code enums} block: {@code maxLength}, a positive integer, is the column length of a
     * string-stored enum with no {@code @maxLength}. An unknown key, a wrong-typed value, or a
     * non-object block is refused, the same rule as {@code naming}.
     */
    private static EnumDefaults parseEnums(JsonElement enums, String origin) {
        if (enums == null) return EnumDefaults.DEFAULT;
        if (!enums.isJsonObject()) {
            throw new MetaDataException(origin + ": \"enums\" must be an object", ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        Long maxLength = null;
        JsonObject obj = enums.getAsJsonObject();
        for (String key : obj.keySet()) {
            if (!"maxLength".equals(key)) {
                throw new MetaDataException(
                        origin + ": \"enums\" has unknown key \"" + key + "\"; expected \"maxLength\"",
                        ErrorCode.ERR_BAD_ATTR_VALUE);
            }
            JsonElement v = obj.get(key);
            java.math.BigDecimal n = v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber()
                    ? v.getAsBigDecimal() : null;
            if (n == null || n.signum() <= 0 || n.stripTrailingZeros().scale() > 0) {
                throw new MetaDataException(
                        origin + ": \"enums.maxLength\" must be a positive integer",
                        ErrorCode.ERR_BAD_ATTR_VALUE);
            }
            maxLength = n.longValueExact();
        }
        return maxLength == null ? EnumDefaults.DEFAULT : new EnumDefaults(maxLength);
    }

    /** Mirrors the TS {@code DependencyName} regex (DESIGN §3.1). */
    private static final java.util.regex.Pattern DEPENDENCY_NAME =
            java.util.regex.Pattern.compile("^[a-z0-9][a-z0-9._-]*$");

    private static final List<String> DEPENDENCY_TRANSPORTS = List.of("path", "npm", "python", "maven", "nuget");

    /** The packaged transports name a package in a cache that holds many versions, so they carry a {@code version}. */
    private static boolean isVersioned(String transport) {
        return transport.equals("maven") || transport.equals("nuget");
    }

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
                throw bad(ctx + "exactly one of 'path' / 'npm' / 'python' / 'maven' / 'nuget' is required)");
            }
            String transport = transports.get(0);
            Map<String, String> spec = new LinkedHashMap<>();
            spec.put("name", nameEl.getAsString());
            spec.put(transport, nonEmptyString(dep.get(transport), ctx + "'" + transport + "' must be a non-empty string)"));

            java.util.Set<String> allowed = new java.util.HashSet<>(List.of("name", transport));
            if (!transport.equals("path")) allowed.add("dir");
            if (isVersioned(transport)) allowed.add("version");
            List<String> extra = new ArrayList<>();
            for (String k : dep.keySet()) if (!allowed.contains(k)) extra.add(k);
            if (!extra.isEmpty()) {
                java.util.Collections.sort(extra);
                throw bad(ctx + "unknown key(s): " + extra + ")");
            }
            if (isVersioned(transport)) {
                spec.put("version", nonEmptyString(dep.get("version"),
                        ctx + "'version' is required beside '" + transport + "' and must be a non-empty string)"));
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

    /**
     * FR-023 — {@code requirements.inherit}. Refused like {@code naming}: an unknown key inside
     * {@code requirements} would otherwise be a misspelt {@code inherit} that silently leaves the
     * ledger out.
     */
    private static List<String> parseRequirementsInherit(JsonElement requirements, String origin) {
        if (requirements == null || requirements.isJsonNull()) return List.of();
        if (!requirements.isJsonObject()) throw bad(origin + ": \"requirements\" must be an object");
        JsonObject obj = requirements.getAsJsonObject();
        for (String key : obj.keySet()) {
            if (!"inherit".equals(key)) {
                throw bad(origin + ": \"requirements\" has unknown key \"" + key + "\"; expected \"inherit\"");
            }
        }
        JsonElement inherit = obj.get("inherit");
        if (inherit == null || inherit.isJsonNull()) return List.of();
        return stringArray(inherit, "requirements.inherit", origin);
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
        WireFormat.Durations durations = WireFormat.Durations.NATIVE;
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
                case "durations" -> {
                    durations = raw == null ? null : WireFormat.durationsOf(raw);
                    if (durations == null) {
                        throw new MetaDataException(
                                origin + ": \"wire.durations\" must be one of \"native\", \"iso\"",
                                ErrorCode.ERR_BAD_ATTR_VALUE);
                    }
                }
                default -> throw new MetaDataException(
                        origin + ": \"wire\" has unknown key \"" + key
                                + "\"; expected \"decimals\", \"nullMembers\" and/or \"durations\"",
                        ErrorCode.ERR_BAD_ATTR_VALUE);
            }
        }
        return new WireFormat(decimals, nullMembers, durations);
    }
}
