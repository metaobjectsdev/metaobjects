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
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import java.util.TreeMap;

/**
 * The committed codegen hash manifest — how a run tells its own prior output from a hand
 * edit, replacing the {@code GENERATED} marker as the sole overwrite signal.
 *
 * <p>Mirrors the shape and algorithm the TypeScript, Python and C# ports already share:
 * a JSON object {@code { "<project-relative path>": "<sha-256 hex>" }}, keys sorted,
 * pretty-printed, one trailing newline, split into one file per model package under
 * {@code <project>/.metaobjects/.gen-state/.hashes/} (ADR-0064 Amendment 1; a pre-1.3.0
 * {@code .hashes.json} is still read and is removed by the next write) where {@code <project>} is the
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
 *
 * <p>A file a write run rendered from one metadata node also carries {@code "generatedBy"} (the
 * generator's stable name) and {@code "sourceNode"} (the node's resolution key, {@code pkg::Name}),
 * after the owner fields; a whole-model file carries neither ({@link Provenance}).
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

    /**
     * What produced one generated file: the generator, and the metadata node (its resolution key,
     * {@code pkg::Name}) it was rendered from, or {@code null} for a file rendered from the whole
     * model. Written as {@code generatedBy} and {@code sourceNode}, the fields every port shares;
     * deliberately NOT the {@code generator} owner field, which is an ownership claim the orphan
     * sweep acts on.
     */
    public record Provenance(String generatedBy, String sourceNode) {}

    /** The pre-1.3.0 single manifest, still read (underneath the package files) and removed by the next write. */
    private static final String LEGACY_FILE_NAME = ".hashes.json";
    /** The directory of per-package manifests (ADR-0064 Amendment 1). */
    private static final String DIR_NAME = ".hashes";
    /** The manifest of every path that belongs to no package. */
    public static final String ROOT_FILE_NAME = ".root.json";
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

    private static Path legacyPath(Path genStateDir) {
        return genStateDir.resolve(LEGACY_FILE_NAME);
    }

    private static Path dirPath(Path genStateDir) {
        return genStateDir.resolve(DIR_NAME);
    }

    /** A model object as placement sees it: its name and its {@code ::}-separated package ({@code ""}: none). */
    public record ModelObject(String name, String pkg) {}

    /**
     * Which package manifest a recorded path belongs to, from the loaded model's root-level
     * objects: the entry's {@code sourceNode} first, then the object whose name the file's
     * stem begins with (ADR-0064 Amendment 1 section 3). A pure function of the model and the
     * entry, so an entry moves only when its object does.
     */
    public static final class Placement {
        // Each name's lowercase words (joined by a space) -> the packages declaring a name of those words.
        private final Map<String, java.util.Set<String>> packagesByWords = new java.util.HashMap<>();

        public Placement(Iterable<ModelObject> objects) {
            for (ModelObject o : objects) {
                if (o.name() == null || o.name().isEmpty()) continue;
                List<String> words = words(o.name());
                if (words.isEmpty()) continue;
                packagesByWords.computeIfAbsent(String.join(" ", words), k -> new java.util.HashSet<>())
                        .add(o.pkg() == null ? "" : o.pkg());
            }
        }

        /** The package of {@code path}'s manifest, or {@code null} for the root manifest. {@code entry} may be null. */
        public String packageOf(String path, JsonObject entry) {
            String sourceNode = entry == null ? null : stringField(entry, "sourceNode");
            if (sourceNode != null) {
                int dot = sourceNode.indexOf('.');
                String qualified = dot < 0 ? sourceNode : sourceNode.substring(0, dot);
                int sep = qualified.lastIndexOf("::");
                return sep <= 0 ? null : qualified.substring(0, sep);
            }
            String base = path.substring(path.lastIndexOf('/') + 1);
            int dot = base.indexOf('.');
            List<String> stem = words(dot < 0 ? base : base.substring(0, dot));
            for (int n = stem.size(); n >= 1; n--) {
                java.util.Set<String> packages = packagesByWords.get(String.join(" ", stem.subList(0, n)));
                if (packages == null) continue;
                if (packages.size() != 1) return null;
                String only = packages.iterator().next();
                return only.isEmpty() ? null : only;
            }
            return null;
        }

        /** Lowercase words of a name: split at '_' and '-', before an uppercase letter after a lowercase
         *  letter or digit, and before the last capital of a run that a lowercase letter follows. */
        static List<String> words(String name) {
            List<String> out = new ArrayList<>();
            StringBuilder word = new StringBuilder();
            for (int i = 0; i < name.length(); i++) {
                char c = name.charAt(i);
                if (c == '_' || c == '-') {
                    flush(out, word);
                    continue;
                }
                boolean upper = c >= 'A' && c <= 'Z';
                if (upper && word.length() > 0) {
                    char prev = name.charAt(i - 1);
                    boolean prevLowerOrDigit = (prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9');
                    boolean prevUpper = prev >= 'A' && prev <= 'Z';
                    boolean nextLower = i + 1 < name.length() && name.charAt(i + 1) >= 'a' && name.charAt(i + 1) <= 'z';
                    if (prevLowerOrDigit || (prevUpper && nextLower)) flush(out, word);
                }
                word.append(Character.toLowerCase(c));
            }
            flush(out, word);
            return out;
        }

        private static void flush(List<String> out, StringBuilder word) {
            if (word.length() > 0) out.add(word.toString());
            word.setLength(0);
        }
    }

    /** The manifest file name of {@code pkg} ({@code null} or empty: the root manifest). */
    public static String fileName(String pkg) {
        if (pkg == null || pkg.isEmpty()) return ROOT_FILE_NAME;
        StringBuilder sb = new StringBuilder();
        boolean first = true;
        for (String segment : pkg.split("::", -1)) {
            if (!first) sb.append('.');
            first = false;
            for (byte b : segment.getBytes(StandardCharsets.UTF_8)) {
                int c = b & 0xFF;
                if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
                    sb.append((char) c);
                } else {
                    sb.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16)))
                            .append(Character.toUpperCase(Character.forDigit(c & 0xF, 16)));
                }
            }
        }
        return sb.append(".json").toString();
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
        return hasLegacy(genStateDir) || !packageFiles(genStateDir).isEmpty();
    }

    /** Whether the pre-1.3.0 single manifest is still on disk: the next write run migrates it. */
    public static boolean hasLegacy(Path genStateDir) {
        return Files.isRegularFile(legacyPath(genStateDir));
    }

    /** The per-package manifest files, in file-name order. */
    private static List<Path> packageFiles(Path genStateDir) {
        Path dir = dirPath(genStateDir);
        if (!Files.isDirectory(dir)) return List.of();
        try (Stream<Path> s = Files.list(dir)) {
            return s.filter(p -> p.getFileName().toString().endsWith(".json") && Files.isRegularFile(p))
                    .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                    .collect(Collectors.toList());
        } catch (IOException e) {
            return List.of();
        }
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

    /** Load the provenance of every entry that names a generator; a plain entry is absent. */
    public static Map<String, Provenance> loadProvenance(Path genStateDir) {
        Map<String, Provenance> out = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> e : entries(genStateDir).entrySet()) {
            if (!e.getValue().isJsonObject()) continue;
            JsonObject entry = e.getValue().getAsJsonObject();
            String generatedBy = stringField(entry, "generatedBy");
            if (generatedBy != null) out.put(e.getKey(), new Provenance(generatedBy, stringField(entry, "sourceNode")));
        }
        return out;
    }

    /** The union of every manifest file: the legacy one underneath, package files in name order on top. */
    private static Map<String, JsonElement> entries(Path genStateDir) {
        Map<String, JsonElement> out = new LinkedHashMap<>();
        readInto(legacyPath(genStateDir), out);
        for (Path p : packageFiles(genStateDir)) readInto(p, out);
        return out;
    }

    private static Map<String, JsonElement> readInto(Path path, Map<String, JsonElement> out) {
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

    /** The package file each key is recorded in now (a key only in the legacy file is not listed). */
    private static Map<String, String> fileOfKeys(Path genStateDir) {
        Map<String, String> out = new LinkedHashMap<>();
        for (Path p : packageFiles(genStateDir)) {
            for (String key : readInto(p, new LinkedHashMap<>()).keySet()) out.put(key, p.getFileName().toString());
        }
        return out;
    }

    private static String stringField(JsonObject object, String field) {
        JsonElement v = object.get(field);
        return v != null && v.isJsonPrimitive() && v.getAsJsonPrimitive().isString() ? v.getAsString() : null;
    }

    /** {@link #save(Path, Map, Map, Placement)} with no model: each entry stays in the file it is in, else the root. */
    public static void save(Path genStateDir, Map<String, String> hashes, Map<String, Owner> owners) {
        save(genStateDir, hashes, owners, null);
    }

    /**
     * Persist the manifest as one file per package: each file holds exactly what the single
     * manifest held for its paths, with SORTED keys, pretty-printed, one trailing newline. A key
     * with an owner is written as {@code { "hash", "generator", "outputDir" }}, one without as
     * the plain hash; any other field the entry already carried (another port's provenance) is
     * kept. Sorted because the files are committed: insertion order would make the diff, and
     * any merge between two people who both regenerated, depend on which generator ran first.
     *
     * <p>Each entry is filed by {@code placement} ({@code null}: where it already is, else the
     * root). Only files whose bytes change are written, a package file left empty is deleted,
     * the root file stays as {@code {}} when nothing is recorded at all, and the legacy single
     * file is removed.
     */
    public static void save(Path genStateDir, Map<String, String> hashes, Map<String, Owner> owners,
                            Placement placement) {
        save(genStateDir, hashes, owners, placement, Map.of());
    }

    /**
     * {@link #save(Path, Map, Map, Placement)} that also writes {@code provenance}. A key with a
     * source node becomes {@code { "hash", <owner fields and other fields, in order>, "generatedBy",
     * "sourceNode" }}; a key whose provenance has none returns to the plain hash (or to
     * {@code { "hash", <other fields> }} when it has owner fields). A key absent from
     * {@code provenance} keeps whatever it carried, and a provenance key with no hash records nothing.
     */
    public static void save(Path genStateDir, Map<String, String> hashes, Map<String, Owner> owners,
                            Placement placement, Map<String, Provenance> provenance) {
        try {
            Map<String, JsonElement> existing = entries(genStateDir);
            Map<String, String> currentFile = placement == null ? fileOfKeys(genStateDir) : Map.of();
            Map<String, JsonObject> files = new java.util.TreeMap<>();
            for (Map.Entry<String, String> e : new TreeMap<>(hashes).entrySet()) {
                String key = e.getKey();
                Owner owner = owners.get(key);
                JsonElement prior = existing.get(key);
                Provenance prov = provenance.get(key);
                JsonObject extras = new JsonObject();
                if (prior != null && prior.isJsonObject()) {
                    for (Map.Entry<String, JsonElement> f : prior.getAsJsonObject().entrySet()) {
                        String name = f.getKey();
                        if (!name.equals("hash") && !name.equals("generator") && !name.equals("outputDir")
                                && !name.equals("owner")
                                && !(prov != null && (name.equals("generatedBy") || name.equals("sourceNode")))) {
                            extras.add(name, f.getValue());
                        }
                    }
                }
                JsonElement value;
                boolean stamped = prov != null && prov.sourceNode() != null;
                if (owner == null && extras.size() == 0 && !stamped) {
                    value = new com.google.gson.JsonPrimitive(e.getValue());
                } else {
                    JsonObject entry = new JsonObject();
                    entry.addProperty("hash", e.getValue());
                    if (owner != null) {
                        entry.addProperty("generator", owner.generator());
                        entry.addProperty("outputDir", owner.outputDir());
                    }
                    for (Map.Entry<String, JsonElement> f : extras.entrySet()) entry.add(f.getKey(), f.getValue());
                    if (stamped) {
                        entry.addProperty("generatedBy", prov.generatedBy());
                        entry.addProperty("sourceNode", prov.sourceNode());
                    }
                    value = entry;
                }
                String file = placement != null
                        ? fileName(placement.packageOf(key, value.isJsonObject() ? value.getAsJsonObject() : null))
                        : currentFile.getOrDefault(key, ROOT_FILE_NAME);
                files.computeIfAbsent(file, k -> new JsonObject()).add(key, value);
            }
            if (files.isEmpty()) files.put(ROOT_FILE_NAME, new JsonObject());

            Path dir = dirPath(genStateDir);
            Files.createDirectories(dir);
            for (Map.Entry<String, JsonObject> f : files.entrySet()) {
                writeIfChanged(dir.resolve(f.getKey()), GSON.toJson(f.getValue()) + "\n");
            }
            for (Path stale : packageFiles(genStateDir)) {
                if (!files.containsKey(stale.getFileName().toString())) Files.delete(stale);
            }
            if (Files.deleteIfExists(legacyPath(genStateDir))) ensureGitignore(genStateDir);   // only a migrating write
        } catch (IOException e) {
            throw new UncheckedIOException("Could not write codegen hash manifest at " + genStateDir, e);
        }
    }

    private static void writeIfChanged(Path path, String text) throws IOException {
        if (Files.isRegularFile(path) && Files.readString(path, StandardCharsets.UTF_8).equals(text)) return;
        Files.writeString(path, text, StandardCharsets.UTF_8);
    }

    private static final String GITIGNORE_RULE = ".gen-state/*";
    private static final String GITIGNORE_LEGACY_NEGATION = "!.gen-state/.hashes.json";
    private static final String GITIGNORE_DIR_NEGATION = "!.gen-state/.hashes/";

    /**
     * Run by a migrating write only. The scaffolded {@code .metaobjects/.gitignore} ignores
     * {@code .gen-state/*} and re-includes the manifest; the new directory needs its own negation.
     * With the rule present, the legacy negation is replaced by {@code !.gen-state/.hashes/} (or the
     * new line goes right after the rule when there was none); a file that already has the new line
     * only loses the legacy one. A file with no such rule is left alone.
     */
    private static void ensureGitignore(Path genStateDir) throws IOException {
        Path parent = genStateDir.toAbsolutePath().getParent();
        if (parent == null) return;
        Path file = parent.resolve(".gitignore");
        if (!Files.isRegularFile(file)) return;
        String[] lines = Files.readString(file, StandardCharsets.UTF_8).split("\n", -1);
        boolean hasRule = false;
        boolean hasNew = false;
        for (String l : lines) {
            String t = l.trim();
            if (t.equals(GITIGNORE_RULE)) hasRule = true;
            if (t.equals(GITIGNORE_DIR_NEGATION)) hasNew = true;
        }
        if (!hasRule) return;
        List<String> out = new ArrayList<>();
        boolean added = hasNew;
        boolean afterRule = false;
        for (String l : lines) {
            String t = l.trim();
            if (t.equals(GITIGNORE_LEGACY_NEGATION)) {
                if (!added) { out.add(GITIGNORE_DIR_NEGATION); added = true; }
                continue;
            }
            out.add(l);
            if (t.equals(GITIGNORE_RULE)) afterRule = true;
        }
        if (!added && afterRule) {
            int at = out.indexOf(GITIGNORE_RULE) + 1;
            out.add(at, GITIGNORE_DIR_NEGATION);
        }
        String text = String.join("\n", out);
        if (!text.equals(String.join("\n", lines))) Files.writeString(file, text, StandardCharsets.UTF_8);
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

    /**
     * Record, on each recorded path's entry, the generator that wrote it and the node it was
     * rendered from ({@link #save(Path, Map, Map, Placement, Map)} states the entry shapes). A path
     * with no recorded hash is left alone: this describes what a write recorded, it never records
     * one. Nothing is written when no entry changes.
     */
    public static void recordProvenance(Path genStateDir, Map<String, Provenance> provenance, Placement placement) {
        Map<String, String> hashes = load(genStateDir);
        Map<String, Provenance> applied = new LinkedHashMap<>();
        for (Map.Entry<String, Provenance> e : provenance.entrySet()) {
            if (hashes.containsKey(e.getKey())) applied.put(e.getKey(), e.getValue());
        }
        if (applied.isEmpty()) return;
        save(genStateDir, hashes, loadOwners(genStateDir), placement, applied);
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
