package com.metaobjects.mojo;

import com.metaobjects.config.WireFormat;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.util.HashManifest;
import com.metaobjects.generator.util.OrphanSweep;
import com.metaobjects.generator.verify.TemplateVerify;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.requirement.RequirementCheck;
import org.apache.maven.model.Plugin;
import org.apache.maven.model.PluginExecution;
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
import java.util.HashSet;
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
 *   <li>unset (DEFAULT) — the cross-port default gate set: {@code codegen}, then
 *       {@code templates} when {@code templateRoot} is set (skipped with a note otherwise).</li>
 *   <li>{@code codegen} (codegen only, byte-identical to the historical goal) —
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

    /** The gen goal to suggest in the failure message. */
    private static final String GEN_GOAL = "metaobjects:generate";

    /**
     * The generate invocation to suggest in a failure message. A generate configuration that
     * lives inside an {@code <execution>} is not seen by a bare {@code mvn metaobjects:generate}
     * (it fails with "No <loader> element was defined"), so name the execution that holds it.
     * With the configuration at plugin level, or when the module is not known, the bare goal works.
     */
    private String genGoal() {
        Plugin plugin = project != null ? project.getPlugin(PLUGIN_KEY) : null;
        if (plugin == null || plugin.getConfiguration() != null) return GEN_GOAL;
        for (PluginExecution e : plugin.getExecutions()) {
            if (e.getGoals().contains("generate") && !"none".equals(e.getPhase())) {
                return GEN_GOAL + "@" + e.getId();
            }
        }
        return GEN_GOAL;
    }

    /** Verify mode: {@code codegen}, {@code templates}; unset runs both (the default gate set). */
    static final String MODE_CODEGEN = "codegen";
    static final String MODE_TEMPLATES = "templates";
    static final String MODE_DB = "db";

    /**
     * Which verify mode to run (ADR-0021 D2). Unset (the default) runs the cross-port default
     * gate set: codegen drift, then template drift when {@code templateRoot} is set (skipped
     * with a note when it is not). {@code codegen} = codegen drift only; {@code templates} =
     * template/prompt {@code {{field}}}↔payload drift only. {@code db} is rejected (schema
     * drift is the migrate engine, not the Maven port).
     */
    @Parameter(property = "meta.verify.mode")
    private String mode = "";

    public void setMode(String mode) { this.mode = mode; }
    public String getMode() { return mode; }

    /**
     * On-disk template root the {@code templates} mode resolves each {@code @textRef}
     * against (the mustache files referenced by {@code template.prompt} nodes). Required
     * in {@code templates} mode; ignored in {@code codegen} mode; in the default gate set
     * it selects the template gate, which is skipped (with a note) when it is not set.
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
        refuseRemovedDocsConfiguration("verify");
        com.metaobjects.registry.RegistryBootstrap.warmUpDefaults();
        if (getLoader() == null) {
            throw new MojoExecutionException("No <loader> element was defined");
        }
        warnIfAgentContextStale();

        advisoriesDone = false;
        String m = mode == null ? "" : mode.trim();
        if (m.isEmpty()) {
            verifyDefaultSet();
            return;
        }
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
                    "meta:verify: unknown mode '" + mode + "'. Valid modes: 'codegen', 'templates' (or unset for both).");
        }

        refuseSharedGeneratorDirs();
        verifyCodegen();
    }

    /** Set once the field lint and requirement gate have run, so a two-gate run reports them once. */
    private boolean advisoriesDone;

    /**
     * Mode unset: the cross-port default gate set. Codegen drift always; template drift when
     * {@code templateRoot} is configured, else skipped with a note (there is no directory to
     * resolve {@code @textRef}s against). Both gates run before the build fails, so one red gate
     * does not hide the other.
     */
    private void verifyDefaultSet() throws MojoExecutionException, MojoFailureException {
        refuseSharedGeneratorDirs();
        MojoFailureException codegenFailure = null;
        try {
            verifyCodegen();
        } catch (MojoFailureException e) {
            codegenFailure = e;
        }
        MojoFailureException templatesFailure = null;
        if (templateRoot == null || templateRoot.isEmpty()) {
            getLog().info(PREFIX + "template gate skipped: no templateRoot "
                    + "(-Dmeta.verify.templateRoot=...) to resolve @textRef against");
        } else {
            try {
                verifyTemplates();
            } catch (MojoFailureException e) {
                templatesFailure = e;
            }
        }
        if (codegenFailure != null && templatesFailure != null) {
            throw new MojoFailureException(codegenFailure.getMessage() + "\n" + templatesFailure.getMessage());
        }
        if (codegenFailure != null) throw codegenFailure;
        if (templatesFailure != null) throw templatesFailure;
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
        if (advisoriesDone || noFieldLint || "1".equals(System.getenv(FieldLint.ENV_OPT_OUT))) return;
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
        // A default-set run reaches here once per gate; the ledger is one report, not two.
        if (advisoriesDone) return 0;
        advisoriesDone = true;
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
        // Every generator's handEdits policy, grouped by the same key — there being no
        // record of which generator wrote a given extra file, "overwrite" is attributed to
        // a directory only when EVERY generator writing into it agrees.
        Map<Path, List<String>> handEditsByOutputDir = new LinkedHashMap<>();

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
                Path realKey = realPath.toAbsolutePath().normalize();
                handEditsByOutputDir.computeIfAbsent(realKey, k -> new ArrayList<>())
                        .add(g.validatedHandEdits());
                Path tempDir = tempByOutputDir.get(realKey);
                if (tempDir == null) {
                    tempDir = tempRoot.resolve("out-" + tempByOutputDir.size());
                    tempByOutputDir.put(realKey, tempDir);
                    // One compare per unique output dir, over every generator writing there.
                    targets.add(new GenTarget(realPath, tempDir));
                }
                overrides.put(g, Collections.singletonMap(ARG_OUTPUT_DIR, tempDir.toString()));
            }
        }

        for (GenTarget t : targets) {
            Path realKey = t.realDir.toAbsolutePath().normalize();
            List<String> handEdits = handEditsByOutputDir.get(realKey);
            t.allOverwrite = handEdits != null && !handEdits.isEmpty()
                    && handEdits.stream().allMatch(GeneratorParam.HAND_EDITS_OVERWRITE::equals)
                    && noConfiguredWriterKeeps(realKey);
            for (Path other : tempByOutputDir.keySet()) {
                if (!other.equals(realKey) && other.startsWith(realKey)) t.nestedDirs.add(other);
            }
        }

        // The committed manifest, when this project has one — null otherwise, which keeps
        // every extra committed file on the old blanket "stale-in-repo" wording (there is
        // no evidence to tell a stray from an orphan without it).
        Path projectRoot = project != null && project.getBasedir() != null
                ? project.getBasedir().toPath() : null;
        Path genStateDir = projectRoot != null
                ? projectRoot.resolve(".metaobjects").resolve(".gen-state") : null;
        Map<String, String> hashes = genStateDir != null && HashManifest.exists(genStateDir)
                ? HashManifest.load(genStateDir) : null;

        // Build + run generators with the temp-dir overrides applied.
        List<Generator> generatorImpls = buildGenerators(projectClassLoader, overrides);
        try {
            for (Generator gen : generatorImpls) {
                getLog().info("MetaData Verify Mojo > Regenerating (temp): " + gen.getClass().getName());
                gen.execute(loader);
            }

            // Compare each output directory's temp tree against its committed tree.
            Map<String, String> ownHashes = hashes == null ? null
                    : ownedBy(hashes, HashManifest.loadOwners(genStateDir), targets, projectRoot);
            List<String> drift = new ArrayList<>();
            List<String> editedOrphans = new ArrayList<>();
            for (GenTarget t : targets) {
                drift.addAll(compareTrees(t, ownHashes, projectRoot, editedOrphans));
            }
            if (ownHashes != null) {
                drift.addAll(strandedOutsideTargets(ownHashes, targets, projectRoot, editedOrphans));
            }

            if (!drift.isEmpty()) {
                // ADR-0019 Amendment 2: committed output generated under another `wire` setting is
                // drift that regenerating would "fix" by changing the API's JSON. Name the setting.
                if (drift.size() > editedOrphans.size()) {
                    WireFormat used = loader.getRoot().getWireFormat();
                    WireFormat committed = matchingWire(loader, projectClassLoader, overrides, targets, ownHashes, projectRoot);
                    if (committed != null) throw new MojoFailureException(wireDiffers(committed, used));
                }
                StringBuilder sb = new StringBuilder();
                if (drift.size() > editedOrphans.size()) {
                    sb.append("generated code is stale — run `mvn ").append(genGoal())
                            .append("` and commit. Drifted files:");
                } else {
                    // Every drifted file is an orphan that was edited by hand and that
                    // `generate` will (under handEdits=keep) refuse to delete — regenerating
                    // would change nothing, so the usual lead-in would send the reader in a
                    // circle.
                    sb.append("codegen drift detected. Drifted files:");
                }
                for (String d : drift) {
                    sb.append("\n  ").append(d);
                }
                if (!editedOrphans.isEmpty()) {
                    sb.append("\n\nFor the file(s) above that no generator emits any more and that were "
                            + "edited by hand, `mvn ").append(genGoal())
                            .append("` will NOT delete them. Delete each one, or move your edits into a "
                                    + "file of your own first.");
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
     * ADR-0019 Amendment 2: the other {@code wire} setting under which the generators reproduce the
     * committed output exactly, or {@code null} when none does. Probes decimals {native, string} x
     * nullMembers {native, omit} ({@code emit} writes what {@code native} writes on the JVM), skipping
     * the setting this run used, then puts that setting back on the root. Each probe runs fresh
     * generator instances, since a generator need not support a second {@code execute}. A probe that
     * fails answers "no match", so the ordinary drift report still prints.
     */
    private WireFormat matchingWire(MetaDataLoader loader, ClassLoader projectClassLoader,
                                    Map<GeneratorParam, Map<String, String>> overrides, List<GenTarget> targets,
                                    Map<String, String> ownHashes, Path projectRoot) throws MojoExecutionException {
        WireFormat used = loader.getRoot().getWireFormat();
        WireFormat.NullMembers usedNulls = used.nullMembers() == WireFormat.NullMembers.EMIT
                ? WireFormat.NullMembers.NATIVE : used.nullMembers();
        try {
            for (WireFormat.Decimals d : WireFormat.Decimals.values()) {
                for (WireFormat.NullMembers n : List.of(WireFormat.NullMembers.NATIVE, WireFormat.NullMembers.OMIT)) {
                    if (d == used.decimals() && n == usedNulls) continue;
                    loader.getRoot().setWireFormat(new WireFormat(d, n));
                    for (GenTarget t : targets) deleteRecursively(t.tempDir);
                    try {
                        for (Generator gen : buildGenerators(projectClassLoader, overrides)) gen.execute(loader);
                    } catch (RuntimeException e) {
                        getLog().debug("MetaData Verify Mojo > wire probe failed: " + e);
                        return null;
                    }
                    List<String> drift = new ArrayList<>();
                    for (GenTarget t : targets) drift.addAll(compareTrees(t, ownHashes, projectRoot, new ArrayList<>()));
                    if (ownHashes != null) {
                        drift.addAll(strandedOutsideTargets(ownHashes, targets, projectRoot, new ArrayList<>()));
                    }
                    if (drift.isEmpty()) return new WireFormat(d, n);
                }
            }
            return null;
        } finally {
            loader.getRoot().setWireFormat(used);
        }
    }

    /** The {@code wire} block that declares {@code wire}. */
    static String wireBlock(WireFormat wire) {
        return "\"wire\": { \"decimals\": \"" + wire.decimals().wireName()
                + "\", \"nullMembers\": \"" + wire.nullMembers().wireName() + "\" }";
    }

    /** The verify failure for committed output that another {@code wire} setting reproduces. */
    static String wireDiffers(WireFormat committed, WireFormat used) {
        return "The committed output was generated with " + wireBlock(committed) + "; this run used "
                + wireBlock(used) + " (.metaobjects/config.json; each key defaults to native). Do not "
                + "regenerate: that changes the JSON your API writes for decimals or for a value object's "
                + "null members. Declare " + wireBlock(committed) + " in .metaobjects/config.json, and "
                + "generate and verify both read it.";
    }

    /**
     * The manifest entries {@code generate} would judge as orphans for the generators this
     * verify runs ({@link OrphanSweep#isCandidate}): their own entries, and entries whose
     * generator the module configures in no execution. Another configured generator's
     * entry is left out and reads as a stranger here, as it is to {@code generate}. Empty
     * while the manifest names no owner yet: the build that records them deletes nothing.
     */
    private Map<String, String> ownedBy(Map<String, String> hashes, Map<String, HashManifest.Owner> owners,
                                        List<GenTarget> targets, Path projectRoot) {
        Map<String, String> owned = new LinkedHashMap<>();
        if (owners.isEmpty()) return owned;
        Set<HashManifest.Owner> runOwners = new HashSet<>();
        for (GeneratorParam g : getGenerators() != null ? getGenerators() : List.<GeneratorParam>of()) {
            HashManifest.Owner owner = ownerOf(g);
            if (owner != null) runOwners.add(owner);
        }
        Path root = projectRoot.toAbsolutePath().normalize();
        for (Map.Entry<String, String> e : hashes.entrySet()) {
            boolean inRunDir = targetHolding(targets, root.resolve(e.getKey()).normalize()) != null;
            if (OrphanSweep.isCandidate(owners.get(e.getKey()), inRunDir, runOwners, this::configuredOwners)) {
                owned.put(e.getKey(), e.getValue());
            }
        }
        return owned;
    }

    private static GenTarget targetHolding(List<GenTarget> targets, Path file) {
        for (GenTarget t : targets) {
            if (file.startsWith(t.realDir.toAbsolutePath().normalize())) return t;
        }
        return null;
    }

    /**
     * The orphans {@code generate} deletes outside every output dir this verify compares:
     * files a generator the module no longer configures wrote into a directory nothing
     * writes any more.
     */
    private List<String> strandedOutsideTargets(Map<String, String> ownHashes, List<GenTarget> targets,
                                                Path projectRoot, List<String> editedOrphans) {
        List<String> drift = new ArrayList<>();
        Path root = projectRoot.toAbsolutePath().normalize();
        for (String key : new TreeSet<>(ownHashes.keySet())) {
            Path file = root.resolve(key).normalize();
            if (targetHolding(targets, file) != null || !Files.isRegularFile(file)) continue;
            switch (OrphanSweep.classify(ownHashes, root, file)) {
                case PRISTINE:
                    drift.add("[stale-in-repo] " + file + " (committed; no configured generator produces it; "
                            + "'mvn " + genGoal() + "' deletes it)");
                    break;
                case EDITED:
                    drift.add("[stale-in-repo] " + file + " (no configured generator emits it any more, and "
                            + "it was edited by hand: delete it, or move your edits into a file of your own "
                            + "and then delete it)");
                    editedOrphans.add(file.toString());
                    break;
                default:
                    break;
            }
        }
        return drift;
    }

    /**
     * Compare one output directory's freshly-generated temp tree — the union of every
     * generator configured to write there — against its committed tree.
     * Returns a list of human-readable drift descriptions (empty if in sync).
     *
     * <p>When {@code hashes} is non-null (the project has a codegen manifest), an EXTRA
     * committed file — one no generator just emitted — is classified against it rather
     * than reported blindly: a file the manifest does not record is a stranger, not drift
     * at all; a pristine orphan is reported with the remedy that {@code generate} will
     * actually delete it; an edited orphan is reported as something {@code generate} will
     * NOT delete under {@code handEdits=keep} (and its path is appended to {@code
     * editedOrphans} so the caller can adjust the failure message), or, under {@code
     * handEdits=overwrite} on every generator writing there, as something it WILL delete.
     * With no manifest at all, every extra file keeps the old, un-evidenced wording.
     */
    List<String> compareTrees(GenTarget t, Map<String, String> hashes, Path projectRoot,
                               List<String> editedOrphans) throws MojoExecutionException {
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
            if (t.isNested(committedFile)) continue;
            if (inGen && !inCommitted) {
                drift.add("[missing-from-repo] " + committedFile + " (generator produces it; not committed)");
            } else if (!inGen && inCommitted) {
                // Helper runtime and support source copied by `mvn metaobjects:eject` are
                // owned code, not output: no generator produces them, so an output dir that
                // also holds one (outputDir = src/main/java is legal) would otherwise report
                // it stale forever.
                if (isOwnedByEject(committedFile)) continue;

                if (hashes == null) {
                    drift.add("[stale-in-repo] " + committedFile + " (committed; generator no longer produces it)");
                    continue;
                }
                OrphanSweep.Verdict verdict = OrphanSweep.classify(hashes, projectRoot, committedFile);
                switch (verdict) {
                    case STRANGER:
                        // Not ours — never drift.
                        break;
                    case PRISTINE:
                        drift.add("[stale-in-repo] " + committedFile + " (committed; generator no longer "
                                + "produces it; 'mvn " + genGoal() + "' deletes it)");
                        break;
                    case EDITED:
                        if (t.allOverwrite) {
                            drift.add("[stale-in-repo] " + committedFile + " (no generator emits it any "
                                    + "more, and it was edited by hand: 'mvn " + genGoal()
                                    + "' will overwrite and delete it, handEdits: overwrite)");
                        } else {
                            drift.add("[stale-in-repo] " + committedFile + " (no generator emits it any "
                                    + "more, and it was edited by hand: delete it, or move your edits into "
                                    + "a file of your own and then delete it)");
                            editedOrphans.add(committedFile.toString());
                        }
                        break;
                }
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

    /** Whether {@code file} carries {@link EjectSupport#OWNED_RUNTIME_MARKER} or
     *  {@link EjectSupport#OWNED_SUPPORT_MARKER}. */
    private static boolean isOwnedByEject(Path file) throws MojoExecutionException {
        if (!file.getFileName().toString().endsWith(".java")) return false;
        try {
            String content = Files.readString(file, StandardCharsets.UTF_8);
            return EjectSupport.isOwnedRuntime(content) || EjectSupport.isOwnedSupport(content);
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
    static final class GenTarget {
        final Path realDir;
        final Path tempDir;
        /** True iff every generator writing into {@code realDir}, this run's and every one the module
         *  configures, has {@code handEdits=overwrite}. */
        boolean allOverwrite;
        /** Other targets' output dirs nested inside {@code realDir}: their files are theirs to judge. */
        final List<Path> nestedDirs = new ArrayList<>();

        GenTarget(Path realDir, Path tempDir) {
            this.realDir = realDir;
            this.tempDir = tempDir;
        }

        boolean isNested(Path file) {
            Path full = file.toAbsolutePath().normalize();
            return nestedDirs.stream().anyMatch(full::startsWith);
        }
    }
}
