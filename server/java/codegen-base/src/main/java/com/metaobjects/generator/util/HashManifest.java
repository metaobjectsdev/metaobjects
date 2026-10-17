package com.metaobjects.generator.util;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * The committed codegen hash manifest — how a run tells its own prior output from a hand
 * edit, replacing the {@code GENERATED} marker as the sole overwrite signal.
 *
 * <p>Mirrors the shape and algorithm the TypeScript, Python and C# ports already share:
 * a JSON object {@code { "<project-relative path>": "<sha-256 hex>" }}, keys sorted,
 * pretty-printed, one trailing newline, at
 * {@code <project>/.metaobjects/.gen-state/.hashes.json} where {@code <project>} is the
 * Maven project base dir. The KEYS are not meant to be portable between ports — each
 * keys relative to its own notion of "the project" — only the shape and the hashing
 * algorithm (sha-256 hex of the UTF-8 content) are shared, so identical content hashes
 * identically everywhere.
 *
 * <p>This file is meant to be COMMITTED: one hash per generated path, small and
 * reviewable, where a full snapshot of every previously-generated file would be a second
 * copy of everything. A hash already answers the only question the write decision needs:
 * is this file byte-for-byte what we wrote last time?
 *
 * <p>An entry this port writes also names its {@link Owner}, what emitted the file: the
 * generator's registry id and its output directory within the module, {@code "<path>": {
 * "hash": "<sha-256 hex>", "generator": "<id>", "outputDir": "<dir>" }}. The owner does
 * not depend on which Maven execution ran, so a command-line run, a renamed execution and
 * the lifecycle execution with the same configuration agree on it. An entry in the plain
 * {@code "<path>": "<hash>"} form, the form the other ports write, reads as recorded with
 * no owner, and so does an entry carrying the execution-id {@code "owner"} field an
 * earlier 8.1.0 build wrote.
 */
public final class HashManifest {

    private HashManifest() {}

    /** What emitted a recorded file: a generator's registry id and its module-relative
     *  output directory. */
    public record Owner(String generator, String outputDir) {
        @Override
        public String toString() {
            return generator + " -> " + outputDir;
        }
    }

    private static final String FILE_NAME = ".hashes.json";
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

    private static Path pathFor(Path genStateDir) {
        return genStateDir.resolve(FILE_NAME);
    }

    /** sha-256 hex (lowercase) of {@code content}'s UTF-8 bytes. */
    public static String contentHash(String content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(content.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is mandated by every JDK provider; this cannot happen in practice.
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    /**
     * Whether this project has a manifest AT ALL — distinct from "the manifest has no
     * entry for this path". A project with no manifest predates this toolchain's hash
     * manifest, so a file at a generated path with no record deserves adoption (if it
     * carries the marker) rather than a cold refusal.
     */
    public static boolean exists(Path genStateDir) {
        return Files.isRegularFile(pathFor(genStateDir));
    }

    /**
     * Load the manifest's hashes. An absent or corrupt one reads as EMPTY, which fails
     * closed — every path then reads as unrecorded rather than being guessed at.
     */
    public static Map<String, String> load(Path genStateDir) {
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> e : entries(genStateDir).entrySet()) {
            JsonElement value = e.getValue();
            if (value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()) {
                out.put(e.getKey(), value.getAsString());
            } else if (value.isJsonObject()) {
                String v = stringField(value.getAsJsonObject(), "hash");
                if (v != null) out.put(e.getKey(), v);
            }
        }
        return out;
    }

    /** Load the owner of every entry that names one; an entry with no owner is absent. */
    public static Map<String, Owner> loadOwners(Path genStateDir) {
        Map<String, Owner> out = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> e : entries(genStateDir).entrySet()) {
            if (!e.getValue().isJsonObject()) continue;
            String generator = stringField(e.getValue().getAsJsonObject(), "generator");
            String outputDir = stringField(e.getValue().getAsJsonObject(), "outputDir");
            if (generator != null && outputDir != null) out.put(e.getKey(), new Owner(generator, outputDir));
        }
        return out;
    }

    private static Map<String, JsonElement> entries(Path genStateDir) {
        Map<String, JsonElement> out = new LinkedHashMap<>();
        Path path = pathFor(genStateDir);
        if (!Files.isRegularFile(path)) return out;
        JsonElement parsed;
        try {
            parsed = JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8));
        } catch (IOException | JsonParseException e) {
            return out;
        }
        if (!parsed.isJsonObject()) return out;
        for (Map.Entry<String, JsonElement> e : parsed.getAsJsonObject().entrySet()) {
            out.put(e.getKey(), e.getValue());
        }
        return out;
    }

    private static String stringField(JsonObject object, String field) {
        JsonElement v = object.get(field);
        return v != null && v.isJsonPrimitive() && v.getAsJsonPrimitive().isString() ? v.getAsString() : null;
    }

    /**
     * Persist the manifest with SORTED keys, pretty-printed, one trailing newline. A key
     * with an owner is written as {@code { "hash", "generator", "outputDir" }}, one without
     * as the plain hash. Sorted because the file is committed: insertion order would make
     * the diff — and any merge conflict between two people who both regenerated — depend
     * on which generator happened to run first.
     */
    public static void save(Path genStateDir, Map<String, String> hashes, Map<String, Owner> owners) {
        try {
            Files.createDirectories(genStateDir);
            JsonObject root = new JsonObject();
            for (Map.Entry<String, String> e : new TreeMap<>(hashes).entrySet()) {
                Owner owner = owners.get(e.getKey());
                if (owner == null) {
                    root.addProperty(e.getKey(), e.getValue());
                } else {
                    JsonObject entry = new JsonObject();
                    entry.addProperty("hash", e.getValue());
                    entry.addProperty("generator", owner.generator());
                    entry.addProperty("outputDir", owner.outputDir());
                    root.add(e.getKey(), entry);
                }
            }
            Files.writeString(pathFor(genStateDir), GSON.toJson(root) + "\n", StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Could not write codegen hash manifest at " + genStateDir, e);
        }
    }

    /** Record that {@code owner} wrote {@code key} with {@code content}: load, mutate, save. */
    public static void record(Path genStateDir, String key, String content, Owner owner) {
        recordHash(genStateDir, key, contentHash(content), owner);
    }

    /** Record {@code hash} for {@code key}, owned by {@code owner} ({@code null}: no owner). */
    public static void recordHash(Path genStateDir, String key, String hash, Owner owner) {
        Map<String, String> hashes = load(genStateDir);
        Map<String, Owner> owners = loadOwners(genStateDir);
        hashes.put(key, hash);
        if (owner == null) owners.remove(key);
        else owners.put(key, owner);
        save(genStateDir, hashes, owners);
    }

    /** The hash recorded for {@code key}, or {@code null} if never recorded. */
    public static String recordedHash(Path genStateDir, String key) {
        return load(genStateDir).get(key);
    }

    /** Whether {@code current} is byte-for-byte what was recorded under {@code key}.
     *  FAILS CLOSED — {@code false} when it cannot be proven. */
    public static boolean isPristine(Path genStateDir, String key, String current) {
        String recorded = recordedHash(genStateDir, key);
        return recorded != null && recorded.equals(contentHash(current));
    }
}
