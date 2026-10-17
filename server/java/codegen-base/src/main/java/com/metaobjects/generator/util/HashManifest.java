package com.metaobjects.generator.util;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonSyntaxException;
import com.google.gson.reflect.TypeToken;

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
 */
public final class HashManifest {

    private HashManifest() {}

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
     * Load the manifest. An absent or corrupt one reads as EMPTY, which fails closed —
     * every path then reads as unrecorded rather than being guessed at.
     */
    public static Map<String, String> load(Path genStateDir) {
        Path path = pathFor(genStateDir);
        if (!Files.isRegularFile(path)) return new LinkedHashMap<>();
        try {
            String json = Files.readString(path, StandardCharsets.UTF_8);
            Map<String, String> parsed = GSON.fromJson(json, new TypeToken<Map<String, String>>() {}.getType());
            return parsed == null ? new LinkedHashMap<>() : new LinkedHashMap<>(parsed);
        } catch (IOException | JsonSyntaxException e) {
            return new LinkedHashMap<>();
        }
    }

    /**
     * Persist the manifest with SORTED keys, pretty-printed, one trailing newline.
     * Sorted because the file is committed: insertion order would make the diff — and any
     * merge conflict between two people who both regenerated — depend on which generator
     * happened to run first.
     */
    public static void save(Path genStateDir, Map<String, String> hashes) {
        try {
            Files.createDirectories(genStateDir);
            Map<String, String> ordered = new TreeMap<>(hashes);
            String json = GSON.toJson(ordered, new TypeToken<Map<String, String>>() {}.getType());
            Files.writeString(pathFor(genStateDir), json + "\n", StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Could not write codegen hash manifest at " + genStateDir, e);
        }
    }

    /** Record that {@code key} was written with {@code content}: load, mutate, save. */
    public static void record(Path genStateDir, String key, String content) {
        Map<String, String> hashes = load(genStateDir);
        hashes.put(key, contentHash(content));
        save(genStateDir, hashes);
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
