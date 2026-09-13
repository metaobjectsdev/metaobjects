package com.metaobjects.library;

import com.metaobjects.loader.FileSource;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataSource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * Resolves {@link MetaDataSource} instances for the MetaObjects-shipped library packages.
 *
 * <p>Cross-port parity with the TypeScript {@code library-sources.ts} and the Python
 * {@code library_sources.py}: same package names, same refs, same resolution order.</p>
 *
 * <p><b>On-disk first</b> — when the repo-root {@code library/} tree is reachable (a dev
 * checkout, or an installed-from-source layout) a {@link FileSource} is returned, so edits
 * to the canonical YAML are picked up without regenerating anything. <b>Embedded
 * fallback</b> — when that directory is absent, which is every consumer of the published
 * jar, the content baked into {@link EmbeddedLibrary} is used instead.</p>
 */
public final class LibrarySources {

    private LibrarySources() {}

    /**
     * Library name to its manifest's LAYERS: layer token to that layer's ordered refs. The
     * CORE layer's token is the empty string.
     *
     * <p>Read from the embedded {@code library.json} manifests, not derived from the ref
     * names. This used to be package-granular — every ref under a library came back for a
     * bare {@code "ai"} — which under the layered design (FR-043 Amendment 1) would hand an
     * adopter the db layer they did not ask for, and with it a migration proposing tables.</p>
     */
    private static final Map<String, Map<String, List<String>>> LAYERS_BY_LIBRARY = buildLayers();

    /** Resolved once per process; {@code null} value means "looked, not present". */
    private static volatile Path cachedDir;
    private static volatile boolean dirResolved;

    private static Map<String, Map<String, List<String>>> buildLayers() {
        Map<String, Map<String, List<String>>> map = new LinkedHashMap<>();
        for (String name : new TreeSet<>(EmbeddedLibrary.MANIFESTS.keySet())) {
            // Hand-parsed rather than pulled through Jackson: this module is the metadata
            // core and does not depend on a JSON binder, and the shape read here is four
            // keys deep in a file this repo generates. A binder would be a dependency
            // added for a manifest we also write.
            map.put(name, parseLayers(EmbeddedLibrary.MANIFESTS.get(name)));
        }
        return map;
    }

    /** The {@code "layers"} object of a manifest: token to refs, in declaration order. */
    private static Map<String, List<String>> parseLayers(String manifestJson) {
        Map<String, List<String>> layers = new LinkedHashMap<>();
        java.util.regex.Matcher block = java.util.regex.Pattern
            .compile("\"layers\"\\s*:\\s*\\{(.*?)\\n  \\}", java.util.regex.Pattern.DOTALL)
            .matcher(manifestJson);
        if (!block.find()) return layers;
        java.util.regex.Matcher entry = java.util.regex.Pattern
            .compile("\"([^\"]*)\"\\s*:\\s*\\{[^}]*?\"refs\"\\s*:\\s*\\[([^\\]]*)\\]", java.util.regex.Pattern.DOTALL)
            .matcher(block.group(1));
        while (entry.find()) {
            List<String> refs = new ArrayList<>();
            java.util.regex.Matcher ref = java.util.regex.Pattern.compile("\"([^\"]+)\"").matcher(entry.group(2));
            while (ref.find()) refs.add(ref.group(1));
            layers.put(entry.group(1), refs);
        }
        return layers;
    }

    /**
     * The FQNs a generator's ANCHOR declarations name, across every shipped manifest
     * (FR-043 §6).
     *
     * <p>An anchor is the library node a generator keys on. Reading it here is what
     * retires a hard-coded entity name in the generator: {@code LlmTraceHelperGenerator}
     * compared a short name, so ANY adopter entity called {@code LlmCallBase}, in any
     * package, triggered it — and the shipped abstract was never actually what matched.</p>
     *
     * <p>Hand-parsed for the reason {@link #parseLayers} is: this module is the metadata
     * core and does not depend on a JSON binder, and the file is one this repo
     * generates. Each object in the {@code "generators"} array is read for its own
     * {@code name} and {@code anchor}, so key ORDER inside it does not matter.</p>
     *
     * @param generatorName the cross-port stable name, e.g. {@code "trace-helper"}
     * @return the anchor FQNs, in manifest order; empty when none declares one
     */
    public static List<String> generatorAnchors(String generatorName) {
        List<String> out = new ArrayList<>();
        for (String name : new TreeSet<>(EmbeddedLibrary.MANIFESTS.keySet())) {
            String manifest = EmbeddedLibrary.MANIFESTS.get(name);
            java.util.regex.Matcher block = java.util.regex.Pattern
                .compile("\"generators\"\\s*:\\s*\\[(.*?)\\]", java.util.regex.Pattern.DOTALL)
                .matcher(manifest);
            if (!block.find()) continue;
            java.util.regex.Matcher obj = java.util.regex.Pattern
                .compile("\\{([^}]*)\\}").matcher(block.group(1));
            while (obj.find()) {
                String body = obj.group(1);
                String declared = manifestField(body, "name");
                String anchor = manifestField(body, "anchor");
                if (generatorName.equals(declared) && anchor != null) out.add(anchor);
            }
        }
        return out;
    }

    /** One {@code "key": "value"} string field out of a flat JSON object body. */
    private static String manifestField(String objectBody, String key) {
        java.util.regex.Matcher m = java.util.regex.Pattern
            .compile("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"").matcher(objectBody);
        return m.find() ? m.group(1) : null;
    }

    /** The prefix every library source id carries. */
    public static final String LIBRARY_FILE_ID_PREFIX = "library:";

    /**
     * The source id a library file loads under, in every build —
     * {@code library:iam/model.yaml}.
     *
     * <p>Stable rather than path-derived so a library node's ADR-0009 provenance envelope
     * reads the same from a checkout and from an installed jar, carries no absolute path,
     * and cannot be confused with an adopter file sharing a basename.</p>
     *
     * @param ref the path under {@code library/} minus {@code .yaml}
     * @return the stable source id
     */
    public static String libraryFileId(String ref) {
        return LIBRARY_FILE_ID_PREFIX + ref + ".yaml";
    }

    /** Split a selection token into {@code [library, layer]} — {@code "iam"} to
     *  {@code ["iam", ""]}, {@code "iam/db"} to {@code ["iam", "db"]}. Only the FIRST
     *  separator is meaningful, so a typo stays a typo rather than resolving to a prefix. */
    public static String[] splitToken(String token) {
        int i = token.indexOf('/');
        return i == -1 ? new String[] { token, "" }
                       : new String[] { token.substring(0, i), token.substring(i + 1) };
    }

    /** Every selection token this build accepts, sorted — what a config error prints. */
    public static List<String> knownTokens() {
        TreeSet<String> out = new TreeSet<>();
        for (Map.Entry<String, Map<String, List<String>>> e : LAYERS_BY_LIBRARY.entrySet()) {
            for (String layer : e.getValue().keySet()) {
                out.add(layer.isEmpty() ? e.getKey() : e.getKey() + "/" + layer);
            }
        }
        return new ArrayList<>(out);
    }

    /**
     * The library package names this build ships, sorted.
     *
     * <p>{@link #librarySources(List)} deliberately skips an unrecognised name (see there),
     * so a typo would otherwise surface only as {@code ERR_UNRESOLVED_SUPER} against the
     * adopter's own metadata — the wrong place to go looking. A caller that took the name
     * from a human (a build file, a config) validates against this first.</p>
     *
     * @return the shipped package names, sorted
     */
    public static List<String> knownPackages() {
        return new ArrayList<>(new TreeSet<>(LAYERS_BY_LIBRARY.keySet()));
    }

    /**
     * Locate the repo-root {@code library/} directory by walking up from the location of
     * this class until a directory contains BOTH {@code library/} and {@code server/} —
     * the two structural anchors that identify the repo root.
     *
     * @return the {@code library/} directory, or {@code null} when it is not reachable
     */
    private static Path libraryDirOnDisk() {
        Path start;
        try {
            Path codeSource = Paths.get(
                LibrarySources.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            start = Files.isDirectory(codeSource) ? codeSource : codeSource.getParent();
        } catch (Exception e) {
            // No code source (some classloaders), or a URL that is not a file: the on-disk
            // tree is unreachable by definition, so fall through to the embed. Never fatal
            // — the embed is the case this method exists to be optional for.
            return null;
        }
        for (Path dir = start; dir != null; dir = dir.getParent()) {
            if (Files.isDirectory(dir.resolve("library")) && Files.isDirectory(dir.resolve("server"))) {
                return dir.resolve("library");
            }
        }
        return null;
    }

    private static Path getLibraryDir() {
        if (!dirResolved) {
            synchronized (LibrarySources.class) {
                if (!dirResolved) {
                    cachedDir = libraryDirOnDisk();
                    dirResolved = true;
                }
            }
        }
        return cachedDir;
    }

    /**
     * Sources for the requested library packages, in ref order.
     *
     * <p>An unrecognised package contributes NO sources and is not an error here. That is
     * deliberate and matches every other port: a programmatic caller asking for a package
     * this version does not ship should still be able to load its own metadata. A name a
     * human typed into a build file is the opposite case, and the caller that read it
     * validates against {@link #knownPackages()} before calling this.</p>
     *
     * @param packages package names to include (e.g. {@code ["ai"]}); {@code null} yields none
     * @return the resolved sources, on-disk where reachable and embedded otherwise
     */
    public static List<MetaDataSource> librarySources(List<String> packages) {
        List<MetaDataSource> out = new ArrayList<>();
        if (packages == null) return out;

        // A token whose LAYER is unknown is dropped whole, not reduced to its core: implying
        // the core from an invalid layer would answer a mistyped "iam/database" with an inert
        // core and no tables, which is the worst of the available outcomes.
        List<String[]> wanted = new ArrayList<>();
        for (String token : packages) {
            String[] parts = splitToken(token);
            Map<String, List<String>> layers = LAYERS_BY_LIBRARY.get(parts[0]);
            if (layers != null && layers.containsKey(parts[1])) wanted.add(parts);
        }

        // Core layers FIRST, across every requested library, so a db layer named before its
        // core still parses after it. "iam/db" IMPLIES "iam": a db layer is nothing but
        // overlay:true redeclarations, and an overlay whose target was never declared is
        // ERR_OVERLAY_NO_TARGET.
        List<String> refs = new ArrayList<>();
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        for (String[] parts : wanted) {
            for (String ref : LAYERS_BY_LIBRARY.get(parts[0]).get("")) {
                if (seen.add(ref)) refs.add(ref);
            }
        }
        for (String[] parts : wanted) {
            if (parts[1].isEmpty()) continue;
            for (String ref : LAYERS_BY_LIBRARY.get(parts[0]).get(parts[1])) {
                if (seen.add(ref)) refs.add(ref);
            }
        }

        Path dir = getLibraryDir();
        {
            for (String ref : refs) {
                if (dir != null) {
                    Path path = dir.resolve(ref + ".yaml");
                    if (Files.isRegularFile(path)) {
                        // The SAME id the embedded branch below uses. A path-derived id
                        // would make a library node's error envelope differ between a
                        // checkout and an installed jar, and would collide with an adopter
                        // file of the same basename.
                        out.add(new FileSource(path, libraryFileId(ref)));
                        continue;
                    }
                }
                String embedded = EmbeddedLibrary.CONTENT.get(ref);
                if (embedded == null) {
                    throw new IllegalStateException(
                        "library ref \"" + ref + "\" has no on-disk file "
                            + "and no embedded entry — the embedded library class is stale; run "
                            + "scripts/generate-embedded-library.ts");
                }
                out.add(new InMemoryStringSource(
                    embedded, libraryFileId(ref), MetaDataSource.MetaDataFormat.YAML));
            }
        }
        return out;
    }

    /**
     * The canonical on-disk content for a ref, when the repo-root {@code library/} tree is
     * reachable. Exists for the freshness gate, which has to compare the embed against the
     * source of truth rather than against itself.
     *
     * @param ref the library ref (path under {@code library/} minus {@code .yaml})
     * @return the file's exact content, or {@code null} when the tree is unreachable
     * @throws IOException if the file exists but cannot be read
     */
    public static String onDiskContent(String ref) throws IOException {
        Path dir = getLibraryDir();
        if (dir == null) return null;
        Path path = dir.resolve(ref + ".yaml");
        if (!Files.isRegularFile(path)) return null;
        return new String(Files.readAllBytes(path), java.nio.charset.StandardCharsets.UTF_8);
    }
}
