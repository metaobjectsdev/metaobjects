package com.metaobjects.tools;

// One-time migration tool — DELETED in H3b-1 Task 5 once all fixture files
// have been converted to canonical JSON.

import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.json.JsonMetaDataParser;
import com.metaobjects.loader.parser.xml.XMLMetaDataParser;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;

/**
 * One-time migration tool that converts legacy metadata files (natural JSON or XML)
 * to canonical JSON format by parsing with the legacy parser and re-emitting with
 * {@link CanonicalJsonSerializer}.
 *
 * <p>Each metadata file is converted with a fresh loader to avoid cross-file
 * {@code extends} resolution failures during conversion. If a fixture genuinely
 * depends on a sibling file for extends resolution, convert those files together
 * by loading them all into one loader — the converter supports multi-file groups
 * via {@link #convertGroupToCanonical(List)}.</p>
 *
 * <p><strong>This class is deleted in H3b-1 Task 5.</strong></p>
 */
public final class LegacyMetadataConverter {

    private LegacyMetadataConverter() {}

    // -----------------------------------------------------------------------
    // Primary API — single-file conversion
    // -----------------------------------------------------------------------

    /**
     * Parse one legacy file with the legacy parser for its extension (JSON or XML)
     * and re-emit as canonical JSON.
     *
     * <p>Each call uses a fresh loader — no cross-file state. The file's format is
     * inferred from its extension: {@code .xml} → XML parser; everything else →
     * natural-JSON parser.</p>
     *
     * @param legacyFile path to the legacy metadata file
     * @return canonical JSON string (2-space indent, single trailing newline)
     * @throws IOException if the file cannot be read
     */
    public static String convertToCanonical(Path legacyFile) throws IOException {
        MetaDataLoader loader = freshLoader();

        String filename = legacyFile.getFileName().toString();
        try (InputStream is = Files.newInputStream(legacyFile)) {
            loadIntoLoader(loader, is, filename);
        }

        return CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
    }

    /**
     * Parse a group of legacy files (that share {@code extends} references across files)
     * into a single loader and return the canonical serialization of the merged root.
     *
     * <p>The returned canonical JSON represents the fully-merged root. Callers are
     * responsible for splitting it back into per-file granularity if needed (rare).</p>
     *
     * @param legacyFiles ordered list of legacy metadata files to load as a group
     * @return canonical JSON string for the merged root
     * @throws IOException if any file cannot be read
     */
    public static String convertGroupToCanonical(List<Path> legacyFiles) throws IOException {
        MetaDataLoader loader = freshLoader();

        for (Path legacyFile : legacyFiles) {
            String filename = legacyFile.getFileName().toString();
            try (InputStream is = Files.newInputStream(legacyFile)) {
                loadIntoLoader(loader, is, filename);
            }
        }

        return CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
    }

    // -----------------------------------------------------------------------
    // Main — convert all legacy metadata files under given directories in-place
    // -----------------------------------------------------------------------

    /**
     * CLI entry point.  Recursively converts every {@code .json} and {@code .xml}
     * metadata file under the given directories to canonical JSON.
     *
     * <ul>
     *   <li>The canonical text is written to a sibling {@code .json} file (same base name).</li>
     *   <li>If the original was an {@code .xml} file, it is deleted after conversion.</li>
     *   <li>If the original was already a {@code .json} file, it is overwritten in-place.</li>
     * </ul>
     *
     * <p>Usage: {@code mvn -pl metadata exec:java -Dexec.mainClass=com.metaobjects.tools.LegacyMetadataConverter -Dexec.args="<dir1> [<dir2> ...]"}</p>
     *
     * @param args one or more directory paths to scan recursively
     */
    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("Usage: LegacyMetadataConverter <dir1> [<dir2> ...]");
            System.exit(1);
        }

        for (String dirStr : args) {
            Path dir = Paths.get(dirStr);
            if (!Files.isDirectory(dir)) {
                System.err.println("Skipping (not a directory): " + dir);
                continue;
            }

            List<Path> files = Files.walk(dir)
                .filter(Files::isRegularFile)
                .filter(p -> {
                    String name = p.getFileName().toString().toLowerCase();
                    return name.endsWith(".json") || name.endsWith(".xml");
                })
                .sorted(Comparator.naturalOrder())
                .collect(Collectors.toList());

            for (Path f : files) {
                try {
                    String canonical = convertToCanonical(f);
                    String baseName = f.getFileName().toString();
                    String stem = baseName.endsWith(".xml")
                        ? baseName.substring(0, baseName.length() - 4)
                        : baseName.substring(0, baseName.lastIndexOf('.'));
                    Path outPath = f.getParent().resolve(stem + ".json");

                    Files.writeString(outPath, canonical, StandardCharsets.UTF_8);
                    System.out.println("Converted: " + f + " → " + outPath);

                    // Delete the original XML file after successful conversion
                    if (!outPath.equals(f)) {
                        Files.delete(f);
                        System.out.println("  Deleted: " + f);
                    }
                } catch (Exception e) {
                    System.err.println("ERROR converting " + f + ": " + e.getMessage());
                    // Continue with remaining files
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /**
     * Creates a fresh loader initialized with the default registry.
     *
     * <p>Using a fresh loader per file ensures that cross-file extends references
     * (from other files not being converted together) do not cause failures.
     * The loader name is fixed — since we only care about the tree structure for
     * serialization, the loader name is inconsequential here.</p>
     */
    private static MetaDataLoader freshLoader() {
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "legacy-converter");
        loader.init();
        return loader;
    }

    /**
     * Loads a single legacy file's content into the given loader using the
     * appropriate parser (JSON or XML, inferred from the filename extension).
     *
     * @param loader   the loader to populate
     * @param is       input stream of the file content
     * @param filename the source filename (used for format inference and parser diagnostics)
     */
    private static void loadIntoLoader(MetaDataLoader loader, InputStream is, String filename)
            throws IOException {
        byte[] content = is.readAllBytes();
        ByteArrayInputStream bis = new ByteArrayInputStream(content);

        String lowerName = filename.toLowerCase();
        if (lowerName.endsWith(".xml")) {
            XMLMetaDataParser parser = new XMLMetaDataParser(loader, filename);
            parser.loadFromStream(bis);
        } else {
            // Natural JSON (legacy format with bare type keys + subType body field)
            JsonMetaDataParser parser = new JsonMetaDataParser(loader, filename);
            parser.loadFromStream(bis);
        }
    }
}
