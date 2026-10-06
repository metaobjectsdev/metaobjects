package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.verify.TemplateVerify;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.requirement.RequirementCheck;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.plugins.annotations.ResolutionScope;

import java.nio.file.Paths;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
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
import java.util.LinkedHashMap;
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

    /** What every line of this goal's requirement report starts with, as the field lint's does. */
    private static final String PREFIX = "metaobjects:verify \u2014 ";

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

    /**
     * Mute the advisory field AUTHORING lint ({@link FieldLint}) — a reference identity
     * over a field the object lacks, and a field name declared twice in one children
     * list. Never a gate: it only prints warnings, so this changes what is logged and
     * nothing else. {@code META_NO_FIELD_LINT=1} does the same.
     */
    @Parameter(property = "meta.verify.noFieldLint", defaultValue = "false")
    private boolean noFieldLint = false;

    public void setNoFieldLint(boolean noFieldLint) { this.noFieldLint = noFieldLint; }
    public boolean isNoFieldLint() { return noFieldLint; }

    /** Environment variable that turns {@link #requireImplementers} on for a CI job. */
    static final String ENV_REQUIRE_IMPLEMENTERS = "META_REQUIRE_IMPLEMENTERS";

    /**
     * The strict switch of the requirement gate (ADR-0057): raise
     * {@code WARN_REQUIREMENT_NOTHING_IMPLEMENTS} to an error, for a project whose ledger has
     * caught up with its links. No other diagnostic changes severity.
     * {@code META_REQUIRE_IMPLEMENTERS=1} does the same.
     */
    @Parameter(property = "meta.verify.requireImplementers", defaultValue = "false")
    private boolean requireImplementers = false;

    public void setRequireImplementers(boolean requireImplementers) { this.requireImplementers = requireImplementers; }
    public boolean isRequireImplementers() { return requireImplementers; }

    /** The process environment, overridable so a test can set a variable. */
    String getEnv(String name) { return System.getenv(name); }

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
    // the field authoring lint — advisory, every mode
    // ------------------------------------------------------------------------

    /**
     * Runs on every {@code verify}, whichever mode was selected, as soon as the metadata
     * has loaded — so its warnings are printed even when the gate then fails the build.
     * Warnings ONLY: this never throws and never changes the build result.
     */
    private void runFieldLintAdvisory(MetaDataLoader loader) {
        if (noFieldLint || "1".equals(System.getenv(FieldLint.ENV_OPT_OUT))) return;
        List<FieldLint.Finding> findings = new ArrayList<>();
        try {
            findings.addAll(FieldLint.lintReferenceFields(loader));
            findings.addAll(FieldLint.lintDuplicateFields(sourceFiles(loader)));
        } catch (RuntimeException e) {
            return;   // an advisory scan never breaks verify
        }
        if (findings.isEmpty()) return;
        getLog().warn("metaobjects:verify — fields: " + findings.size()
                + " authoring warning(s) (advisory — does not fail the build):");
        for (FieldLint.Finding f : findings) {
            getLog().warn("  " + f.code() + " [" + f.path() + "]: " + f.message());
        }
    }

    /** The on-disk metadata files this loader read — the documents the duplicate scan reads raw. */
    private static List<Path> sourceFiles(MetaDataLoader loader) {
        List<Path> files = new ArrayList<>();
        if (loader.getSourceURIs() == null) return files;
        for (java.net.URI uri : loader.getSourceURIs()) {
            com.metaobjects.loader.uri.URIModel model = com.metaobjects.loader.uri.URIHelper.toURIModel(uri);
            if (!com.metaobjects.loader.uri.URIHelper.URI_SOURCE_FILE.equals(model.getUriSourceType())) continue;
            // A relative <source> carries its <sourceDir> as a URI argument — resolve it the
            // way URIHelper's own stream opener does, or the scan reads nothing.
            String sourceDir = model.getUriArg(com.metaobjects.loader.uri.URIHelper.URI_ARG_SOURCEDIR);
            files.add(sourceDir != null ? Paths.get(sourceDir, model.getUriSource()) : Paths.get(model.getUriSource()));
        }
        return files;
    }

    // ------------------------------------------------------------------------
    // the requirement gate — every mode (ADR-0057)
    // ------------------------------------------------------------------------

    /**
     * Runs once per {@code execute()}, whichever mode was selected, as soon as the metadata has
     * loaded, so what it found is printed even when the drift gate then fails the build. A model
     * that declares no {@code requirement.*} node sees no change at all: nothing is logged.
     *
     * @return the number of errors found; the caller fails the build once its own gate has reported
     */
    private int runRequirementGate(MetaDataLoader loader) {
        RequirementCheck.Scan scan = RequirementCheck.scan(loader.getRoot(),
                new RequirementCheck.Options(null,
                        requireImplementers || "1".equals(getEnv(ENV_REQUIRE_IMPLEMENTERS))));
        RequirementCheck.Summary summary = RequirementCheck.summarise(loader.getRoot(), scan);
        if (summary == null) return 0;

        // Printed on every run, clean or not: a gate that says nothing when it passes cannot be
        // told apart from a gate that checked nothing.
        getLog().info(PREFIX + RequirementCheck.summaryText(summary, sourceFiles(loader).size()));
        String undecided = RequirementCheck.undecidedText(summary);
        if (undecided != null) getLog().info(PREFIX + undecided);

        // Every error, then every warning, as the reference and the other ports print them: the
        // checks find them interleaved, and an error must not be lost among the warnings.
        List<RequirementCheck.Diagnostic> diagnostics = RequirementCheck.check(loader.getRoot(), scan);
        int errors = 0;
        for (RequirementCheck.Diagnostic d : diagnostics) {
            if (d.severity() != RequirementCheck.Severity.ERROR) continue;
            errors++;
            getLog().error(RequirementCheck.formatDiagnostic(d));
        }
        for (RequirementCheck.Diagnostic d : diagnostics) {
            if (d.severity() == RequirementCheck.Severity.ERROR) continue;
            getLog().warn(RequirementCheck.formatDiagnostic(d));
        }
        if (errors > 0) getLog().error(PREFIX + "requirements: " + errors + " error(s).");
        return errors;
    }

    private static void failOnRequirementErrors(int errors) throws MojoFailureException {
        if (errors > 0) {
            throw new MojoFailureException("metaobjects:verify \u2014 requirements: " + errors
                    + " error(s); see the lines above.");
        }
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
        runFieldLintAdvisory(loader);
        int requirementErrors = runRequirementGate(loader);

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
        failOnRequirementErrors(requirementErrors);
    }

    // ------------------------------------------------------------------------
    // mode=codegen (default) — regenerate-to-temp + diff vs committed (UNCHANGED)
    // ------------------------------------------------------------------------

    private void verifyCodegen() throws MojoExecutionException, MojoFailureException {
        ClassLoader projectClassLoader = createProjectClassLoader();
        MetaDataLoader loader = createLoader(projectClassLoader);
        runFieldLintAdvisory(loader);
        int requirementErrors = runRequirementGate(loader);

        // Per-generator: resolve its committed (real) outputDir from the merged args, then
        // stage an arg-override so the regenerate writes to a temp dir instead. Keep the
        // real<->temp mapping for the post-run comparison.
        //
        // The temp dir is minted per UNIQUE output directory, not per generator: two
        // file-emitting generators MAY share one outputDir (nothing in the gen goal forbids
        // it, and it is idiomatic elsewhere — buf, graphql-codegen, and the TypeScript port's
        // per-target codegen, whose drift check likewise dedupes outDirs). Giving each
        // generator its own temp dir would make its compare see only its own half of the
        // committed tree, so a co-located generator's files would read as [stale-in-repo] —
        // permanent, unfixable false drift. Sharing the temp dir also keeps verify faithful
        // to gen when two generators emit the same path: last-writer-wins in both.
        Path tempRoot;
        try {
            tempRoot = Files.createTempDirectory("metaobjects-verify");
        } catch (IOException e) {
            throw new MojoExecutionException("Could not create temp dir for verify", e);
        }

        Map<GeneratorParam, Map<String, String>> overrides = new HashMap<>();
        List<GenTarget> targets = new ArrayList<>();

        // Keyed by the normalized absolute output dir so two spellings of the same
        // directory ("gen", "./gen") collapse to one target.
        Map<Path, Path> tempByOutputDir = new LinkedHashMap<>();

        if (getGenerators() != null) {
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
                Path realPath = Path.of(realDir);
                Path tempDir = tempByOutputDir.get(realPath.toAbsolutePath().normalize());
                if (tempDir == null) {
                    tempDir = tempRoot.resolve("out-" + tempByOutputDir.size());
                    tempByOutputDir.put(realPath.toAbsolutePath().normalize(), tempDir);
                    // One compare per unique output dir, over every generator writing there.
                    targets.add(new GenTarget(realPath, tempDir));
                }
                overrides.put(g, Collections.singletonMap(ARG_OUTPUT_DIR, tempDir.toString()));
            }
        }

        // Build + run generators with the temp-dir overrides applied.
        List<Generator> generatorImpls = buildGenerators(projectClassLoader, overrides);
        try {
            for (Generator gen : generatorImpls) {
                getLog().info("MetaData Verify Mojo > Regenerating (temp): " + gen.getClass().getName());
                gen.execute(loader);
            }

            // Compare each output directory's temp tree against its committed tree.
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
                    + generatorImpls.size() + " generator(s) in "
                    + targets.size() + " output director(y/ies).");
        } finally {
            deleteRecursively(tempRoot);
        }
        failOnRequirementErrors(requirementErrors);
    }

    /**
     * Compare one output directory's freshly-generated temp tree — the union of every
     * generator configured to write there — against its committed tree.
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
                // Helper runtime copied by `mvn metaobjects:eject` is owned code, not output:
                // no generator produces it, so an output dir that also holds it (outputDir =
                // src/main/java is legal) would otherwise report it stale forever.
                if (isOwnedRuntime(committedFile)) continue;
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

    /** Whether {@code file} carries {@link EjectSupport#OWNED_RUNTIME_MARKER}. */
    private static boolean isOwnedRuntime(Path file) throws MojoExecutionException {
        if (!file.getFileName().toString().endsWith(".java")) return false;
        try {
            return EjectSupport.isOwnedRuntime(Files.readString(file, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new MojoExecutionException("Could not read [" + file + "]", e);
        }
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
