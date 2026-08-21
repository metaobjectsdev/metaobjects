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

    /** Package to ordered refs, derived from the generated embed so that adding a library
     *  file (which regenerates {@link EmbeddedLibrary}) needs no edit here. */
    private static final Map<String, List<String>> REFS_BY_PACKAGE = buildRefsByPackage();

    /** Resolved once per process; {@code null} value means "looked, not present". */
    private static volatile Path cachedDir;
    private static volatile boolean dirResolved;

    private static Map<String, List<String>> buildRefsByPackage() {
        Map<String, List<String>> map = new LinkedHashMap<>();
        for (String ref : new TreeSet<>(EmbeddedLibrary.CONTENT.keySet())) {
            int slash = ref.indexOf('/');
            if (slash <= 0) continue;
            map.computeIfAbsent(ref.substring(0, slash), k -> new ArrayList<>()).add(ref);
        }
        return map;
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
        return new ArrayList<>(new TreeSet<>(REFS_BY_PACKAGE.keySet()));
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

        Path dir = getLibraryDir();
        for (String pkg : packages) {
            List<String> refs = REFS_BY_PACKAGE.get(pkg);
            if (refs == null) continue; // unknown package — no sources

            for (String ref : refs) {
                if (dir != null) {
                    Path path = dir.resolve(ref + ".yaml");
                    if (Files.isRegularFile(path)) {
                        out.add(new FileSource(path));
                        continue;
                    }
                }
                String embedded = EmbeddedLibrary.CONTENT.get(ref);
                if (embedded == null) {
                    throw new IllegalStateException(
                        "library ref \"" + ref + "\" (package \"" + pkg + "\") has no on-disk file "
                            + "and no embedded entry — the embedded library class is stale; run "
                            + "scripts/generate-embedded-library.ts");
                }
                out.add(new InMemoryStringSource(
                    embedded, "library:" + ref + ".yaml", MetaDataSource.MetaDataFormat.YAML));
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
