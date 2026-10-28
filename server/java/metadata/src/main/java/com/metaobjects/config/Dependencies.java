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
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.RegistryManifest;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * FR-023 — metadata dependencies: the lock/snapshot half a port needs to <em>consume</em> a
 * shared model (DESIGN §3, §4.2, §11). Mirrors {@code server/typescript/packages/sdk/src/dependencies.ts}
 * and the Python {@code metaobjects/config/dependencies.py}; the shared corpus
 * {@code fixtures/dependency-conformance/} pins the behavior.
 *
 * <p>This port <strong>reads</strong> the lock and the committed snapshot and never writes either:
 * the Node {@code meta deps sync} is the only writer (recorded decision), so there is no lock
 * byte contract here.
 */
public final class Dependencies {

    private Dependencies() {}

    /** Directory under {@code .metaobjects/} holding the synced snapshot, one subdirectory per dependency. */
    public static final String DEPS_DIR = "deps";

    /** {@code meta deps sync}'s output — the only writer (DESIGN §3.3). */
    public static final String LOCK_FILE = "deps.lock.json";

    /** Suffix of a dependency's canonical-JSON artifact file (DESIGN §3.5). */
    public static final String ARTIFACT_SUFFIX = ".metaobjects.json";

    /** Prefix of a dependency artifact's source id: {@code dep:<name>/<artifact>} (DESIGN §2.3). */
    public static final String SOURCE_ID_PREFIX = "dep:";

    /** Prefix of the {@code integrity} value: {@code sha256-} plus lowercase hex of the artifact bytes. */
    public static final String INTEGRITY_PREFIX = "sha256-";

    private static final String METAOBJECTS_DIR = ".metaobjects";

    private static final Pattern NAME = Pattern.compile("^[a-z0-9][a-z0-9._-]*$");
    private static final Pattern METAMODEL_VERSION = Pattern.compile("^\\d+\\.\\d+$");
    private static final Pattern INTEGRITY = Pattern.compile("^sha256-[0-9a-f]{64}$");

    private static final Set<String> LOCK_KEYS = Set.of("schema_version", "dependencies");
    private static final Set<String> LOCK_ENTRY_KEYS = Set.of(
            "version", "metamodelVersion", "artifact", "integrity", "packages", "nodes", "resolvedFrom");
    private static final List<String> RESOLVED_FROM_TRANSPORTS = List.of("path", "npm", "python");

    /** One lock entry, validated. */
    public record LockEntry(String version, String metamodelVersion, String artifact, String integrity,
                            List<String> packages, List<String> nodes) {}

    /** A resolved dependency, ready to load: its artifact path, the id it loads under, and what it exports. */
    public record ResolvedDependency(String name, String version, List<String> packages,
                                     List<String> nodes, Path artifactPath, String sourceId) {}

    /** {@code dep:<name>/<artifact>} — a dependency artifact's source id. */
    public static String sourceId(String name, String artifact) {
        return SOURCE_ID_PREFIX + name + "/" + artifact;
    }

    /** {@code sha256-} plus lowercase hex sha256 of {@code data}. */
    public static String sha256Integrity(byte[] data) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
            StringBuilder sb = new StringBuilder(INTEGRITY_PREFIX);
            for (byte b : digest) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required by the Java platform", e);
        }
    }

    /** The package half of a resolution key: {@code a::b::C} to {@code a::b}; a root-level {@code C} to {@code ""}. */
    public static String packageOf(String fqn) {
        int idx = fqn.lastIndexOf(MetaData.PKG_SEPARATOR);
        return idx == -1 ? "" : fqn.substring(0, idx);
    }

    // ---------------------------------------------------------------------------------------
    // Lock

    private static MetaDataException stale(String detail) {
        return new MetaDataException(detail + "; run `meta deps sync`", ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE);
    }

    private static MetaDataException lockInvalid(String message) {
        return new MetaDataException(message, ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE);
    }

    /**
     * Read {@code <configDir>/.metaobjects/deps.lock.json}, if present. A project declaring no
     * dependencies has no lock, which is not an error; a present but malformed file raises.
     */
    public static Optional<Map<String, LockEntry>> readLock(Path configDir) {
        Path path = configDir.resolve(METAOBJECTS_DIR).resolve(LOCK_FILE);
        if (!Files.isRegularFile(path)) return Optional.empty();
        JsonElement raw;
        try {
            raw = JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8));
        } catch (IOException | JsonSyntaxException e) {
            throw lockInvalid(path + " exists but could not be read as JSON: " + e.getMessage());
        }
        return Optional.of(validateLock(raw));
    }

    /** Validate a parsed lock (DESIGN §3.3); returns its entries keyed by dependency name, in key order. */
    public static Map<String, LockEntry> validateLock(JsonElement raw) {
        String context = LOCK_FILE;
        if (!raw.isJsonObject()) throw lockInvalid(context + ": must be an object");
        JsonObject obj = raw.getAsJsonObject();
        for (String key : obj.keySet()) {
            if (!LOCK_KEYS.contains(key)) throw lockInvalid(context + ": unknown key(s): [" + key + "]");
        }
        JsonElement version = obj.get("schema_version");
        if (version == null || !version.isJsonPrimitive() || !version.getAsJsonPrimitive().isNumber()
                || version.getAsDouble() != 1) {
            throw lockInvalid(context + ": 'schema_version' must be 1");
        }
        JsonElement deps = obj.get("dependencies");
        if (deps == null || !deps.isJsonObject()) throw lockInvalid(context + ": 'dependencies' must be an object");

        Map<String, LockEntry> out = new java.util.LinkedHashMap<>();
        String previous = null;
        for (Map.Entry<String, JsonElement> e : deps.getAsJsonObject().entrySet()) {
            String name = e.getKey();
            if (previous != null && previous.compareTo(name) >= 0) {
                throw lockInvalid(context + ": dependency keys must be sorted");
            }
            previous = name;
            String entryContext = context + " (" + name + ")";
            if (!e.getValue().isJsonObject()) throw lockInvalid(entryContext + ": must be an object");
            JsonObject entry = e.getValue().getAsJsonObject();
            for (String key : entry.keySet()) {
                if (!LOCK_ENTRY_KEYS.contains(key)) {
                    throw lockInvalid(entryContext + ": unknown key(s): [" + key + "]");
                }
            }
            validateResolvedFrom(entry.get("resolvedFrom"), entryContext);
            out.put(name, new LockEntry(
                    nonEmptyString(entry, "version", entryContext),
                    metamodelVersion(entry, entryContext),
                    artifact(entry, entryContext),
                    integrity(entry, entryContext),
                    sortedStrings(entry, "packages", entryContext),
                    sortedStrings(entry, "nodes", entryContext)));
        }
        return out;
    }

    private static String nonEmptyString(JsonObject obj, String field, String context) {
        JsonElement v = obj.get(field);
        if (v == null || !v.isJsonPrimitive() || !v.getAsJsonPrimitive().isString() || v.getAsString().isEmpty()) {
            throw lockInvalid(context + ": '" + field + "' must be a non-empty string");
        }
        return v.getAsString();
    }

    private static String metamodelVersion(JsonObject obj, String context) {
        JsonElement v = obj.get("metamodelVersion");
        if (v == null || !v.isJsonPrimitive() || !v.getAsJsonPrimitive().isString()
                || !METAMODEL_VERSION.matcher(v.getAsString()).matches()) {
            throw lockInvalid(context + ": 'metamodelVersion' must match ^\\d+\\.\\d+$");
        }
        return v.getAsString();
    }

    private static String artifact(JsonObject obj, String context) {
        JsonElement v = obj.get("artifact");
        if (v == null || !v.isJsonPrimitive() || !v.getAsJsonPrimitive().isString()
                || !v.getAsString().endsWith(ARTIFACT_SUFFIX)) {
            throw lockInvalid(context + ": 'artifact' must end with '" + ARTIFACT_SUFFIX + "'");
        }
        return v.getAsString();
    }

    private static String integrity(JsonObject obj, String context) {
        JsonElement v = obj.get("integrity");
        if (v == null || !v.isJsonPrimitive() || !v.getAsJsonPrimitive().isString()
                || !INTEGRITY.matcher(v.getAsString()).matches()) {
            throw lockInvalid(context + ": 'integrity' must match ^sha256-[0-9a-f]{64}$");
        }
        return v.getAsString();
    }

    private static List<String> sortedStrings(JsonObject obj, String field, String context) {
        JsonElement v = obj.get(field);
        if (v == null || !v.isJsonArray()) {
            throw lockInvalid(context + ": '" + field + "' must be an array of non-empty strings");
        }
        List<String> out = new ArrayList<>();
        for (JsonElement el : v.getAsJsonArray()) {
            if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString() || el.getAsString().isEmpty()) {
                throw lockInvalid(context + ": '" + field + "' must be an array of non-empty strings");
            }
            out.add(el.getAsString());
        }
        for (int i = 0; i + 1 < out.size(); i++) {
            if (out.get(i).compareTo(out.get(i + 1)) >= 0) {
                throw lockInvalid(context + ": '" + field + "' must be sorted");
            }
        }
        return out;
    }

    /** Exactly one of {@code path}/{@code npm}/{@code python}; {@code dir} only beside {@code npm}/{@code python}. */
    private static void validateResolvedFrom(JsonElement raw, String context) {
        if (raw == null || !raw.isJsonObject()) throw lockInvalid(context + ": 'resolvedFrom' must be an object");
        JsonObject obj = raw.getAsJsonObject();
        List<String> transports = new ArrayList<>();
        for (String t : RESOLVED_FROM_TRANSPORTS) if (obj.has(t)) transports.add(t);
        if (transports.size() != 1) {
            throw lockInvalid(context + ": 'resolvedFrom' must have exactly one of 'path' / 'npm' / 'python'");
        }
        String transport = transports.get(0);
        JsonElement value = obj.get(transport);
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString() || value.getAsString().isBlank()) {
            throw lockInvalid(context + ": 'resolvedFrom." + transport + "' must be a non-empty string");
        }
        Set<String> allowed = new HashSet<>(Set.of(transport));
        if (!transport.equals("path")) allowed.add("dir");
        for (String key : obj.keySet()) {
            if (!allowed.contains(key)) throw lockInvalid(context + ": 'resolvedFrom' unknown key(s): [" + key + "]");
        }
        if (obj.has("dir")) {
            JsonElement dir = obj.get("dir");
            if (!dir.isJsonPrimitive() || !dir.getAsJsonPrimitive().isString() || dir.getAsString().isBlank()) {
                throw lockInvalid(context + ": 'resolvedFrom.dir' must be a non-empty string");
            }
        }
    }

    // ---------------------------------------------------------------------------------------
    // Snapshot

    private static String metamodelMajor(String version) {
        return version.split("\\.")[0];
    }

    /**
     * Verify a project's committed snapshot against its lock and resolve the dependencies the load
     * will read FIRST (DESIGN §4.2 steps 2-3). Result order is dependency NAME order, never the
     * config's declaration order. A project with no dependencies and no lock resolves to {@code []}
     * without touching the filesystem.
     *
     * <p>Two failures are not staleness and get their own codes: a dependency published against a
     * different metamodel MAJOR ({@code ERR_DEPENDENCY_METAMODEL_INCOMPATIBLE}) and two
     * dependencies exporting one node ({@code ERR_DEPENDENCY_NODE_COLLISION}).
     */
    public static List<ResolvedDependency> verifySnapshot(Path configDir, List<Map<String, String>> specs,
                                                          Optional<Map<String, LockEntry>> lock) {
        List<String> declared = new ArrayList<>();
        for (Map<String, String> spec : specs) declared.add(spec.get("name"));

        if (lock.isEmpty()) {
            if (declared.isEmpty()) return List.of();
            throw stale(declared.size() + (declared.size() == 1 ? " dependency is" : " dependencies are")
                    + " declared (" + String.join(", ", declared) + ") but there is no "
                    + METAOBJECTS_DIR + "/" + LOCK_FILE);
        }

        Map<String, LockEntry> entries = lock.get();
        Set<String> declaredNames = new HashSet<>(declared);
        for (String name : entries.keySet()) {
            if (!declaredNames.contains(name)) {
                throw stale("" + METAOBJECTS_DIR + "/" + LOCK_FILE + " locks dependency \"" + name
                        + "\", which " + METAOBJECTS_DIR + "/config.json no longer declares");
            }
        }

        List<ResolvedDependency> resolved = new ArrayList<>();
        for (String name : new java.util.TreeSet<>(declaredNames)) {
            LockEntry entry = entries.get(name);
            if (entry == null) {
                throw stale("dependency \"" + name + "\" is declared but " + METAOBJECTS_DIR + "/" + LOCK_FILE
                        + " has no entry for it");
            }
            Path artifactPath = configDir.resolve(METAOBJECTS_DIR).resolve(DEPS_DIR).resolve(name)
                    .resolve(entry.artifact());
            byte[] data;
            try {
                data = Files.readAllBytes(artifactPath);
            } catch (IOException e) {
                throw stale("the committed snapshot for \"" + name + "\" is missing (expected " + artifactPath + ")");
            }
            String actual = sha256Integrity(data);
            if (!actual.equals(entry.integrity())) {
                throw stale("the committed snapshot for \"" + name + "\" does not match the lock — "
                        + artifactPath + " hashes to " + actual + ", the lock records " + entry.integrity());
            }
            if (!metamodelMajor(entry.metamodelVersion()).equals(metamodelMajor(RegistryManifest.METAMODEL_VERSION))) {
                throw new MetaDataException("dependency \"" + name + "\" was published against metamodel "
                        + entry.metamodelVersion() + "; this toolchain speaks " + RegistryManifest.METAMODEL_VERSION
                        + ". A different metamodel MAJOR is a different metadata contract — upgrade the "
                        + "toolchain, or use a release of \"" + name + "\" built against it.",
                        ErrorCode.ERR_DEPENDENCY_METAMODEL_INCOMPATIBLE);
            }
            resolved.add(new ResolvedDependency(name, entry.version(), entry.packages(), entry.nodes(),
                    artifactPath, sourceId(name, entry.artifact())));
        }

        // Collision is checked across the WHOLE resolved set, so the error names the two
        // dependencies in name order however the config declared them.
        Map<String, String> owner = new HashMap<>();
        for (ResolvedDependency dep : resolved) {
            for (String node : dep.nodes()) {
                String prior = owner.get(node);
                if (prior != null) {
                    throw new MetaDataException("dependencies \"" + prior + "\" and \"" + dep.name()
                            + "\" both export \"" + node + "\" — one fully-qualified node cannot come from two "
                            + "places, and whichever loaded second would silently win",
                            ErrorCode.ERR_DEPENDENCY_NODE_COLLISION);
                }
                owner.put(node, dep.name());
            }
        }
        return resolved;
    }

    // ---------------------------------------------------------------------------------------
    // Scope

    /**
     * Does some pattern in {@code patterns} name {@code pkg} LITERALLY (DESIGN §11.1 item 2)? Drop
     * the pattern's final segment — which names the node — and what remains must be wildcard-free
     * and equal to {@code pkg}. So {@code acme::common::**} and {@code acme::common::Address} both
     * name {@code acme::common}; {@code acme::**} and {@code **} reach its nodes but name nothing.
     */
    public static boolean explicitlyIncludes(List<String> patterns, String pkg) {
        if (patterns == null || patterns.isEmpty() || pkg.isEmpty()) return false;
        for (String pattern : patterns) {
            String named = packageOf(pattern);
            if (!named.isEmpty() && !named.contains("*") && named.equals(pkg)) return true;
        }
        return false;
    }

    /**
     * FR-023 §11.5 — a consumer may not declare a NEW top-level node into a package one of its
     * dependencies owns. Imported-ness is decided by PACKAGE, so such a node would otherwise be
     * excluded from this project's own codegen with no output and no error. An overlay of the
     * dependency's own node is untouched: its key is in {@code importedNodes}. Called AFTER the
     * loader's own errors, never before (an overlay whose target the upstream removed fails first,
     * with its own coded error).
     */
    public static void refuseUnownedPackages(MetaRoot root, Set<String> importedPackages, Set<String> importedNodes) {
        if (importedPackages == null || importedPackages.isEmpty()) return;
        // ADR-0039 SANCTIONED own-accessor case: a root-level scan. MetaRoot has no super, so own
        // and effective children are the same set, and the question is "what did this tree declare
        // at the top level", which is the own layer by definition.
        for (MetaObject node : root.getChildren(MetaObject.class, false)) {
            String key = node.getName();
            String pkg = packageOf(key);
            if (!importedPackages.contains(pkg) || importedNodes.contains(key)) continue;
            throw new MetaDataException("\"" + key + "\" is declared here, but the package \"" + pkg
                    + "\" belongs to a metadata dependency this project imports, and \"" + key
                    + "\" is not one of the nodes that dependency exports. Declare it in a package this project "
                    + "owns and 'extends' the dependency's node if it needs its shape; if it was meant to AMEND "
                    + "the dependency's node, give it that node's name and 'overlay: true'; if this project "
                    + "really does own \"" + pkg + "\", name it in 'scope.include' and stop importing it.",
                    ErrorCode.ERR_DEPENDENCY_PACKAGE_NOT_OWNED);
        }
    }
}
