package com.metaobjects.mojo;

import com.metaobjects.generator.GeneratorRegistry;
import org.apache.maven.model.Dependency;
import org.apache.maven.plugin.AbstractMojo;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.project.MavenProject;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * {@code mvn metaobjects:eject -Dnames=<a,b,...>} — copy one or more reference generators
 * into a new {@code codegen/} Maven module the adopter owns (FR — eject in every port, JVM
 * section; mirrors the TypeScript {@code meta eject} and the Python {@code metaobjects
 * eject}). {@code mvn metaobjects:eject -Dlist} prints the catalog instead of ejecting
 * (chosen over a separate {@code list} goal — one goal, one mental model, matching how
 * every other port's eject exposes its listing as a flag on the same command).
 *
 * <p><b>What it does.</b> For each requested stable name it resolves the generator (see
 * {@link EjectSupport#resolve}), reads its reference source from the classpath resource the
 * owning {@code codegen-spring}/{@code codegen-kotlin} jar ships it as, rewrites ONLY the
 * {@code package ...} declaration (ADR-0034: the package rename is the sole edit — a copy
 * that kept the reference's original package would silently lose to the plugin's own class,
 * since the project classloader is parent-first), and writes it under {@code
 * codegen/src/main/(java|kotlin)/<package path>/}. On first use it also writes {@code
 * codegen/pom.xml}.
 *
 * <p><b>The helper runtime comes too.</b> The Java controller, DTO and repository output
 * imports helper classes ({@code FilterParser}, {@code PatchValidationException},
 * {@code ConstraintErrors}, …) that are not core (ADR-0034 Amendment 3). Ejecting such a
 * generator copies the source of every class its output imports into the module that
 * compiles the generated code — {@code src/main/java/<runtimePackage>/}, default
 * {@code <groupId>.runtime} — and points the owned generator's {@code RUNTIME_PACKAGE} at it,
 * so the owned output imports owned code and a helper bug can be fixed without an upstream
 * release. Each copy's first line is {@link EjectSupport#OWNED_RUNTIME_MARKER}, which is how
 * {@code metaobjects:verify} knows it is owned code rather than stale output.
 *
 * <p><b>What it never does.</b> It never edits the calling project's own {@code pom.xml} —
 * it PRINTS the {@code <module>}, the plugin {@code <dependency>}, and the {@code
 * <generator><classname>} change instead, the same reporting-not-editing stance ADR-0034 §3(c)
 * already rules for the TypeScript command. It never overwrites a file that exists unless
 * {@code -Dforce=true}. It validates every requested name BEFORE writing anything, so a bad
 * name in a multi-name call ejects nothing rather than half the batch.
 */
@Mojo(name = "eject", requiresProject = true, threadSafe = true)
public class MetaDataEjectMojo extends AbstractMojo {

    // Package-private (not private), matching AbstractMetaDataMojo's `project`/`execution`
    // convention: Maven sets these by reflection regardless of visibility, and it lets
    // same-package unit tests construct a Mojo directly and assign its parameters, the same
    // pattern NeutralConfigMojoFallbackTest / UseNamesDerivationTest already use.
    @Parameter(defaultValue = "${project}", readonly = true, required = true)
    MavenProject project;

    /** Comma-separated stable names to eject, e.g. {@code -Dnames=names,routes}. */
    @Parameter(property = "names")
    String names;

    /** Overwrite a file/pom that already exists. Without it, eject never clobbers. */
    @Parameter(property = "force", defaultValue = "false")
    boolean force;

    /** {@code java} or {@code kotlin} — required only when a requested name is ejectable
     *  on both ports and the calling project's dependencies don't disambiguate it. */
    @Parameter(property = "port")
    String port;

    /** Target package for ejected copies. Defaults to {@code <project.groupId>.codegen}. */
    @Parameter(property = "package")
    String targetPackage;

    /** Print the catalog (every ejectable name, and any owned copy's staleness) instead of
     *  ejecting. */
    @Parameter(property = "list", defaultValue = "false")
    boolean list;

    /** Package the owned helper runtime is written under. Defaults to
     *  {@code <project.groupId>.runtime}. */
    @Parameter(property = "runtimePackage")
    String runtimePackage;

    /** Source root the owned helper runtime is written under — the one the generated code
     *  compiles in. Defaults to this module's {@code src/main/java}; in an aggregator
     *  ({@code pom} packaging) to the {@code src/main/java} of the one child module that
     *  configures {@code metaobjects-maven-plugin}. */
    @Parameter(property = "runtimeDir")
    String runtimeDir;

    private static final String CODEGEN_DIR = "codegen";

    @Override
    public void execute() throws MojoExecutionException, MojoFailureException {
        if (list) {
            getLog().info(buildListOutput());
            return;
        }

        if (names == null || names.isBlank()) {
            throw new MojoFailureException(
                    "mvn metaobjects:eject requires -Dnames=<a,b,...>, or -Dlist=true to see "
                        + "what is ejectable.");
        }

        List<String> requested = List.of(names.split(",")).stream()
                .map(String::trim).filter(s -> !s.isEmpty()).distinct()
                .collect(Collectors.toList());
        if (requested.isEmpty()) {
            throw new MojoFailureException("mvn metaobjects:eject: -Dnames named nothing usable.");
        }

        Map<String, List<EjectSupport.Entry>> catalog = EjectSupport.ejectableByStableName();
        EjectSupport.Port explicitPort = port == null || port.isBlank() ? null : EjectSupport.Port.parse(port);
        EjectSupport.Port inferredPort = EjectSupport.inferPort(declaredArtifactIds());

        // Validate EVERY name before writing ANY file — a partial eject over an unknown
        // name in the same call is worse than failing the whole call: it leaves a
        // half-changed repo whose re-run then reports the already-copied half as
        // "preserved", and the adopter cannot tell what happened.
        List<EjectSupport.Resolution> resolved = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        for (String n : requested) {
            EjectSupport.Resolution r = EjectSupport.resolve(n, catalog, explicitPort, inferredPort);
            resolved.add(r);
            if (!r.ok()) errors.add("  " + r.error);
        }
        if (!errors.isEmpty()) {
            throw new MojoFailureException(
                    "Nothing was ejected:\n" + String.join("\n", errors)
                        + "\nEjectable generators: " + String.join(", ", catalog.keySet()));
        }

        String pkg = (targetPackage == null || targetPackage.isBlank())
                ? project.getGroupId() + ".codegen" : targetPackage.trim();

        Path codegenRoot = project.getBasedir().toPath().resolve(CODEGEN_DIR);
        Set<EjectSupport.Port> portsTouched = new LinkedHashSet<>();
        List<String> classnameChanges = new ArrayList<>();

        List<EjectSupport.Entry> entries = new ArrayList<>();
        for (EjectSupport.Resolution r : resolved) entries.add(r.entry);
        List<String> runtime = EjectSupport.runtimeFor(entries);
        String runtimePkg = (runtimePackage == null || runtimePackage.isBlank())
                ? project.getGroupId() + ".runtime" : runtimePackage.trim();
        // Resolved before anything is written, for the same reason names are: an aggregator
        // with no single obvious app module fails the whole call, not half of it.
        Path runtimeRoot = runtime.isEmpty() ? null : resolveRuntimeRoot();

        for (EjectSupport.Resolution r : resolved) {
            EjectSupport.Entry e = r.entry;
            portsTouched.add(e.port);

            String reference;
            try {
                reference = readResource(e.resourcePath);
            } catch (IOException ex) {
                throw new MojoExecutionException(
                        "Could not read reference source for \"" + e.stableName + "\" at classpath "
                            + "resource " + e.resourcePath, ex);
            }
            String rewritten = EjectSupport.rewritePackage(reference, pkg);
            if (!e.runtime.isEmpty()) {
                rewritten = EjectSupport.rewriteRuntimePackage(rewritten, runtimePkg);
            }

            String langDir = e.port == EjectSupport.Port.KOTLIN ? "kotlin" : "java";
            Path pkgDir = codegenRoot.resolve("src/main/" + langDir).resolve(pkg.replace('.', '/'));
            Path target = pkgDir.resolve(e.simpleName() + "." + e.port.extension);

            reportEject(e, target, rewritten, write(pkgDir, target, rewritten, force));
            classnameChanges.add("  " + e.stableName + ": " + e.classname + "  ->  "
                    + pkg + "." + e.simpleName());
        }

        boolean pomWritten = writeCodegenPomIfNeeded(codegenRoot, pkg, portsTouched);

        if (!runtime.isEmpty()) {
            ejectRuntime(runtime, runtimeRoot, runtimePkg);
        }

        printWiring(pomWritten, classnameChanges);
        if (!runtime.isEmpty()) {
            printRuntimeWiring(runtimeRoot, runtimePkg, requested, codegenRoot);
        }
    }

    // ------------------------------------------------------------------------------------
    // helper runtime
    // ------------------------------------------------------------------------------------

    /** Where the owned runtime goes — see {@link #runtimeDir}. */
    private Path resolveRuntimeRoot() throws MojoFailureException {
        Path base = project.getBasedir().toPath();
        if (runtimeDir != null && !runtimeDir.isBlank()) {
            return base.resolve(runtimeDir.trim());
        }
        if (!"pom".equals(project.getPackaging())) {
            return base.resolve("src/main/java");
        }
        // An aggregator compiles nothing itself. The generated code compiles in the child that
        // runs metaobjects:generate, so the runtime belongs there — found by the one child pom
        // that names this plugin. Zero or several such children is a question only the
        // adopter can answer.
        List<String> candidates = new ArrayList<>();
        for (String module : project.getModules() == null ? List.<String>of() : project.getModules()) {
            Path childPom = base.resolve(module).resolve("pom.xml");
            try {
                if (Files.isRegularFile(childPom)
                        && Files.readString(childPom, StandardCharsets.UTF_8).contains("metaobjects-maven-plugin")) {
                    candidates.add(module);
                }
            } catch (IOException ex) {
                throw new MojoFailureException("Could not read " + childPom, ex);
            }
        }
        if (candidates.size() == 1) {
            return base.resolve(candidates.get(0)).resolve("src/main/java");
        }
        throw new MojoFailureException(
                "Nothing was ejected: the generators named import helper runtime classes, which "
                    + "eject copies into the module that compiles the generated code, and this "
                    + "aggregator has " + (candidates.isEmpty() ? "no child module" : "several child modules "
                    + candidates) + " configuring metaobjects-maven-plugin. Pass "
                    + "-DruntimeDir=<module>/src/main/java.");
    }

    private void ejectRuntime(List<String> runtime, Path runtimeRoot, String runtimePkg)
            throws MojoExecutionException {
        Path dir = runtimeRoot.resolve(runtimePkg.replace('.', '/'));
        for (String simpleName : runtime) {
            String resource = GeneratorRegistry.EJECT_RUNTIME_RESOURCE_ROOT + simpleName + ".java";
            String reference;
            try {
                reference = readResource(resource);
            } catch (IOException ex) {
                throw new MojoExecutionException(
                        "Could not read reference runtime source \"" + simpleName + "\" at classpath "
                            + "resource " + resource, ex);
            }
            String owned = EjectSupport.ownedRuntimeSource(reference, simpleName, runtimePkg);
            Path target = dir.resolve(simpleName + ".java");
            WriteStatus status = write(dir, target, owned, force);
            switch (status) {
                case CREATED:
                    getLog().info("Copied runtime " + simpleName + " -> " + target + ". You own it now.");
                    break;
                case REPLACED:
                    getLog().info("Copied runtime " + simpleName + " -> " + target
                            + ", REPLACING the file that was there (-Dforce=true).");
                    break;
                case PRESERVED:
                    getLog().info(target + " already exists — " + describeOwned(target, owned)
                            + " Left untouched (-Dforce=true replaces it).");
                    break;
            }
        }
    }

    private String describeOwned(Path target, String reference) throws MojoExecutionException {
        try {
            EjectSupport.Comparison cmp = EjectSupport.compare(
                    Files.readString(target, StandardCharsets.UTF_8), reference);
            return cmp.verdict == EjectSupport.Verdict.IDENTICAL
                    ? "IDENTICAL to the reference."
                    : "DIFFERS from the reference (" + cmp.behind + " line(s) behind, "
                        + cmp.ownedOnly + " line(s) of your own).";
        } catch (IOException ex) {
            throw new MojoExecutionException("Could not read existing " + target, ex);
        }
    }

    /**
     * Name the packaged generators that still import the reference runtime. A split is not
     * always a compile error: an owned DTO throwing the owned {@code PatchValidationException}
     * past a packaged controller catching the reference one compiles and answers 500.
     */
    private void printRuntimeWiring(Path runtimeRoot, String runtimePkg, List<String> requested,
                                    Path codegenRoot) {
        getLog().info("The helper runtime the owned output imports is now yours, in "
                + runtimeRoot.resolve(runtimePkg.replace('.', '/'))
                + ". It compiles with the generated code; nothing regenerates it.");
        List<String> stillPackaged = new ArrayList<>();
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            if (e.port != EjectSupport.Port.JAVA || e.runtime.isEmpty()) continue;
            if (requested.contains(e.stableName) || ownedStaleness(codegenRoot, e) != null) continue;
            stillPackaged.add(e.stableName);
        }
        if (!stillPackaged.isEmpty()) {
            getLog().info("If <generators> also runs the PACKAGED " + String.join(", ", stillPackaged)
                    + ", give each the same runtime so every generated file uses one copy:");
            getLog().info("  <args><runtimePackage>" + runtimePkg + "</runtimePackage></args>");
        }
    }

    // ------------------------------------------------------------------------------------
    // writing
    // ------------------------------------------------------------------------------------

    private enum WriteStatus { CREATED, REPLACED, PRESERVED }

    private WriteStatus write(Path dir, Path target, String content, boolean force)
            throws MojoExecutionException {
        try {
            if (Files.exists(target)) {
                if (!force) return WriteStatus.PRESERVED;
                Files.writeString(target, content, StandardCharsets.UTF_8);
                return WriteStatus.REPLACED;
            }
            Files.createDirectories(dir);
            Files.writeString(target, content, StandardCharsets.UTF_8);
            return WriteStatus.CREATED;
        } catch (IOException ex) {
            throw new MojoExecutionException("Could not write " + target, ex);
        }
    }

    private void reportEject(EjectSupport.Entry e, Path target, String rewritten, WriteStatus status)
            throws MojoExecutionException {
        switch (status) {
            case CREATED:
                getLog().info("Ejected \"" + e.stableName + "\" -> " + target
                        + ". You own it now (ADR-0034 scaffold-and-own).");
                break;
            case REPLACED:
                getLog().info("Ejected \"" + e.stableName + "\" -> " + target + ", REPLACING the file "
                        + "that was there (-Dforce=true).");
                break;
            case PRESERVED:
                try {
                    String existing = Files.readString(target, StandardCharsets.UTF_8);
                    EjectSupport.Comparison cmp = EjectSupport.compare(existing, rewritten);
                    if (cmp.verdict == EjectSupport.Verdict.IDENTICAL) {
                        getLog().info(target + " already exists and is IDENTICAL to the reference "
                                + "— nothing to do.");
                    } else {
                        getLog().info(target + " already exists and DIFFERS from the reference ("
                                + cmp.behind + " line(s) behind, " + cmp.ownedOnly + " line(s) of your "
                                + "own) — left untouched. Pass -Dforce=true to replace it (this "
                                + "DISCARDS your own lines).");
                    }
                } catch (IOException ex) {
                    throw new MojoExecutionException("Could not read existing " + target, ex);
                }
                break;
        }
    }

    /** Writes {@code codegen/pom.xml} only if absent (or {@code -Dforce=true}). Returns
     *  whether it wrote (vs. left an existing one alone). */
    private boolean writeCodegenPomIfNeeded(Path codegenRoot, String pkg, Set<EjectSupport.Port> ports)
            throws MojoExecutionException {
        Path pom = codegenRoot.resolve("pom.xml");
        if (Files.exists(pom) && !force) {
            getLog().info(pom + " already exists — left untouched (-Dforce=true replaces it).");
            return false;
        }
        String artifactId = project.getArtifactId() + "-codegen";
        String content = codegenPom(artifactId, ports);
        try {
            Files.createDirectories(codegenRoot);
            Files.writeString(pom, content, StandardCharsets.UTF_8);
        } catch (IOException ex) {
            throw new MojoExecutionException("Could not write " + pom, ex);
        }
        getLog().info("Wrote " + pom);
        return true;
    }

    /** The Java level the MetaObjects JVM artifacts are built for (the reactor's
     *  {@code java.version}); an ejected copy compiles against them. */
    static final String JAVA_RELEASE = "21";

    private String codegenPom(String artifactId, Set<EjectSupport.Port> ports) {
        String version = pluginVersion();
        StringBuilder deps = new StringBuilder();
        if (ports.contains(EjectSupport.Port.JAVA)) {
            deps.append("    <dependency>\n")
                .append("      <groupId>com.metaobjects</groupId>\n")
                .append("      <artifactId>metaobjects-codegen-spring</artifactId>\n")
                .append("      <version>").append(version).append("</version>\n")
                .append("    </dependency>\n");
        }
        if (ports.contains(EjectSupport.Port.KOTLIN)) {
            deps.append("    <dependency>\n")
                .append("      <groupId>com.metaobjects</groupId>\n")
                .append("      <artifactId>metaobjects-codegen-kotlin</artifactId>\n")
                .append("      <version>").append(version).append("</version>\n")
                .append("    </dependency>\n");
        }
        String kotlinPlugin = ports.contains(EjectSupport.Port.KOTLIN)
            ? "  <build>\n"
              + "    <sourceDirectory>src/main/kotlin</sourceDirectory>\n"
              + "    <plugins>\n"
              + "      <plugin>\n"
              + "        <groupId>org.jetbrains.kotlin</groupId>\n"
              + "        <artifactId>kotlin-maven-plugin</artifactId>\n"
              + "        <version>" + kotlin.KotlinVersion.CURRENT + "</version>\n"
              + "        <executions>\n"
              + "          <execution>\n"
              + "            <id>compile</id>\n"
              + "            <phase>compile</phase>\n"
              + "            <goals><goal>compile</goal></goals>\n"
              + "          </execution>\n"
              + "        </executions>\n"
              + "      </plugin>\n"
              + "    </plugins>\n"
              + "  </build>\n"
            : "";
        return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            + "<!-- Written by `mvn metaobjects:eject` (ADR-0034 scaffold-and-own). You own this\n"
            + "     module: rename it, add more ejected generators, edit their emit logic. Nothing\n"
            + "     here regenerates itself. -->\n"
            + "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
            + "  <modelVersion>4.0.0</modelVersion>\n"
            + "  <groupId>" + escape(project.getGroupId()) + "</groupId>\n"
            + "  <artifactId>" + escape(artifactId) + "</artifactId>\n"
            + "  <version>" + escape(project.getVersion()) + "</version>\n"
            + "  <packaging>jar</packaging>\n"
            // This module usually builds standalone, so nothing inherits a Java level. The
            // copies use Java 16+ syntax and compile against Java 21 jars; Maven's own
            // default is -source 8, and Kotlin's default JVM target is older still.
            + "  <properties>\n"
            + "    <maven.compiler.release>" + JAVA_RELEASE + "</maven.compiler.release>\n"
            + (ports.contains(EjectSupport.Port.KOTLIN)
                ? "    <kotlin.compiler.jvmTarget>" + JAVA_RELEASE + "</kotlin.compiler.jvmTarget>\n"
                : "")
            + "  </properties>\n"
            + "  <dependencies>\n"
            + deps
            + "  </dependencies>\n"
            + kotlinPlugin
            + "</project>\n";
    }

    private static String escape(String s) {
        return s == null ? "" : s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private void printWiring(boolean pomWritten, List<String> classnameChanges) {
        getLog().info("");
        if (pomWritten) {
            getLog().info("Add this module to the parent pom's <modules>:");
            getLog().info("  <module>" + CODEGEN_DIR + "</module>");
        }
        getLog().info("Add this dependency to the app module's metaobjects-maven-plugin <plugin>:");
        getLog().info("  <dependency>");
        getLog().info("    <groupId>" + project.getGroupId() + "</groupId>");
        getLog().info("    <artifactId>" + project.getArtifactId() + "-codegen</artifactId>");
        getLog().info("    <version>" + project.getVersion() + "</version>");
        getLog().info("  </dependency>");
        getLog().info("Change each ejected generator's <classname> in <generators>:");
        for (String c : classnameChanges) getLog().info(c);
    }

    // ------------------------------------------------------------------------------------
    // --list
    // ------------------------------------------------------------------------------------

    /**
     * Mirrors {@code server/python/src/metaobjects/cli.py}'s {@code LIST_HEADER} wording —
     * every generator here is a reference helper you own with {@code eject}, never a
     * guarantee (ADR-0034 Amendment 3).
     */
    private String buildListOutput() {
        StringBuilder sb = new StringBuilder();
        sb.append("Every generator below is a reference helper: it compiles and passes the "
                + "reference fixtures, and you own your copy once you run `mvn metaobjects:eject "
                + "-Dnames=<name>`. A defect in the reference is fixed there; a defect in your "
                + "copy is yours to fix.\n\n");

        Map<String, List<EjectSupport.Entry>> byName = new java.util.LinkedHashMap<>();
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            byName.computeIfAbsent(e.stableName, k -> new ArrayList<>()).add(e);
        }
        Path codegenRoot = project != null && project.getBasedir() != null
                ? project.getBasedir().toPath().resolve(CODEGEN_DIR) : null;

        for (Map.Entry<String, List<EjectSupport.Entry>> row : byName.entrySet()) {
            for (EjectSupport.Entry e : row.getValue()) {
                String tag = " [" + e.port.id + "]";
                if (e.resourcePath == null) {
                    sb.append("  ").append(row.getKey()).append(tag)
                            .append("  — not ejectable: ").append(e.description).append('\n');
                    continue;
                }
                String owned = ownedStaleness(codegenRoot, e);
                sb.append("  ").append(row.getKey()).append(tag).append("  — ").append(e.description);
                if (owned != null) sb.append("  ").append(owned);
                sb.append('\n');
            }
        }
        String runtimeRows = ownedRuntimeRows();
        if (!runtimeRows.isEmpty()) {
            sb.append("\nOwned helper runtime (copied by eject with routes/dto/repository):\n")
              .append(runtimeRows);
        }
        sb.append("\nRun: mvn metaobjects:eject -Dnames=<name>[,<name>...]");
        return sb.toString();
    }

    /** One row per owned runtime file found under this module's (or, in an aggregator, its
     *  children's) {@code src/main/java}, recognised by its ownership marker. */
    private String ownedRuntimeRows() {
        if (project == null || project.getBasedir() == null) return "";
        StringBuilder sb = new StringBuilder();
        Path base = project.getBasedir().toPath();
        List<Path> roots = new ArrayList<>();
        roots.add(base.resolve("src/main/java"));
        if (project.getModules() != null) {
            for (String module : project.getModules()) roots.add(base.resolve(module).resolve("src/main/java"));
        }
        try {
            List<Path> owned = new ArrayList<>();
            for (Path root : roots) {
                if (!Files.isDirectory(root)) continue;
                try (var walk = Files.walk(root)) {
                    walk.filter(p -> p.getFileName().toString().endsWith(".java")).sorted().forEach(owned::add);
                }
            }
            for (Path p : owned) {
                String content = Files.readString(p, StandardCharsets.UTF_8);
                if (!EjectSupport.isOwnedRuntime(content)) continue;
                String simple = p.getFileName().toString().replaceFirst("\\.java$", "");
                String verdict;
                try {
                    String reference = readResource(
                            GeneratorRegistry.EJECT_RUNTIME_RESOURCE_ROOT + simple + ".java");
                    EjectSupport.Comparison cmp = EjectSupport.compare(content, reference);
                    verdict = cmp.verdict == EjectSupport.Verdict.IDENTICAL
                            ? "[owned — identical]"
                            : "[owned — DIFFERS: " + cmp.behind + " behind, " + cmp.ownedOnly + " of your own]";
                } catch (IOException ex) {
                    verdict = "[owned — no reference of that name ships in this version]";
                }
                sb.append("  ").append(simple).append("  ").append(verdict).append("  ")
                  .append(project.getBasedir().toPath().relativize(p)).append('\n');
            }
        } catch (IOException ex) {
            return "  (could not scan for owned runtime: " + ex.getMessage() + ")\n";
        }
        return sb.toString();
    }

    private String ownedStaleness(Path codegenRoot, EjectSupport.Entry e) {
        if (codegenRoot == null) return null;
        String langDir = e.port == EjectSupport.Port.KOTLIN ? "kotlin" : "java";
        // The owned copy may live under ANY package the adopter chose — search for a
        // file with this generator's simple name under codegen/src/main/<lang>.
        Path srcRoot = codegenRoot.resolve("src/main/" + langDir);
        if (!Files.isDirectory(srcRoot)) return null;
        String filename = e.simpleName() + "." + e.port.extension;
        try (var walk = Files.walk(srcRoot)) {
            Path found = walk.filter(p -> p.getFileName().toString().equals(filename))
                    .findFirst().orElse(null);
            if (found == null) return null;
            String owned = Files.readString(found, StandardCharsets.UTF_8);
            String reference = readResource(e.resourcePath);
            EjectSupport.Comparison cmp = EjectSupport.compare(owned, reference);
            return cmp.verdict == EjectSupport.Verdict.IDENTICAL
                    ? "[owned — identical]"
                    : "[owned — DIFFERS: " + cmp.behind + " behind, " + cmp.ownedOnly + " of your own]";
        } catch (IOException ex) {
            return "[owned — could not compare: " + ex.getMessage() + "]";
        }
    }

    // ------------------------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------------------------

    private List<String> declaredArtifactIds() {
        if (project == null || project.getDependencies() == null) return List.of();
        List<String> out = new ArrayList<>();
        for (Dependency d : project.getDependencies()) out.add(d.getArtifactId());
        return out;
    }

    private String readResource(String resourcePath) throws IOException {
        try (InputStream in = getClass().getClassLoader().getResourceAsStream(resourcePath)) {
            if (in == null) {
                throw new IOException("classpath resource not found: " + resourcePath);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** This plugin's own running version, for the {@code codegen/pom.xml} it writes —
     *  mirrors {@code AgentContextScaffold.installedVersion()}'s {@code pom.properties}
     *  read, scoped to this plugin's own coordinates. */
    private String pluginVersion() {
        String resource = "/META-INF/maven/com.metaobjects/metaobjects-maven-plugin/pom.properties";
        try (InputStream in = getClass().getResourceAsStream(resource)) {
            if (in == null) return FALLBACK_VERSION;
            Properties props = new Properties();
            props.load(in);
            String v = props.getProperty("version");
            return (v == null || v.isBlank()) ? FALLBACK_VERSION : v.trim();
        } catch (IOException e) {
            return FALLBACK_VERSION;
        }
    }

    /** Used only when this plugin's own {@code pom.properties} cannot be read (e.g. run
     *  from a non-packaged classpath, as in a unit test) — the printed wiring instructions
     *  tell the adopter to check the version regardless. */
    private static final String FALLBACK_VERSION = "LATEST-METAOBJECTS-VERSION";
}
