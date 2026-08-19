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
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;

import java.io.IOException;
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
 * <p>Reads only {@code schema_version} and {@code sources}. The file also carries
 * TypeScript-owned keys ({@code pending_in_git}, {@code confidence_thresholds},
 * {@code extract}, {@code migrate}, {@code scope}); those are IGNORED rather than
 * modeled, so a new TS-only key never becomes a four-port change. {@code scope} in
 * particular is entirely out of scope for this reader — see
 * {@code docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md} §4.
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

    private NeutralConfig(List<Map<String, String>> sources) {
        this.sources = List.copyOf(sources);
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

        JsonElement parsed;
        try {
            parsed = JsonParser.parseString(content);
        } catch (JsonSyntaxException e) {
            throw new MetaDataException(
                    path + " exists but could not be parsed as JSON: " + e.getMessage(),
                    ErrorCode.ERR_MALFORMED_JSON);
        }

        if (!parsed.isJsonObject()) {
            throw new MetaDataException(
                    path + " must contain a JSON object",
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
                    path + ": unsupported schema_version (expected " + SUPPORTED_SCHEMA_VERSION + ")",
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
                    path + ": \"sources\" must be an array",
                    ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        if (srcs != null) {
            for (JsonElement el : srcs.getAsJsonArray()) {
                if (!el.isJsonObject()) {
                    throw new MetaDataException(
                            path + ": each \"sources\" entry must be an object",
                            ErrorCode.ERR_BAD_ATTR_VALUE);
                }
                JsonObject entry = el.getAsJsonObject();
                if (entry.size() != 1) {
                    throw new MetaDataException(
                            path + ": each \"sources\" entry must have exactly one key",
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
                                path + ": \"sources\" entry \"" + e.getKey() + "\" must be a string",
                                ErrorCode.ERR_BAD_ATTR_VALUE);
                    }
                    String value = v.getAsString();
                    if (value.strip().isEmpty()) {
                        throw new MetaDataException(
                                path + ": \"sources\" entry \"" + e.getKey() + "\" must not be empty",
                                ErrorCode.ERR_BAD_ATTR_VALUE);
                    }
                    spec.put(e.getKey(), value);
                }
                specs.add(spec);
            }
        }

        // Unknown top-level keys (including `scope`/`migrate`) are IGNORED by
        // design — see the class javadoc.
        return Optional.of(new NeutralConfig(specs));
    }
}
