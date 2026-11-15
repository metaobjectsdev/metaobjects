package com.metaobjects.mojo;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Predicate;
import java.util.stream.Stream;

/**
 * The whole-run codegen fingerprint of ADR-0062, JVM edition.
 *
 * <p>A fingerprint is one SHA-256 folded over a sorted list of small named {@link Input}
 * entries (a kind, a name, a content hash). The entries are what a later per-object key would
 * reuse for the subset of inputs that reaches one generator and one object. Timestamps are
 * never an input: a file is its content.
 *
 * <p>The stored form lives beside the committed hash manifest, in
 * {@code .metaobjects/.gen-state/.fingerprint-java-<owner>.json}, and is not committed. It
 * records the folded key, the declared extra inputs that went into it (so a check, which runs
 * before any generator is constructed, can hash them), and the generated files that live
 * outside the project root (the manifest records only the ones inside it).
 */
final class GenFingerprint {

    private GenFingerprint() {}

    /** Bump when what goes into the key changes, so no stored fingerprint survives it. */
    static final int FORMAT_VERSION = 2;

    /** One named input: what kind it is, what it is called, and the hash of its content. */
    record Input(String kind, String name, String sha256) {
        String line() {
            return kind + "\t" + name + "\t" + sha256;
        }
    }

    /** What a successful run stored. */
    record Stored(int formatVersion, String key, List<String> extras, List<String> untracked,
                  java.util.Map<String, String> outputs) {}

    // ---------------------------------------------------------------- hashing

    static String sha256(byte[] bytes) {
        return hex(digest().digest(bytes));
    }

    static String sha256(String text) {
        return sha256(text.getBytes(StandardCharsets.UTF_8));
    }

    private static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    private static String hex(byte[] hash) {
        StringBuilder sb = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    /** Content hashes of files already read this JVM, keyed by path, size and mtime: a build
     *  that runs the goal in many modules reads one jar once. Only an accelerator, never an
     *  input: a file whose size or mtime moved is read again. */
    private static final Map<String, String> FILE_HASHES = new ConcurrentHashMap<>();

    /** SHA-256 of one file's bytes. */
    static String hashFile(Path file) throws IOException {
        Path abs = file.toAbsolutePath().normalize();
        String memo = abs + "|" + Files.size(abs) + "|" + Files.getLastModifiedTime(abs).toMillis();
        String known = FILE_HASHES.get(memo);
        if (known != null) return known;
        MessageDigest d = digest();
        byte[] buf = new byte[1 << 16];
        try (InputStream in = Files.newInputStream(abs)) {
            for (int n; (n = in.read(buf)) > 0; ) d.update(buf, 0, n);
        }
        String hash = hex(d.digest());
        FILE_HASHES.put(memo, hash);
        return hash;
    }

    /** One entry for a file. A file that does not exist hashes to {@code "missing"}, so a
     *  path that appears later changes the key. */
    static Input fileInput(String kind, String name, Path file) throws IOException {
        return new Input(kind, name, Files.isRegularFile(file) ? hashFile(file) : "missing");
    }

    /** One entry per file under {@code root} (or for {@code root} itself when it is a file),
     *  named relative to {@code namePrefix}; a root that is absent is one {@code missing}
     *  entry. {@code skip} is told each path relative to the root and drops it. */
    static void addTree(List<Input> into, String kind, String namePrefix, Path root, Predicate<Path> skip)
            throws IOException {
        if (Files.isRegularFile(root)) {
            into.add(fileInput(kind, namePrefix, root));
            return;
        }
        if (!Files.isDirectory(root)) {
            into.add(new Input(kind, namePrefix, "missing"));
            return;
        }
        List<Path> files;
        try (Stream<Path> walk = Files.walk(root)) {
            files = walk.filter(Files::isRegularFile)
                    .filter(p -> !skip.test(root.relativize(p)))
                    .sorted(Comparator.comparing(p -> root.relativize(p).toString()))
                    .toList();
        }
        into.add(new Input(kind, namePrefix + "/", "dir"));
        for (Path f : files) {
            into.add(fileInput(kind, namePrefix + "/" + root.relativize(f).toString().replace('\\', '/'), f));
        }
    }

    /** The one key: SHA-256 over the sorted lines of every entry. */
    static String fold(List<Input> inputs) {
        List<String> lines = new ArrayList<>(inputs.size());
        for (Input in : inputs) lines.add(in.line());
        lines.sort(Comparator.naturalOrder());
        return sha256(String.join("\n", lines));
    }

    /** A short stable name for one execution's generator/output-dir configuration. */
    static String ownerTag(List<String> ownerLines) {
        List<String> sorted = new ArrayList<>(ownerLines);
        sorted.sort(Comparator.naturalOrder());
        return sha256(String.join("\n", sorted)).substring(0, 12);
    }

    // ---------------------------------------------------------------- storage

    static final String FILE_PREFIX = ".fingerprint-java-";

    static Path fileFor(Path genStateDir, String ownerTag) {
        return genStateDir.resolve(FILE_PREFIX + ownerTag + ".json");
    }

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

    /** The stored fingerprint, or empty when there is none or it cannot be read. */
    static Optional<Stored> read(Path file) {
        if (!Files.isRegularFile(file)) return Optional.empty();
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) return Optional.empty();
            JsonObject o = parsed.getAsJsonObject();
            return Optional.of(new Stored(
                    o.get("formatVersion").getAsInt(),
                    o.get("key").getAsString(),
                    strings(o.get("extras")),
                    strings(o.get("untracked")),
                    map(o.get("outputs"))));
        } catch (IOException | RuntimeException e) {
            return Optional.empty();
        }
    }

    private static java.util.Map<String, String> map(JsonElement e) {
        java.util.Map<String, String> out = new java.util.TreeMap<>();
        if (e != null && e.isJsonObject()) e.getAsJsonObject().entrySet().forEach(x -> out.put(x.getKey(), x.getValue().getAsString()));
        return out;
    }

    private static List<String> strings(JsonElement e) {
        List<String> out = new ArrayList<>();
        if (e != null && e.isJsonArray()) e.getAsJsonArray().forEach(x -> out.add(x.getAsString()));
        return out;
    }

    static void write(Path file, Stored stored) {
        JsonObject o = new JsonObject();
        o.addProperty("formatVersion", stored.formatVersion());
        o.addProperty("key", stored.key());
        o.add("extras", array(stored.extras()));
        o.add("untracked", array(stored.untracked()));
        JsonObject outs = new JsonObject();
        new java.util.TreeMap<>(stored.outputs()).forEach(outs::addProperty);
        o.add("outputs", outs);
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, GSON.toJson(o) + "\n", StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Could not write the codegen fingerprint at " + file, e);
        }
    }

    private static JsonArray array(List<String> values) {
        JsonArray a = new JsonArray();
        values.forEach(a::add);
        return a;
    }

    static void delete(Path file) {
        try {
            Files.deleteIfExists(file);
        } catch (IOException e) {
            throw new UncheckedIOException("Could not remove the codegen fingerprint at " + file, e);
        }
    }
}
