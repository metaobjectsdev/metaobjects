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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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
 * owning {@code codegen-spring}/{@code codegen-kotlin} jar ships it as, rewrites the
 * {@code package ...} declaration (ADR-0034 — a copy that kept the reference's original
 * package would silently lose to the plugin's own class, since the project classloader is
 * parent-first), and writes it under {@code codegen/src/main/(java|kotlin)/<package path>/}.
 * On first use it also writes {@code codegen/pom.xml}.
 *
 * <p><b>The shared emit rules come too.</b> The Java routes, DTO, repository and value-object
 * generators apply rules they share (which fields a DTO carries, validation annotations, M:N
 * finder naming) through {@code SpringGeneratorSupport}. Ejecting any of them writes ONE copy
 * of that class beside the owned generators, in their package, and points each owned
 * generator's import at it — so an owned generator never calls the packaged rules, and the
 * adopter can change them. Its first line is {@link EjectSupport#OWNED_SUPPORT_MARKER}.
 *
 * <p><b>The rest of a generator's emit comes with it.</b> The Java {@code entity} generator
 * emits each class body through writer classes, and {@code extractor} reads its names from
 * one. Those classes ({@link EjectSupport.Entry#with}) are copied into the same package as
 * the generator, and the imports the copies have of one another are pointed at the copies
 * ({@link EjectSupport#ownedSource}), so the owned generator extends and calls owned code.
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
 * already rules for the TypeScript command. An existing {@code codegen/pom.xml} is the adopter's
 * too: when it lacks what a port ejected into the module needs, eject prints what to add. It never overwrites a file that exists unless
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

    /** Target package for ejected copies. Defaults to {@code <project.groupId>.codegen}. The
     *  {@code api-docs} copies go in a subpackage of it per port (see
     *  {@link EjectSupport.Entry#ownedPackage}). */
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

    /** Remove owned copies identical to the shipped generator instead of ejecting (see
     *  {@link #undo()}). With {@code -Dnames} only those; without, every identical copy. */
    @Parameter(property = "undo", defaultValue = "false")
    boolean undo;

    private static final String CODEGEN_DIR = "codegen";

    @Override
    public void execute() throws MojoExecutionException, MojoFailureException {
        if (list) {
            getLog().info(buildListOutput());
            return;
        }
        if (undo) {
            undo();
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
        List<String> classnameChanges = new ArrayList<>();

        List<EjectSupport.Entry> entries = new ArrayList<>();
        for (EjectSupport.Resolution r : resolved) entries.add(r.entry);
        List<String> runtime = EjectSupport.runtimeFor(entries);
        String runtimePkg = (runtimePackage == null || runtimePackage.isBlank())
                ? project.getGroupId() + ".runtime" : runtimePackage.trim();
        // Resolved before anything is written, for the same reason names are: an aggregator
        // with no single obvious app module fails the whole call, not half of it.
        Path runtimeRoot = runtime.isEmpty() ? null : resolveRuntimeRoot();

        // Two generators named in one call may share a class copied with each of them; it
        // is written once.
        Set<Path> copied = new LinkedHashSet<>();
        Set<String> support = new LinkedHashSet<>();
        for (EjectSupport.Resolution r : resolved) {
            EjectSupport.Entry e = r.entry;

            String langDir = e.port == EjectSupport.Port.KOTLIN ? "kotlin" : "java";
            String ownedPkg = e.ownedPackage(pkg);
            Path pkgDir = codegenRoot.resolve("src/main/" + langDir).resolve(ownedPkg.replace('.', '/'));

            for (String source : e.sources()) {
                String simpleName = EjectSupport.simpleNameOf(source);
                Path target = pkgDir.resolve(simpleName + "." + e.port.extension);
                if (!copied.add(target)) continue;

                boolean generator = source.equals(e.classname);
                String resource = e.resourceOf(source);
                String reference;
                try {
                    reference = readResource(resource);
                } catch (IOException ex) {
                    throw new MojoExecutionException(
                            "Could not read reference source for \"" + e.stableName + "\" at classpath "
                                + "resource " + resource, ex);
                }
                String rewritten = EjectSupport.ownedSource(e, reference, ownedPkg);
                if (generator && !e.runtime.isEmpty()) {
                    rewritten = EjectSupport.rewriteRuntimePackage(rewritten, runtimePkg);
                }
                if (e.port == EjectSupport.Port.JAVA) {
                    support.addAll(EjectSupport.supportFor(rewritten));
                    rewritten = EjectSupport.rewriteSupportImports(rewritten, pkg);
                    if (!e.resources.isEmpty()) {
                        rewritten = EjectSupport.rewriteTemplatePrefix(rewritten, ownedPkg);
                    }
                }

                String what = generator ? "\"" + e.stableName + "\""
                        : simpleName + " (with \"" + e.stableName + "\")";
                reportEject(what, target, rewritten, write(pkgDir, target, rewritten, force));
            }
            classnameChanges.add("  " + e.stableName + ": " + e.classname + "  ->  "
                    + e.ownedClassname(pkg));
        }

        ejectSupport(support, codegenRoot.resolve("src/main/java").resolve(pkg.replace('.', '/')), pkg);
        ejectTemplates(resolved, codegenRoot.resolve("src/main/resources"), pkg);

        boolean pomWritten = writeCodegenPomIfNeeded(codegenRoot, pkg, portsIn(codegenRoot));
        reportWhatThePomLacks(codegenRoot);

        if (!runtime.isEmpty()) {
            ejectRuntime(runtime, runtimeRoot, runtimePkg);
        }

        printWiring(pomWritten, classnameChanges);
        // Wiring a generator's entry adds to the generic report, in the order requested.
        for (EjectSupport.Resolution r : resolved) {
            String note = r.entry.wiringNote(pkg);
            if (note != null) getLog().info(note);
        }
        if (!runtime.isEmpty()) {
            printRuntimeWiring(runtimeRoot, runtimePkg, requested, codegenRoot);
        }
    }

    // ------------------------------------------------------------------------------------
    // undo
    // ------------------------------------------------------------------------------------

    /**
     * {@code -Dundo=true}: delete the owned copies that are identical to the shipped generator, so
     * the build runs the stock one again. Without {@code -Dnames} that is every identical copy;
     * with names, those only, and a copy that differs is refused with nothing removed unless
     * {@code -Dforce=true}. Every name is validated before anything is deleted. It never edits
     * {@code pom.xml}: it prints the {@code <classname>} to put back. The shared support and
     * runtime copies stay (other owned generators import them) and are named.
     */
    private void undo() throws MojoExecutionException, MojoFailureException {
        Path codegenRoot = project.getBasedir().toPath().resolve(CODEGEN_DIR);
        List<OwnedStock.Copy> all;
        try {
            all = OwnedStock.find(codegenRoot, OwnedStock.classpath(getClass().getClassLoader()));
        } catch (IOException ex) {
            throw new MojoExecutionException("Could not compare the owned copies under " + codegenRoot, ex);
        }
        EjectSupport.Port explicitPort = port == null || port.isBlank() ? null : EjectSupport.Port.parse(port);

        List<OwnedStock.Copy> chosen = new ArrayList<>();
        if (names == null || names.isBlank()) {
            chosen.addAll(OwnedStock.identical(all));
            if (chosen.isEmpty()) {
                getLog().info("No owned generator copy under " + codegenRoot
                        + " is identical to the shipped one; nothing removed.");
                return;
            }
        } else {
            Map<String, List<EjectSupport.Entry>> catalog = EjectSupport.ejectableByStableName();
            List<String> errors = new ArrayList<>();
            for (String n : List.of(names.split(",")).stream().map(String::trim)
                    .filter(s -> !s.isEmpty()).distinct().collect(Collectors.toList())) {
                if (!catalog.containsKey(n)) {
                    errors.add("  unknown generator \"" + n + "\"");
                    continue;
                }
                List<OwnedStock.Copy> found = all.stream()
                        .filter(c -> c.entry.stableName.equals(n)
                                && (explicitPort == null || c.entry.port == explicitPort))
                        .collect(Collectors.toList());
                if (found.isEmpty()) {
                    errors.add("  \"" + n + "\" has no owned copy under " + codegenRoot);
                    continue;
                }
                for (OwnedStock.Copy c : found) {
                    if (!c.identical() && !force) {
                        errors.add("  \"" + n + "\" differs from the shipped generator ("
                                + c.behind + " line(s) behind, " + c.ownedOnly + " line(s) of your own; differing: "
                                + String.join(", ", c.differing) + "); -Dforce=true removes it anyway");
                    } else {
                        chosen.add(c);
                    }
                }
            }
            if (!errors.isEmpty()) {
                throw new MojoFailureException("Nothing was removed:\n" + String.join("\n", errors));
            }
        }

        // A class copied with two generators (the extractor, with entity) goes only when no
        // generator that stays still owns it.
        Set<Path> kept = new LinkedHashSet<>();
        for (OwnedStock.Copy c : all) if (!chosen.contains(c)) kept.addAll(c.files);
        Set<Path> remove = new LinkedHashSet<>();
        for (OwnedStock.Copy c : chosen) for (Path f : c.files) if (!kept.contains(f)) remove.add(f);
        try {
            for (Path f : remove) {
                Files.deleteIfExists(f);
                for (Path dir = f.getParent(); dir != null && !dir.equals(codegenRoot)
                        && Files.isDirectory(dir); dir = dir.getParent()) {
                    try (var s = Files.list(dir)) {
                        if (s.findAny().isPresent()) break;
                    }
                    Files.delete(dir);
                }
            }
        } catch (IOException ex) {
            throw new MojoExecutionException("Could not remove an owned copy under " + codegenRoot, ex);
        }

        Set<String> shared = new LinkedHashSet<>();
        for (OwnedStock.Copy c : chosen) {
            getLog().info("Removed owned \"" + c.entry.stableName + "\" ("
                    + c.files.stream().map(f -> f.getFileName().toString()).collect(Collectors.joining(", "))
                    + ")" + (c.identical() ? "." : ", which differed (-Dforce=true)."));
            getLog().info("  edit your pom.xml: <classname>" + c.ownedClassname() + "</classname>  ->  <classname>"
                    + c.stockClassname() + "</classname>");
            shared.addAll(c.shared);
        }
        getLog().info("This goal never edits pom.xml; make the edit above for each generator removed.");
        if (!shared.isEmpty()) {
            getLog().info("Left in place, since other owned generators may import them (delete by hand if "
                    + "none does): " + String.join(", ", shared));
        }
    }

    // ------------------------------------------------------------------------------------
    // templates
    // ------------------------------------------------------------------------------------

    /**
     * Write the templates the ejected generators read from the classpath into the owned module's
     * resources, under the path of the package each generator's copies are in. The copied template
     * provider is pointed there ({@link EjectSupport#rewriteTemplatePrefix}), so the owned page
     * text is what runs.
     */
    private void ejectTemplates(List<EjectSupport.Resolution> resolved, Path resourceRoot, String pkg)
            throws MojoExecutionException {
        Set<Path> written = new LinkedHashSet<>();
        for (EjectSupport.Resolution r : resolved) {
            Path dir = resourceRoot.resolve(EjectSupport.ownedTemplatePrefix(r.entry.ownedPackage(pkg)));
            for (String ref : r.entry.resources) {
                Path target = dir.resolve(ref + EjectSupport.TEMPLATE_EXTENSION);
                if (!written.add(target)) continue;
                String resource = GeneratorRegistry.EJECT_TEMPLATE_RESOURCE_ROOT + ref + EjectSupport.TEMPLATE_EXTENSION;
                String content;
                try {
                    content = readResource(resource);
                } catch (IOException ex) {
                    throw new MojoExecutionException("Could not read reference template \"" + ref
                            + "\" at classpath resource " + resource, ex);
                }
                switch (write(target.getParent(), target, content, force)) {
                    case CREATED:
                        getLog().info("Copied template " + ref + " -> " + target
                                + ". The owned " + r.entry.stableName + " reads this copy; you own it now.");
                        break;
                    case REPLACED:
                        getLog().info("Copied template " + ref + " -> " + target
                                + ", REPLACING the file that was there (-Dforce=true).");
                        break;
                    case PRESERVED:
                        getLog().info(target + " already exists — " + describeOwned(target, content)
                                + " Left untouched (-Dforce=true replaces it).");
                        break;
                }
            }
        }
    }

    // ------------------------------------------------------------------------------------
    // support source
    // ------------------------------------------------------------------------------------

    /** Write one owned copy of each support class beside the owned generators that import it. */
    private void ejectSupport(Set<String> support, Path dir, String pkg) throws MojoExecutionException {
        for (String simpleName : support) {
            String owned = EjectSupport.ownedSupportSource(readSupport(simpleName), simpleName, pkg);
            Path target = dir.resolve(simpleName + ".java");
            switch (write(dir, target, owned, force)) {
                case CREATED:
                    getLog().info("Copied support " + simpleName + " -> " + target
                            + ". The owned generators import this copy; you own it now.");
                    break;
                case REPLACED:
                    getLog().info("Copied support " + simpleName + " -> " + target
                            + ", REPLACING the file that was there (-Dforce=true).");
                    break;
                case PRESERVED:
                    getLog().info(target + " already exists — " + describeOwned(target, owned)
                            + " Left untouched (-Dforce=true replaces it).");
                    break;
            }
        }
    }

    private String readSupport(String simpleName) throws MojoExecutionException {
        String resource = GeneratorRegistry.EJECT_SUPPORT_RESOURCE_ROOT + simpleName + ".java";
        try {
            return readResource(resource);
        } catch (IOException ex) {
            throw new MojoExecutionException(
                    "Could not read reference support source \"" + simpleName + "\" at classpath "
                        + "resource " + resource, ex);
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

    private void reportEject(String what, Path target, String rewritten, WriteStatus status)
            throws MojoExecutionException {
        switch (status) {
            case CREATED:
                getLog().info("Ejected " + what + " -> " + target
                        + ". You own it now (ADR-0034 scaffold-and-own).");
                break;
            case REPLACED:
                getLog().info("Ejected " + what + " -> " + target + ", REPLACING the file "
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

    /** The artifact each port's copies compile against. */
    private static String codegenArtifact(EjectSupport.Port port) {
        return port == EjectSupport.Port.KOTLIN ? "metaobjects-codegen-kotlin" : "metaobjects-codegen-spring";
    }

    private static final String KOTLIN_PLUGIN = "kotlin-maven-plugin";

    private static final String KOTLIN_JVM_TARGET =
            "    <kotlin.compiler.jvmTarget>" + JAVA_RELEASE + "</kotlin.compiler.jvmTarget>\n";

    /** The Kotlin plugin's own source root, for a pom whose {@code <sourceDirectory>} is Java's. */
    private static final String KOTLIN_SOURCE_DIRS =
            "        <configuration>\n"
            + "          <sourceDirs>\n"
            + "            <sourceDir>${project.basedir}/src/main/kotlin</sourceDir>\n"
            + "          </sourceDirs>\n"
            + "        </configuration>\n";

    private String dependency(EjectSupport.Port port) {
        return "    <dependency>\n"
            + "      <groupId>com.metaobjects</groupId>\n"
            + "      <artifactId>" + codegenArtifact(port) + "</artifactId>\n"
            + "      <version>" + pluginVersion() + "</version>\n"
            + "    </dependency>\n";
    }

    /** The Kotlin compiler plugin, with {@code configuration} (possibly empty) inside it. */
    private static String kotlinPlugin(String configuration) {
        return "      <plugin>\n"
            + "        <groupId>org.jetbrains.kotlin</groupId>\n"
            + "        <artifactId>" + KOTLIN_PLUGIN + "</artifactId>\n"
            + "        <version>" + kotlin.KotlinVersion.CURRENT + "</version>\n"
            + configuration
            + "        <executions>\n"
            + "          <execution>\n"
            + "            <id>compile</id>\n"
            + "            <phase>compile</phase>\n"
            + "            <goals><goal>compile</goal></goals>\n"
            + "          </execution>\n"
            + "        </executions>\n"
            + "      </plugin>\n";
    }

    /** The ports the codegen module holds copies of: those with a source root in it. */
    private static Set<EjectSupport.Port> portsIn(Path codegenRoot) {
        Set<EjectSupport.Port> out = new LinkedHashSet<>();
        for (EjectSupport.Port port : EjectSupport.Port.values()) {
            if (Files.isDirectory(codegenRoot.resolve("src/main/" + port.id))) out.add(port);
        }
        return out;
    }

    private String codegenPom(String artifactId, Set<EjectSupport.Port> ports) {
        StringBuilder deps = new StringBuilder();
        for (EjectSupport.Port port : ports) deps.append(dependency(port));
        // A Kotlin-only module makes src/main/kotlin its source root. One that holds Java copies
        // too keeps Maven's default root for them, and the Kotlin plugin is given its own.
        boolean java = ports.contains(EjectSupport.Port.JAVA);
        String kotlinPlugin = ports.contains(EjectSupport.Port.KOTLIN)
            ? "  <build>\n"
              + (java ? "" : "    <sourceDirectory>src/main/kotlin</sourceDirectory>\n")
              + "    <plugins>\n"
              + kotlinPlugin(java ? KOTLIN_SOURCE_DIRS : "")
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
            + (ports.contains(EjectSupport.Port.KOTLIN) ? KOTLIN_JVM_TARGET : "")
            + "  </properties>\n"
            + "  <dependencies>\n"
            + deps
            + "  </dependencies>\n"
            + kotlinPlugin
            + "</project>\n";
    }

    private static final Pattern SOURCE_DIRECTORY =
            Pattern.compile("<sourceDirectory>\\s*([^<]*?)\\s*</sourceDirectory>");

    private static boolean declares(String pom, String artifactId) {
        return pom.contains("<artifactId>" + artifactId + "</artifactId>");
    }

    /**
     * Say what {@code codegen/pom.xml} does not declare that the copies under each port's source
     * root need. Eject writes that pom for the ports the module holds then and never edits it, so
     * a port ejected into the module in a later call is left out of the build, and the build passes.
     */
    private void reportWhatThePomLacks(Path codegenRoot) throws MojoExecutionException {
        Path pom = codegenRoot.resolve("pom.xml");
        String content;
        try {
            content = Files.readString(pom, StandardCharsets.UTF_8);
        } catch (IOException ex) {
            throw new MojoExecutionException("Could not read " + pom, ex);
        }
        for (EjectSupport.Port port : portsIn(codegenRoot)) {
            String sourceRoot = "src/main/" + port.id;
            List<String> changes = new ArrayList<>();
            if (!declares(content, codegenArtifact(port))) {
                changes.add("  Add to <dependencies>:\n" + dependency(port));
            }
            if (port == EjectSupport.Port.KOTLIN && !declares(content, KOTLIN_PLUGIN)) {
                changes.add("  Add to <properties>:\n" + KOTLIN_JVM_TARGET);
                changes.add("  Add to <build><plugins>:\n" + kotlinPlugin(KOTLIN_SOURCE_DIRS));
            }
            if (port == EjectSupport.Port.JAVA) {
                Matcher sourceDirectory = SOURCE_DIRECTORY.matcher(content);
                if (sourceDirectory.find() && !sourceDirectory.group(1).endsWith(sourceRoot)) {
                    changes.add("  Remove " + sourceDirectory.group() + " from <build>, so that Maven compiles "
                            + sourceRoot + ", and add to the <plugin> of " + KOTLIN_PLUGIN + ":\n"
                            + KOTLIN_SOURCE_DIRS);
                }
            }
            if (changes.isEmpty()) continue;
            getLog().warn(pom + " does not declare what the " + port.id + " copies under " + sourceRoot
                    + " need to build. It is yours, so eject does not edit it:");
            for (String change : changes) {
                for (String line : change.split("\n")) getLog().warn(line);
            }
        }
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
        String supportRows = ownedSupportRows(codegenRoot);
        if (!supportRows.isEmpty()) {
            sb.append("\nOwned support (the shared emit rules, copied by eject beside the generators "
                    + "that import them):\n").append(supportRows);
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

    /** One row per owned support copy under {@code codegen/src/main/java}. */
    private String ownedSupportRows(Path codegenRoot) {
        StringBuilder sb = new StringBuilder();
        for (String simple : GeneratorRegistry.EJECT_SUPPORT) {
            String owned = ownedSupportStaleness(codegenRoot, simple);
            if (owned != null) sb.append("  ").append(simple).append("  ").append(owned).append('\n');
        }
        return sb.toString();
    }

    /** The owned copy named {@code filename} under {@code codegen/src/main/<lang>}, or
     *  {@code null}. It may live under ANY package the adopter chose. */
    private static Path findOwned(Path codegenRoot, String langDir, String filename) throws IOException {
        if (codegenRoot == null) return null;
        Path srcRoot = codegenRoot.resolve("src/main/" + langDir);
        if (!Files.isDirectory(srcRoot)) return null;
        try (var walk = Files.walk(srcRoot)) {
            return walk.filter(p -> p.getFileName().toString().equals(filename)).findFirst().orElse(null);
        }
    }

    /** One owned support copy's staleness against the reference shipped with this plugin. */
    private String ownedSupportStaleness(Path codegenRoot, String simple) {
        try {
            Path found = findOwned(codegenRoot, "java", simple + ".java");
            if (found == null) return null;
            String owned = Files.readString(found, StandardCharsets.UTF_8);
            String reference = readSupport(simple);
            EjectSupport.Comparison cmp = EjectSupport.compare(owned, reference);
            return cmp.verdict == EjectSupport.Verdict.IDENTICAL
                    ? "[owned — identical]"
                    : "[owned — DIFFERS: " + cmp.behind + " behind, " + cmp.ownedOnly + " of your own]";
        } catch (IOException | MojoExecutionException ex) {
            return "[owned — could not compare: " + ex.getMessage() + "]";
        }
    }

    /**
     * The staleness of the owned copy of {@code e}: the generator is {@code identical} only when
     * its file AND every companion it owns are. The companions are the classes copied with it,
     * the page templates it reads (under the owned resources), the shared support rules it
     * imports and the helper runtime its output imports. Each companion that differs is named,
     * so the verdict says WHICH file to look at; {@code null} when there is no owned copy.
     */
    private String ownedStaleness(Path codegenRoot, EjectSupport.Entry e) {
        String langDir = e.port == EjectSupport.Port.KOTLIN ? "kotlin" : "java";
        try {
            Path found = findOwned(codegenRoot, langDir, e.simpleName() + "." + e.port.extension);
            if (found == null) return null;
            // The generator is owned together with every class copied with it, so the verdict
            // is over all of them, each against what eject would write beside this copy. One
            // that has gone missing counts as wholly behind.
            Path srcRoot = codegenRoot.resolve("src/main/" + langDir);
            String ownedPackage = srcRoot.relativize(found.getParent()).toString()
                    .replace(found.getFileSystem().getSeparator(), ".");
            int[] totals = new int[2];
            List<String> differing = new ArrayList<>();
            for (String source : e.sources()) {
                Path file = found.resolveSibling(
                        EjectSupport.simpleNameOf(source) + "." + e.port.extension);
                String owned = Files.exists(file) ? Files.readString(file, StandardCharsets.UTF_8) : "";
                String reference = EjectSupport.rewriteCopiedImports(
                        readResource(e.resourceOf(source)), e.sources(), ownedPackage);
                fold(totals, differing, EjectSupport.simpleNameOf(source) + "." + e.port.extension,
                        EjectSupport.compare(owned, reference));
            }
            if (e.port == EjectSupport.Port.JAVA) {
                // The page templates the owned generator reads: a template missing from the owned
                // resources counts as wholly behind.
                Path resourceRoot = codegenRoot.resolve("src/main/resources")
                        .resolve(EjectSupport.ownedTemplatePrefix(ownedPackage));
                for (String ref : e.resources) {
                    Path file = resourceRoot.resolve(ref + EjectSupport.TEMPLATE_EXTENSION);
                    String owned = Files.exists(file) ? Files.readString(file, StandardCharsets.UTF_8) : "";
                    String reference = readResource(GeneratorRegistry.EJECT_TEMPLATE_RESOURCE_ROOT
                            + ref + EjectSupport.TEMPLATE_EXTENSION);
                    fold(totals, differing, ref + EjectSupport.TEMPLATE_EXTENSION,
                            EjectSupport.compare(owned, reference));
                }
                // The shared support rules the generator imports, found wherever the adopter put
                // them (absent: not ejected, so nothing of the adopter's to be behind).
                Set<String> support = new java.util.LinkedHashSet<>();
                for (String source : e.sources()) {
                    support.addAll(EjectSupport.supportFor(readResource(e.resourceOf(source))));
                }
                for (String simple : support) {
                    Path owned = findOwned(codegenRoot, "java", simple + ".java");
                    if (owned == null) continue;
                    fold(totals, differing, simple + ".java", EjectSupport.compare(
                            Files.readString(owned, StandardCharsets.UTF_8), readSupport(simple)));
                }
                // The helper runtime its output imports, where this module (or a child) owns it.
                for (String simple : e.runtime) {
                    Path owned = findOwnedRuntime(simple);
                    if (owned == null) continue;
                    fold(totals, differing, simple + ".java", EjectSupport.compare(
                            Files.readString(owned, StandardCharsets.UTF_8),
                            readResource(GeneratorRegistry.EJECT_RUNTIME_RESOURCE_ROOT + simple + ".java")));
                }
            }
            return differing.isEmpty()
                    ? "[owned — identical]"
                    : "[owned — DIFFERS: " + totals[0] + " behind, " + totals[1] + " of your own; differing: "
                        + String.join(", ", differing) + "]";
        } catch (IOException | MojoExecutionException ex) {
            return "[owned — could not compare: " + ex.getMessage() + "]";
        }
    }

    /** Add one file's comparison to the running totals, naming it when it differs. */
    private static void fold(int[] totals, List<String> differing, String name, EjectSupport.Comparison cmp) {
        totals[0] += cmp.behind;
        totals[1] += cmp.ownedOnly;
        if (cmp.verdict != EjectSupport.Verdict.IDENTICAL) differing.add(name);
    }

    /** The owned runtime copy of {@code simple} in this module or one of its children, or {@code null}. */
    private Path findOwnedRuntime(String simple) throws IOException {
        if (project == null || project.getBasedir() == null) return null;
        Path base = project.getBasedir().toPath();
        List<Path> roots = new ArrayList<>();
        roots.add(base.resolve("src/main/java"));
        if (project.getModules() != null) {
            for (String module : project.getModules()) roots.add(base.resolve(module).resolve("src/main/java"));
        }
        for (Path root : roots) {
            if (!Files.isDirectory(root)) continue;
            try (var walk = Files.walk(root)) {
                for (Path p : (Iterable<Path>) walk.filter(f -> f.getFileName().toString().equals(simple + ".java"))::iterator) {
                    if (EjectSupport.isOwnedRuntime(Files.readString(p, StandardCharsets.UTF_8))) return p;
                }
            }
        }
        return null;
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
