package com.metaobjects.tools;

// One-time migration tool — DELETED in H3b-1 Task 5 once all fixture files
// have been converted to canonical JSON.

import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.json.JsonMetaDataParser;
import com.metaobjects.loader.parser.xml.XMLMetaDataParser;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
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
     * <p>The loader is constructed using the file's own declared {@code package} as
     * the loader name, so {@code MetaDataLoader} → {@code MetaRoot(sanitizeRootName(loaderName))}
     * produces a root node whose name equals the declared package. This ensures
     * {@link CanonicalJsonSerializer} emits the correct root {@code "package"} key.</p>
     *
     * <p><strong>No-package case:</strong> if the file declares no package, the
     * {@code MetaRoot} model always assigns a non-empty name (the loader's
     * {@code sanitizeRootName} converts empty → {@code "root"}), which the serializer
     * would emit as {@code "package": "root"}. This converter post-processes that
     * specific artefact away, so files with no declared package produce canonical
     * output with no root {@code package} key. This is the known MetaRoot-package
     * model quirk: a truly name-less MetaRoot cannot be constructed within the
     * current model; the strip is the only fix possible inside the converter.</p>
     *
     * @param legacyFile path to the legacy metadata file
     * @return canonical JSON string (2-space indent, single trailing newline)
     * @throws IOException if the file cannot be read
     */
    public static String convertToCanonical(Path legacyFile) throws IOException {
        byte[] content = Files.readAllBytes(legacyFile);
        String filename = legacyFile.getFileName().toString();
        boolean isXml = filename.toLowerCase().endsWith(".xml");

        String declaredPackage = isXml
                ? peekXmlPackage(content)
                : peekJsonPackage(content);

        MetaDataLoader loader = freshLoader(declaredPackage);

        ByteArrayInputStream bis = new ByteArrayInputStream(content);
        loadIntoLoader(loader, bis, filename);

        String canonical = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());

        // If the file had no declared package, the serializer emits "package": "root"
        // (the MetaRoot model quirk — sanitizeRootName("") → "root").
        // Strip it so no-package files produce no root package key.
        if (declaredPackage == null || declaredPackage.isEmpty()) {
            canonical = stripRootPackageKey(canonical);
        }

        return canonical;
    }

    /**
     * Parse a group of legacy files (that share {@code extends} references across files)
     * into a single loader and return the canonical serialization of the merged root.
     *
     * <p>The returned canonical JSON represents the fully-merged root. Callers are
     * responsible for splitting it back into per-file granularity if needed (rare).</p>
     *
     * <p>The group's shared package is peeked from the first file; the loader is
     * constructed with that package so the root package is correct in the output.</p>
     *
     * @param legacyFiles ordered list of legacy metadata files to load as a group
     * @return canonical JSON string for the merged root
     * @throws IOException if any file cannot be read
     */
    public static String convertGroupToCanonical(List<Path> legacyFiles) throws IOException {
        if (legacyFiles == null || legacyFiles.isEmpty()) {
            throw new IllegalArgumentException("legacyFiles must not be null or empty");
        }

        // Peek the declared package from the first file (the group is expected to share a package).
        Path first = legacyFiles.get(0);
        byte[] firstContent = Files.readAllBytes(first);
        boolean firstIsXml = first.getFileName().toString().toLowerCase().endsWith(".xml");
        String declaredPackage = firstIsXml
                ? peekXmlPackage(firstContent)
                : peekJsonPackage(firstContent);

        MetaDataLoader loader = freshLoader(declaredPackage);

        // Load the first file (already read into memory).
        loadIntoLoader(loader, new ByteArrayInputStream(firstContent), first.getFileName().toString());

        // Load remaining files.
        for (int i = 1; i < legacyFiles.size(); i++) {
            Path legacyFile = legacyFiles.get(i);
            String filename = legacyFile.getFileName().toString();
            try (InputStream is = Files.newInputStream(legacyFile)) {
                loadIntoLoader(loader, is, filename);
            }
        }

        String canonical = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());

        if (declaredPackage == null || declaredPackage.isEmpty()) {
            canonical = stripRootPackageKey(canonical);
        }

        return canonical;
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
     * Creates a fresh loader named with the file's declared package so that
     * {@code MetaRoot.getName()} equals the real package and
     * {@link CanonicalJsonSerializer} emits the correct root {@code "package"} key.
     *
     * <p>If {@code declaredPackage} is null or empty,
     * {@code MetaDataLoader.sanitizeRootName("")} returns {@code "root"} — a quirk of
     * the MetaRoot model. Callers are responsible for stripping the spurious
     * {@code "package": "root"} from the output in that case.</p>
     *
     * @param declaredPackage the package declared in the legacy file, or null/empty if absent
     */
    private static MetaDataLoader freshLoader(String declaredPackage) {
        // Use the declared package as the loader name so MetaRoot ends up named
        // with the real package. If absent, fall back to a neutral sentinel —
        // MetaDataLoader.sanitizeRootName will turn it into "root".
        String loaderName = (declaredPackage != null && !declaredPackage.isEmpty())
                ? declaredPackage
                : "";
        // sanitizeRootName converts "" → "root" and replaces '-' with '_'.
        // Package names like "acme::commerce" pass through unchanged because
        // MetaData.validateName() permits "::" separators.
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL,
            loaderName.isEmpty() ? "no-package-root" : loaderName);
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
        String lowerName = filename.toLowerCase();
        if (lowerName.endsWith(".xml")) {
            XMLMetaDataParser parser = new XMLMetaDataParser(loader, filename);
            parser.loadFromStream(is);
        } else {
            // Natural JSON (legacy format with bare type keys + subType body field)
            JsonMetaDataParser parser = new JsonMetaDataParser(loader, filename);
            parser.loadFromStream(is);
        }
    }

    // -----------------------------------------------------------------------
    // Package peeking — read declared package without full parse
    // -----------------------------------------------------------------------

    /**
     * Peeks the declared {@code package} (or {@code defPackage}) from a natural-JSON
     * legacy file without fully parsing it.
     *
     * <p>Reads {@code metadata.package} (preferred) then {@code metadata.defPackage}
     * (alias used in some legacy files), matching the priority in
     * {@link JsonMetaDataParser#loadFromStream}.</p>
     *
     * @param content raw file bytes
     * @return the declared package, or an empty string if absent
     */
    static String peekJsonPackage(byte[] content) {
        try {
            JsonObject root = JsonParser.parseString(new String(content, StandardCharsets.UTF_8))
                    .getAsJsonObject();
            if (!root.has("metadata")) return "";
            JsonObject metadata = root.getAsJsonObject("metadata");
            // Priority matches JsonMetaDataParser.loadFromStream:
            // defPackage first, then package (the parser checks defPackage first).
            if (metadata.has("defPackage")) {
                JsonElement v = metadata.get("defPackage");
                if (v != null && !v.isJsonNull()) return v.getAsString().trim();
            }
            if (metadata.has("package")) {
                JsonElement v = metadata.get("package");
                if (v != null && !v.isJsonNull()) return v.getAsString().trim();
            }
            return "";
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * Peeks the declared {@code package} (or {@code defaultPackage}) attribute from
     * the {@code <metadata>} element of an XML legacy file.
     *
     * <p>Mirrors the priority in {@link XMLMetaDataParser#loadFromStream}:
     * {@code defaultPackage} first, then {@code package}.</p>
     *
     * @param content raw file bytes
     * @return the declared package, or an empty string if absent
     */
    static String peekXmlPackage(byte[] content) {
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(false);
            DocumentBuilder builder = factory.newDocumentBuilder();
            Document doc = builder.parse(new ByteArrayInputStream(content));

            NodeList metadataList = doc.getElementsByTagName("metadata");
            if (metadataList.getLength() == 0) return "";

            Element el = (Element) metadataList.item(0);
            // Priority mirrors XMLMetaDataParser.loadFromStream: defaultPackage first, then package.
            if (el.hasAttribute("defaultPackage")) return el.getAttribute("defaultPackage").trim();
            if (el.hasAttribute("package")) return el.getAttribute("package").trim();
            return "";
        } catch (Exception e) {
            return "";
        }
    }

    // -----------------------------------------------------------------------
    // No-package post-processing
    // -----------------------------------------------------------------------

    /**
     * Removes the root-level {@code "package"} key from a canonical JSON string.
     *
     * <p>Used when the source file declared no package. The {@code MetaRoot} model
     * always has a non-empty name (sanitizeRootName converts "" → some sentinel),
     * causing {@link CanonicalJsonSerializer} to emit a spurious {@code "package"}
     * key at the root level. This method strips it so the output faithfully
     * represents a package-less file.</p>
     *
     * <p>Structure of canonical JSON (the root object is always
     * {@code { "metadata.root": { ... } }}): this method removes the
     * {@code "package"} property from the {@code metadata.root} body object only.</p>
     *
     * @param canonical canonical JSON string
     * @return canonical JSON string with no root {@code "package"} key
     */
    static String stripRootPackageKey(String canonical) {
        try {
            JsonObject root = JsonParser.parseString(canonical).getAsJsonObject();
            // Canonical root is always a single-key object: { "metadata.root": { ... } }
            for (String key : root.keySet()) {
                JsonElement body = root.get(key);
                if (body.isJsonObject()) {
                    body.getAsJsonObject().remove("package");
                }
            }
            String raw = new GsonBuilder()
                    .setPrettyPrinting()
                    .disableHtmlEscaping()
                    .create()
                    .toJson(root);
            return raw.stripTrailing() + "\n";
        } catch (Exception e) {
            // Fallback: return as-is if something goes wrong
            return canonical;
        }
    }
}
