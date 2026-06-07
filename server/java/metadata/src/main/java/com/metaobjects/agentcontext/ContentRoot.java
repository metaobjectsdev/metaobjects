package com.metaobjects.agentcontext;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.file.FileSystem;
import java.nio.file.FileSystemAlreadyExistsException;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Optional;

/**
 * Resolve the {@code agent-context/} content tree the assembler reads.
 *
 * <p>Two resolution sources (matching the TS/Python references' bundled-then-monorepo
 * walk):
 * <ol>
 *   <li>A bundled copy on the classpath at {@code /agent-context/} (the published
 *       plugin/jar carries this — see the module's {@code copy-resources} step that
 *       copies the repo-root {@code agent-context/} into {@code target/classes}).</li>
 *   <li>A dev fallback: walk up from a known anchor directory (e.g. the Maven
 *       project basedir or {@code user.dir}) to the monorepo root and use its
 *       top-level {@code agent-context/} directory.</li>
 * </ol>
 *
 * <p>A directory is a valid content root iff it holds the authoring skill body.
 */
public final class ContentRoot {

    private ContentRoot() {
    }

    /** A directory is a valid content root iff it holds the authoring skill body. */
    public static boolean isContentRoot(Path directory) {
        return Files.isRegularFile(
                directory.resolve("skills")
                        .resolve("metaobjects-authoring")
                        .resolve("SKILL.md"));
    }

    /**
     * Resolve the content tree, walking up from {@code anchor} for the dev monorepo
     * fallback, after first trying the classpath-bundled copy.
     *
     * @param anchor a directory to start the monorepo walk-up from (e.g. the Maven
     *               project basedir). May be {@code null} to use {@code user.dir}.
     * @return the resolved content root.
     * @throws IllegalStateException if no content tree can be found.
     */
    public static Path resolve(Path anchor) {
        Optional<Path> bundled = bundledOnClasspath();
        if (bundled.isPresent()) {
            return bundled.get();
        }
        Optional<Path> dev = walkUpForMonorepo(anchor);
        if (dev.isPresent()) {
            return dev.get();
        }
        throw new IllegalStateException(
                "agent-context content not found — looked for a classpath-bundled copy "
                        + "(/agent-context) and a monorepo `agent-context/` walking up from "
                        + (anchor != null ? anchor : System.getProperty("user.dir")));
    }

    /** The classpath-bundled content root ({@code /agent-context/}), if present + valid. */
    public static Optional<Path> bundledOnClasspath() {
        URL marker = ContentRoot.class.getClassLoader()
                .getResource("agent-context/skills/metaobjects-authoring/SKILL.md");
        if (marker == null) {
            return Optional.empty();
        }
        try {
            if ("file".equals(marker.getProtocol())) {
                Path skill = Paths.get(marker.toURI());
                // .../agent-context/skills/metaobjects-authoring/SKILL.md → .../agent-context
                Path root = skill.getParent().getParent().getParent();
                return isContentRoot(root) ? Optional.of(root) : Optional.empty();
            }
            if ("jar".equals(marker.getProtocol())) {
                Path root = jarContentRoot(marker);
                return isContentRoot(root) ? Optional.of(root) : Optional.empty();
            }
        } catch (URISyntaxException | IOException e) {
            throw new UncheckedIOException(
                    new IOException("agent-context: failed resolving bundled content from " + marker, e));
        }
        return Optional.empty();
    }

    /** Open (or reuse) the jar filesystem and return the {@code /agent-context} root inside it. */
    private static Path jarContentRoot(URL marker) throws IOException, URISyntaxException {
        // jar:file:/path/to.jar!/agent-context/skills/metaobjects-authoring/SKILL.md
        String spec = marker.toString();
        int bang = spec.indexOf("!/");
        String jarPart = spec.substring("jar:".length(), bang);
        Path jar = Paths.get(new URL(jarPart).toURI());
        FileSystem fs;
        try {
            fs = FileSystems.newFileSystem(jar, (ClassLoader) null);
        } catch (FileSystemAlreadyExistsException already) {
            fs = FileSystems.getFileSystem(java.net.URI.create("jar:" + jar.toUri()));
        }
        return fs.getPath("/agent-context");
    }

    /** Walk up from the anchor (or {@code user.dir}) to a dir holding a valid {@code agent-context/}. */
    public static Optional<Path> walkUpForMonorepo(Path anchor) {
        Path p = (anchor != null ? anchor : Paths.get(System.getProperty("user.dir")))
                .toAbsolutePath();
        while (p != null) {
            Path candidate = p.resolve("agent-context");
            if (isContentRoot(candidate)) {
                return Optional.of(candidate);
            }
            p = p.getParent();
        }
        return Optional.empty();
    }
}
