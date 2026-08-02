package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.verify.TemplateVerify;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.plugins.annotations.ResolutionScope;

import java.nio.file.Paths;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * The {@code meta:verify} goal — a generator-neutral codegen-drift check, the Java/Kotlin
 * port's parallel to {@code meta:gen}.
 *
 * <p>It regenerates every declared generator into a throwaway temp directory (by overriding
 * each generator's {@code outputDir} arg) and then compares the freshly generated tree
 * against the committed output under the configured (real) {@code outputDir}. Any drift —
 * a file whose content differs, a committed file that the generator no longer produces, or
 * a newly produced file that is not committed — fails the build with a
 * {@link MojoFailureException} listing the drifted files.</p>
 *
 * <p>Because it reuses the exact generator-wiring of {@link AbstractMetaDataMojo#buildGenerators}
 * (reflective no-arg instantiation of any {@link Generator} on the project classpath), it is
 * generator-neutral: it covers {@code codegen-spring} generators and {@code codegen-kotlin}
 * generators (which run through the same {@code meta:gen} SPI) without any per-generator
 * knowledge.</p>
 *
 * <h2>Modes (ADR-0021 D2)</h2>
 * The cross-port {@code verify} vocabulary is unified to explicit modes. Other ports
 * expose them as {@code --codegen}/{@code --templates} CLI flags; the Maven goal — which
 * is parameter-driven — exposes a {@code mode} parameter
 * ({@code -Dmeta.verify.mode=...}):
 * <ul>
 *   <li>{@code codegen} (DEFAULT, back-compat, byte-identical to the historical goal) —
 *       the regenerate-to-temp + diff-against-committed drift gate described above; covers
 *       {@code codegen-spring} AND {@code codegen-kotlin} via the shared meta:gen SPI.</li>
 *   <li>{@code templates} — template/prompt {@code {{field}}}↔payload drift, run via the
 *       shared {@link TemplateVerify} helper (which reuses the render
 *       {@link com.metaobjects.render.Verify} engine). Covers BOTH Java and Kotlin
 *       generation, since they share this one goal.</li>
 *   <li>{@code db} — NOT supported by the Maven port; schema drift is the migrate engine
 *       (Node-owned, ADR-0015). A {@code db} value fails clearly.</li>
 * </ul>
 */
@Mojo(name = "verify",
        requiresDependencyResolution = ResolutionScope.COMPILE_PLUS_RUNTIME,
        defaultPhase = LifecyclePhase.VERIFY,
        threadSafe = true)   // #233
public class MetaDataVerifyMojo extends AbstractMetaDataMojo {

    /** Arg used by {@link GeneratorBase} to locate each generator's output root. */
    static final String ARG_OUTPUT_DIR = GeneratorBase.ARG_OUTPUTDIR;

    /** The gen goal to suggest in the failure message ({@code groupId:artifactId:goal}). */
    private static final String GEN_GOAL = "metaobjects:generate";

    /** Verify mode: {@code codegen} (default), {@code templates}. */
    static final String MODE_CODEGEN = "codegen";
    static final String MODE_TEMPLATES = "templates";
    static final String MODE_DB = "db";

    /**
     * Which verify mode to run (ADR-0021 D2). {@code codegen} (default) = codegen drift;
     * {@code templates} = template/prompt {@code {{field}}}↔payload drift. {@code db} is
     * rejected (schema drift is the migrate engine, not the Maven port).
     */
    @Parameter(property = "meta.verify.mode", defaultValue = "codegen")
    private String mode = MODE_CODEGEN;

    public void setMode(String mode) { this.mode = mode; }
    public String getMode() { return mode; }

    /**
     * On-disk template root the {@code templates} mode resolves each {@code @textRef}
     * against (the mustache files referenced by {@code template.prompt} nodes). Required
     * in {@code templates} mode; ignored in {@code codegen} mode.
     */
    @Parameter(property = "meta.verify.templateRoot")
    private String templateRoot;

    public void setTemplateRoot(String templateRoot) { this.templateRoot = templateRoot; }
    public String getTemplateRoot() { return templateRoot; }

    @Override
    public void execute() throws MojoExecutionException, MojoFailureException {
        // #233: warm the global registry singletons before verify builds its loader,
        // for the same reason as the generate path (this mojo has its own execute()).
        com.metaobjects.registry.RegistryBootstrap.warmUpDefaults();
        if (getLoader() == null) {
            throw new MojoExecutionException("No <loader> element was defined");
        }
        warnIfAgentContextStale();

        String m = mode == null ? MODE_CODEGEN : mode.trim();
        if (MODE_TEMPLATES.equalsIgnoreCase(m)) {
            verifyTemplates();
            return;
        }
        if (MODE_DB.equalsIgnoreCase(m)) {
            throw new MojoFailureException(
                    "meta:verify mode 'db' is not supported by the Maven port; schema verify is the "
                            + "migrate engine (Node-owned, ADR-0015). Use mode 'codegen' or 'templates'.");
        }
        if (!MODE_CODEGEN.equalsIgnoreCase(m)) {
            throw new MojoFailureException(
                    "meta:verify: unknown mode '" + mode + "'. Valid modes: 'codegen' (default), 'templates'.");
        }

        verifyCodegen();
    }

    // ------------------------------------------------------------------------
    // mode=templates — template/prompt {{field}}<->payload drift (ADR-0021 D2)
    // ------------------------------------------------------------------------

    private void verifyTemplates() throws MojoExecutionException, MojoFailureException {
        if (templateRoot == null || templateRoot.isEmpty()) {
            throw new MojoFailureException(
                    "meta:verify mode 'templates' requires the 'templateRoot' parameter "
                            + "(-Dmeta.verify.templateRoot=...): the on-disk dir each @textRef resolves against.");
        }

        ClassLoader projectClassLoader = createProjectClassLoader();
        MetaDataLoader loader = createLoader(projectClassLoader);

        TemplateVerify.Outcome outcome = TemplateVerify.run(loader, Paths.get(templateRoot));

        for (TemplateVerify.Drift w : outcome.warnings()) {
            getLog().warn("MetaData Verify Mojo > template drift (warning) in \"" + w.template()
                    + "\" — " + w.code() + ": " + w.path());
        }

        if (!outcome.ok()) {
            StringBuilder sb = new StringBuilder();
            sb.append("template drift detected — a {{field}} references a name not on the payload VO, "
                    + "or a @textRef did not resolve. Findings:");
            for (TemplateVerify.Drift d : outcome.errors()) {
                sb.append("\n  template \"").append(d.template()).append("\" — ")
                        .append(d.code()).append(": {{").append(d.path()).append("}}");
            }
            for (String u : outcome.unresolvedText()) {
                sb.append("\n  ").append(u);
            }
            throw new MojoFailureException(sb.toString());
        }

        getLog().info("MetaData Verify Mojo > No template/prompt drift detected.");
    }

    // ------------------------------------------------------------------------
    // mode=codegen (default) — regenerate-to-temp + diff vs committed (UNCHANGED)
    // ------------------------------------------------------------------------

    private void verifyCodegen() throws MojoExecutionException, MojoFailureException {
        ClassLoader projectClassLoader = createProjectClassLoader();
        MetaDataLoader loader = createLoader(projectClassLoader);

        // Per-generator: resolve its committed (real) outputDir from the merged args, then
        // mint a unique temp output dir and stage an arg-override so the regenerate writes
        // to temp instead. Keep the real<->temp mapping for the post-run comparison.
        Path tempRoot;
        try {
            tempRoot = Files.createTempDirectory("metaobjects-verify");
        } catch (IOException e) {
            throw new MojoExecutionException("Could not create temp dir for verify", e);
        }

        Map<GeneratorParam, Map<String, String>> overrides = new HashMap<>();
        List<GenTarget> targets = new ArrayList<>();

        if (getGenerators() != null) {
            int idx = 0;
            for (GeneratorParam g : getGenerators()) {
                Map<String, String> merged = mergeAndOverwriteArgs(g);
                String realDir = merged.get(ARG_OUTPUT_DIR);
                if (realDir == null) {
                    // A generator with no outputDir cannot be drift-checked by file tree.
                    // This is a configuration error for a file-emitting generator.
                    throw new MojoExecutionException(
                            "Generator [" + g.getClassname() + "] has no '" + ARG_OUTPUT_DIR
                                    + "' arg; meta:verify can only drift-check file-emitting generators");
                }
                Path tempDir = tempRoot.resolve("gen-" + (idx++));
                overrides.put(g, Collections.singletonMap(ARG_OUTPUT_DIR, tempDir.toString()));
                targets.add(new GenTarget(Path.of(realDir), tempDir));
            }
        }

        // Build + run generators with the temp-dir overrides applied.
        List<Generator> generatorImpls = buildGenerators(projectClassLoader, overrides);
        try {
            for (Generator gen : generatorImpls) {
                getLog().info("MetaData Verify Mojo > Regenerating (temp): " + gen.getClass().getName());
                gen.execute(loader);
            }

            // Compare each generator's temp output against its committed output.
            List<String> drift = new ArrayList<>();
            for (GenTarget t : targets) {
                drift.addAll(compareTrees(t));
            }

            if (!drift.isEmpty()) {
                StringBuilder sb = new StringBuilder();
                sb.append("generated code is stale — run `mvn ").append(GEN_GOAL)
                        .append("` and commit. Drifted files:");
                for (String d : drift) {
                    sb.append("\n  ").append(d);
                }
                throw new MojoFailureException(sb.toString());
            }

            getLog().info("MetaData Verify Mojo > No codegen drift detected across "
                    + targets.size() + " generator(s).");
        } finally {
            deleteRecursively(tempRoot);
        }
    }

    /**
     * Compare a single generator's freshly-generated temp tree against its committed tree.
     * Returns a list of human-readable drift descriptions (empty if in sync).
     */
    private List<String> compareTrees(GenTarget t) throws MojoExecutionException {
        Set<String> generated = relativeFiles(t.tempDir);
        Set<String> committed = relativeFiles(t.realDir);

        // Union of relative paths, sorted for stable, deterministic reporting.
        Set<String> all = new TreeSet<>();
        all.addAll(generated);
        all.addAll(committed);

        List<String> drift = new ArrayList<>();
        for (String rel : all) {
            boolean inGen = generated.contains(rel);
            boolean inCommitted = committed.contains(rel);
            Path committedFile = t.realDir.resolve(rel);
            if (inGen && !inCommitted) {
                drift.add("[missing-from-repo] " + committedFile + " (generator produces it; not committed)");
            } else if (!inGen && inCommitted) {
                drift.add("[stale-in-repo] " + committedFile + " (committed; generator no longer produces it)");
            } else {
                // Present in both — compare bytes.
                if (!contentEquals(t.tempDir.resolve(rel), committedFile)) {
                    drift.add("[content-differs] " + committedFile);
                }
            }
        }
        return drift;
    }

    /** All regular files under {@code root}, as paths relative to {@code root}; empty if absent. */
    private Set<String> relativeFiles(Path root) throws MojoExecutionException {
        Set<String> out = new LinkedHashSet<>();
        if (!Files.isDirectory(root)) {
            return out;
        }
        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    out.add(root.relativize(file).toString());
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            throw new MojoExecutionException("Could not walk directory [" + root + "]", e);
        }
        return out;
    }

    private boolean contentEquals(Path a, Path b) throws MojoExecutionException {
        try {
            return Arrays.equals(Files.readAllBytes(a), Files.readAllBytes(b));
        } catch (IOException e) {
            throw new MojoExecutionException("Could not compare files [" + a + "] vs [" + b + "]", e);
        }
    }

    private void deleteRecursively(Path root) {
        if (root == null || !Files.exists(root)) return;
        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                    Files.delete(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path dir, IOException exc) throws IOException {
                    Files.delete(dir);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** {@code executeGenerators} from the base is unused — verify drives generators itself. */
    @Override
    protected void executeGenerators(MetaDataLoader loader, List<Generator> generatorImpls) {
        // No-op: execute() above orchestrates the regenerate+compare directly.
    }

    /** One generator's committed-vs-temp output-dir mapping. */
    private static final class GenTarget {
        final Path realDir;
        final Path tempDir;

        GenTarget(Path realDir, Path tempDir) {
            this.realDir = realDir;
            this.tempDir = tempDir;
        }
    }
}
