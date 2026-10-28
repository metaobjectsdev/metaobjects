package com.metaobjects.mojo;

import com.metaobjects.MetaDataException;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.generator.util.HashManifest;
import com.metaobjects.generator.util.OrphanSweep;
import com.metaobjects.generator.util.RouteNaming;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.plugins.annotations.ResolutionScope;

import java.io.File;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Stream;

@Mojo(name="generate",
        requiresDependencyResolution= ResolutionScope.COMPILE_PLUS_RUNTIME,
        defaultPhase = LifecyclePhase.GENERATE_SOURCES,
        threadSafe = true)   // #233: safe under `mvn -T` once the registry warm-up + per-instance loader key land
public class MetaDataGeneratorMojo extends AbstractMetaDataMojo
{
    /**
     * Run a list whose generators' {@code requires} are not all declared beside them
     * ({@link RequiresCheck}). Off by default: such a list writes code that does not compile.
     * Set it only when the project supplies those files by hand, or declares the companion
     * generator in another {@code <execution>}.
     */
    @Parameter(property = "metaobjects.allowUnmetRequires", defaultValue = "false")
    boolean allowUnmetRequires;

    /** How this goal is named in a message telling the adopter what to run. */
    static final String OWNER = "mvn metaobjects:generate";

    @Override
    protected void executeGenerators(MetaDataLoader loader, List<Generator> generatorImpls) {

        // Before any generator runs: a list whose controller (say) is declared without the
        // generators its output references writes code that does not compile, and this goal
        // used to exit 0 on it.
        refuseUnmetRequires(generatorImpls);
        refuseSharedGeneratorDirs();
        noteOwnedStock();

        // Refuse before any generator runs — the one choke point that sees the WHOLE
        // entity set every route-emitting generator below (Java's codegen-spring AND
        // Kotlin's codegen-kotlin, both invoked through this same Mojo) reads from.
        // `loader` is null in SourceRootRegistrationTest's unit tests, which exercise
        // only the post-loop registerGeneratedSourceRoots() logic below with no real
        // metadata — nothing to collide-check in that case.
        if (loader != null) {
            // FR-023: an object a dependency owns gets no route here, so it cannot collide with one.
            RouteNaming.assertNoCollectionNameCollisions(
                    com.metaobjects.generator.util.GeneratorUtil.ownMetaObjects(loader));
        }

        // Where this EXECUTION's codegen hash manifest lives: anchored on the module
        // basedir, so two executions in one module share it (merged — every entry names
        // the generator and output dir that emitted it, and a sweep leaves another
        // configured generator's entries alone) and two modules never collide (each has
        // its own basedir). `null` in a unit test that sets no project
        // (e.g. SourceRootRegistrationTest), which keeps every write on the legacy
        // marker-only rule.
        Path projectRoot = project != null && project.getBasedir() != null
                ? project.getBasedir().toPath() : null;
        Path genStateDir = projectRoot != null
                ? projectRoot.resolve(".metaobjects").resolve(".gen-state") : null;
        // Captured BEFORE any write this run — read afterwards (every write that creates
        // the manifest would make a fresh adoption look like it never happened).
        boolean hadManifestAtStart = genStateDir != null && HashManifest.exists(genStateDir);
        boolean migrating = genStateDir != null && migratingOwners(genStateDir);

        // This loop IS the Java port's runner — the one place that spans generators — so it
        // is the only place that can see two of them claiming one output path. TypeScript's
        // runGen and Python's run_gen both refuse that; until this scope existed, Java could
        // not, and a selection whose output depended on generator order produced a WARN and
        // a green build. Opening the run here is what makes the check reach a real build.
        try (GeneratedFileWriter.Run run = GeneratedFileWriter.beginRun()) {
            if (genStateDir != null) {
                run.configureManifest(genStateDir, projectRoot);
            }

            // Every output dir THIS EXECUTION's generators write to, with the handEdits
            // policy of every generator that writes there, and the owner of every
            // generator that ran: the sweep judges this run's own entries and entries whose
            // owner the module configures nowhere, so a sibling <execution> sharing the
            // manifest, or even an output dir, is never touched.
            Map<Path, List<String>> handEditsByDir = new LinkedHashMap<>();
            Set<HashManifest.Owner> runOwners = new HashSet<>();
            List<GeneratorParam> params = getGenerators();

            for (int i = 0; i < generatorImpls.size(); i++) {
                Generator gen = generatorImpls.get(i);
                getLog().info("MetaData Mojo > Executing Generator: " + gen.getClass().getName() );
                GeneratorParam param = params != null && i < params.size() ? params.get(i) : null;
                String handEdits = param != null ? param.validatedHandEdits() : GeneratorParam.HAND_EDITS_KEEP;
                HashManifest.Owner owner = genStateDir != null && param != null ? ownerOf(param) : null;
                if (owner != null) runOwners.add(owner);
                run.attributeTo( gen.getClass().getSimpleName(), handEdits, owner );
                gen.execute( loader );

                if (genStateDir != null && param != null) {
                    String dir = mergeAndOverwriteArgs(param).get(GeneratorBase.ARG_OUTPUTDIR);
                    if (dir != null) {
                        Path abs = Path.of(dir).toAbsolutePath().normalize();
                        handEditsByDir.computeIfAbsent(abs, k -> new ArrayList<>()).add(handEdits);
                    }
                }
            }

            run.flush();
            Set<Path> emittedThisBuild = refuseSharedPaths(run.emissions(), run.emittedPaths());
            if (migrating) {
                getLog().info("MetaData Mojo > Recorded the generator and output dir of every generated "
                        + "file in `.metaobjects/.gen-state/.hashes.json`; this build deletes no orphaned file.");
            } else if (genStateDir != null) {
                sweepOrphans(genStateDir, projectRoot, handEditsByDir, emittedThisBuild, runOwners);
            }
            reportManifestNotices(run, genStateDir, hadManifestAtStart);
        }

        registerGeneratedSourceRoots();
    }

    /**
     * One advisory line when an owned generator copy under {@code codegen/} is identical to the
     * shipped generator. Never changes the build outcome: a failed comparison says nothing.
     */
    private void noteOwnedStock() {
        if (project == null || project.getBasedir() == null) return;
        try {
            String line = OwnedStock.notice(OwnedStock.find(
                    project.getBasedir().toPath().resolve("codegen"),
                    OwnedStock.classpath(getClass().getClassLoader())));
            if (line != null) getLog().info("MetaData Mojo > " + line);
        } catch (IOException | RuntimeException ignored) {
            // advisory only
        }
    }

    /**
     * Delete the recorded files this run did not emit and may judge
     * ({@link OrphanSweep#isCandidate}): its own generators' files, and files whose
     * generator the module configures in no execution any more.
     */
    private void sweepOrphans(Path genStateDir, Path projectRoot, Map<Path, List<String>> handEditsByDir,
                              Set<Path> emitted, Set<HashManifest.Owner> runOwners) {
        List<OrphanSweep.Entry> dirs = new ArrayList<>();
        for (Map.Entry<Path, List<String>> e : handEditsByDir.entrySet()) {
            boolean allOverwrite = !e.getValue().isEmpty() && e.getValue().stream()
                    .allMatch(GeneratorParam.HAND_EDITS_OVERWRITE::equals) && noConfiguredWriterKeeps(e.getKey());
            dirs.add(new OrphanSweep.Entry(e.getKey(), e.getKey() + File.separator, allOverwrite));
        }
        OrphanSweep.Result swept = OrphanSweep.sweep(
                genStateDir, projectRoot, dirs, emitted, runOwners, this::configuredOwners);
        for (String path : swept.removed) {
            getLog().info("MetaData Mojo > Removed orphaned generated file no longer produced: " + path);
        }
        for (String path : swept.overwrittenDeleted) {
            getLog().warn(OrphanSweep.overwrittenOrphanMessage(path));
        }
        if (!swept.refused.isEmpty()) {
            getLog().warn(OrphanSweep.refusedMessage(swept.refused, OWNER));
        }
    }

    /**
     * Fail the goal when two generator/output-dir pairs emitted one path with different
     * content in this build, in this execution or another of this module: the output would
     * depend on which ran last. Byte-identical re-emission is one file, and a path the
     * adopter hand-owns is no generator's output, so neither is a collision. The record
     * lives in the project's build context, so it spans this build's executions and
     * nothing else. Returns every path emitted in this build so far, which no sweep may
     * treat as an orphan.
     */
    private Set<Path> refuseSharedPaths(Map<Path, Map<HashManifest.Owner, String>> emissions, Set<Path> emitted) {
        @SuppressWarnings("unchecked")
        Map<Path, Emission> emittedBy = project == null ? null
                : (Map<Path, Emission>) project.getContextValue(EMITTED_BY_CONTEXT_KEY);
        if (emittedBy == null) {
            emittedBy = new HashMap<>();
            if (project != null) project.setContextValue(EMITTED_BY_CONTEXT_KEY, emittedBy);
        }
        List<String> shared = new ArrayList<>();
        for (Path path : new TreeSet<>(emissions.keySet())) {
            for (Map.Entry<HashManifest.Owner, String> e : emissions.get(path).entrySet()) {
                Emission previous = emittedBy.putIfAbsent(path, new Emission(e.getKey(), e.getValue()));
                if (previous != null && !previous.owner().equals(e.getKey()) && !previous.hash().equals(e.getValue())) {
                    shared.add(path + " ('" + previous.owner() + "' and '" + e.getKey() + "')");
                }
            }
        }
        if (!shared.isEmpty()) {
            throw new MetaDataException("Two generators of " + OWNER + " in this module emitted the same "
                    + "file with different content, so each would overwrite the other's output: "
                    + String.join(", ", shared) + ". Configure only one generator to emit it, in one output "
                    + "directory.");
        }
        Set<Path> emittedThisBuild = new HashSet<>(emittedBy.keySet());
        emittedThisBuild.addAll(emitted);
        return emittedThisBuild;
    }

    private record Emission(HashManifest.Owner owner, String hash) {}

    /**
     * Whether this build is the first to record owners: the manifest has entries but none
     * names its generator (an 8.1.0 pre-release recorded the Maven execution instead, or
     * nothing). That build records the owners and deletes nothing. Decided once per build,
     * before any execution writes, and kept in the project's build context.
     */
    private boolean migratingOwners(Path genStateDir) {
        Object known = project.getContextValue(MIGRATING_CONTEXT_KEY);
        if (known instanceof Boolean b) return b;
        boolean migrating = !HashManifest.load(genStateDir).isEmpty() && HashManifest.loadOwners(genStateDir).isEmpty();
        project.setContextValue(MIGRATING_CONTEXT_KEY, migrating);
        return migrating;
    }

    private static final String MIGRATING_CONTEXT_KEY = MetaDataGeneratorMojo.class.getName() + ".migratingOwners";
    private static final String EMITTED_BY_CONTEXT_KEY = MetaDataGeneratorMojo.class.getName() + ".emittedBy";

    /** The one-time notices about the manifest itself: first-run adoption, and files this
     *  run could not record because they landed outside the project root. */
    private void reportManifestNotices(GeneratedFileWriter.Run run, Path genStateDir, boolean hadManifestAtStart) {
        if (genStateDir == null) return;
        if (!run.adoptedPaths().isEmpty()) {
            String lead = hadManifestAtStart
                    ? OWNER + ": adopted " + run.adoptedPaths().size()
                        + " existing generated file(s) into the codegen hash manifest "
                        + "`.metaobjects/.gen-state/.hashes.json`."
                    : OWNER + ": created the codegen hash manifest "
                        + "`.metaobjects/.gen-state/.hashes.json` and adopted " + run.adoptedPaths().size()
                        + " existing generated file(s) into it.";
            getLog().warn(lead + " Commit it: it is how the next run tells a file it generated "
                    + "from one you edited, and how it removes files no generator emits any more.");
        }
        if (run.untrackedCount() > 0) {
            getLog().warn(run.untrackedCount() + " generated file(s) were written outside the project "
                    + "root and are not recorded in `.metaobjects/.gen-state/.hashes.json`, so "
                    + "hand-edit protection does not apply to them beyond the GENERATED marker rule.");
        }
    }

    /** Fail the goal, naming each missing companion, when the list does not declare what its
     *  generators' output references; with {@link #allowUnmetRequires}, warn instead. */
    void refuseUnmetRequires(List<Generator> generatorImpls) {
        List<String> unmet = RequiresCheck.unmetFor(generatorImpls);
        if (unmet.isEmpty()) return;
        if (allowUnmetRequires) {
            for (String line : unmet) getLog().warn("MetaData Mojo > " + line);
            return;
        }
        throw new MetaDataException(String.join("\n", unmet)
                + "\nAdd each to <generators>. If you supply those files by hand, or declare the "
                + "generator in another <execution>, set <allowUnmetRequires>true</allowUnmetRequires>.");
    }

    /**
     * F23: {@code metaobjects:generate} used to write generated classes to disk and stop —
     * nothing ever called {@link org.apache.maven.project.MavenProject#addCompileSourceRoot},
     * so {@code mvn compile} in an adopter module compiled zero of them unless the adopter
     * hand-added {@code build-helper-maven-plugin} to point the compiler at the output dir.
     * The other ports need no such step (their output is read by a bundler/interpreter that
     * walks whatever directory it is told about); the JVM compiler plugin only compiles
     * source ROOTS it has been told exist.
     *
     * <p>Registers a directory only after generation actually ran, and only when it holds at
     * least one {@code .java}/{@code .kt} file — evidence, not declared intent. A generator's
     * {@code outputDir} is not necessarily Java/Kotlin source: {@link
     * com.metaobjects.generator.template.TemplateScopeGenerator} emits whatever a
     * user-supplied Mustache template renders (SQL, markdown, CSV), and the HTML/AI
     * documentation generators write docs. Scanning what actually landed on disk — rather
     * than assuming every {@code outputDir} is a source root — keeps a docs-only or
     * data-file-only run from being registered as a source root nothing will ever compile
     * from, which would be silently harmless to {@code javac} but wrong to claim.
     *
     * <p>{@code generate-test-sources} registers a TEST compile root (mirroring the phase
     * this goal was bound to); every other phase, including the default {@code
     * generate-sources} binding, registers a main one.
     */
    private void registerGeneratedSourceRoots() {
        if (getGenerators() == null || project == null) return;

        boolean testPhase = execution != null
                && PHASE_GENERATE_TEST_SOURCES.equals(execution.getLifecyclePhase());

        Set<String> seen = new LinkedHashSet<>();
        for (GeneratorParam g : getGenerators()) {
            Map<String, String> merged = mergeAndOverwriteArgs(g);
            String dir = merged.get(GeneratorBase.ARG_OUTPUTDIR);
            if (dir == null) continue;

            String abs = new File(dir).getAbsoluteFile().toPath().normalize().toString();
            if (!seen.add(abs)) continue;
            if (!holdsCompilableSource(Path.of(abs))) continue;

            if (testPhase) {
                project.addTestCompileSourceRoot(abs);
                getLog().info("MetaData Mojo > Registered test compile source root: " + abs);
            } else {
                project.addCompileSourceRoot(abs);
                getLog().info("MetaData Mojo > Registered compile source root: " + abs);
            }
        }
    }

    /** Whether {@code dir} holds at least one {@code .java} or {@code .kt} file, recursively. */
    private static boolean holdsCompilableSource(Path dir) {
        if (!Files.isDirectory(dir)) return false;
        try (Stream<Path> walk = Files.walk(dir)) {
            return walk.anyMatch(p -> Files.isRegularFile(p) && isSourceFile(p));
        } catch (IOException e) {
            throw new UncheckedIOException("Could not scan generated output dir [" + dir + "]", e);
        }
    }

    private static boolean isSourceFile(Path p) {
        String name = p.getFileName() == null ? "" : p.getFileName().toString();
        return name.endsWith(".java") || name.endsWith(".kt");
    }
}
