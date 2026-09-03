package com.metaobjects.mojo;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.agentcontext.AgentContextScaffold;
import com.metaobjects.generator.Generator;
import com.metaobjects.loader.LoaderConfigurable;
import com.metaobjects.loader.LoaderConfigurationConstants;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.generator.EmitsPhysicalNameConstants;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.plugin.AbstractMojo;
import org.apache.maven.plugin.MojoExecution;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.project.MavenProject;

import java.io.File;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public abstract class AbstractMetaDataMojo extends AbstractMojo
{
    public final static String PHASE_GENERATE_SOURCES        = "generate-sources";
    public final static String PHASE_GENERATE_RESOURCES      = "generate-resources";
    public final static String PHASE_GENERATE_TEST_SOURCES   = "generate-test-sources";
    public final static String PHASE_GENERATE_TEST_RESOURCES = "generate-test-resources";

    /**
     * Location of the file.
     */
    @Parameter(required = true, property="project.build.directory", defaultValue="${project.build.directory}")
    private File outputDirectory;

    @Parameter( defaultValue = "${project}", readonly = true, required = true )
    protected MavenProject project;

    @Parameter( defaultValue = "${mojoExecution}", readonly = true, required = true )
    protected MojoExecution execution;

    @Parameter(name="loader")
    private LoaderParam loaderConfig = null;
    public LoaderParam getLoader() {
        return loaderConfig;
    }
    public void setLoader(LoaderParam loaderConfig) {
        this.loaderConfig = loaderConfig;
    }

    @Parameter
    public Map<String,String> globals;
    public Map<String, String> getGlobals() {
        return globals;
    }
    public void setGlobals(Map<String, String> globalArgs) {
        this.globals = globalArgs;
    }

    @Parameter(name="generators")
    public List<GeneratorParam> generators;
    public List<GeneratorParam> getGenerators() {
        return generators;
    }
    public void setGenerators(List<GeneratorParam> generators) {
        this.generators = generators;
    }

    /**
     * Strict-provenance opt-out for the {@code metaobjects:generate} /
     * {@code metaobjects:verify} goals (#96, ADR-0023).
     *
     * <p>By default ({@code false}) the loader runs strict: an own {@code @}-attribute
     * declared by no registered metamodel provider is {@link ErrorCode#ERR_UNKNOWN_ATTR}
     * and fails the build. Setting {@code -Dmeta.lax=true} loads non-strict so a downstream
     * adopter mid-migration — who still carries unregistered attributes (real cases:
     * {@code @isJson}, {@code @dataflow*}) — can BUILD and verify while reconciling the
     * metadata. The flag flows to the loader's {@link LoaderOptions#isStrict()} and is
     * shared by both goals (this Mojo is the common base).</p>
     *
     * <p>Mirrors the TS / Python {@code verify --lax} opt-out (#101). Default keeps today's
     * strict behavior.</p>
     */
    @Parameter(property = "meta.lax", defaultValue = "false")
    private boolean lax;
    public boolean isLax() {
        return lax;
    }
    public void setLax(boolean lax) {
        this.lax = lax;
    }

    public void execute() throws MojoExecutionException, MojoFailureException
    {
        // #233: warm the global registry singletons before this reactor module's load
        // can race a sibling module's first-init under `mvn -T`. Must precede
        // createLoader(), which triggers MavenLoaderConfiguration's eager
        // getTypeRegistry().getRegisteredTypes() first-touch on this thread.
        com.metaobjects.registry.RegistryBootstrap.warmUpDefaults();
        if ( getLoader() == null ) {
            throw new MojoExecutionException( "No <loader> element was defined");
        }
        warnIfAgentContextStale();

        ClassLoader projectClassLoader = createProjectClassLoader();

        MetaDataLoader loader = createLoader(projectClassLoader);

        List<Generator> generatorImpls = buildGenerators( projectClassLoader, null );

        executeGenerators( loader, generatorImpls );
    }

    /**
     * Reflectively instantiate and configure each declared generator, mirroring the exact
     * mechanism {@code meta:gen} uses. This is the single source of truth for generator
     * wiring so that sibling goals (e.g. {@code meta:verify}) drive identical behavior —
     * including loading generators from any module on the project classpath
     * (e.g. a {@code codegen-spring} or {@code codegen-kotlin} {@link Generator}).
     *
     * @param projectClassLoader the classloader that can see the project's generator deps
     * @param argOverridesByGenerator optional per-generator arg overrides keyed by
     *        {@link GeneratorParam} identity (e.g. redirecting {@code outputDir} to a temp
     *        dir for drift verification). May be {@code null} for no overrides.
     * @return the configured {@link Generator} list, in declaration order
     */
    protected List<Generator> buildGenerators(ClassLoader projectClassLoader,
                                              Map<GeneratorParam, Map<String, String>> argOverridesByGenerator) {
        List<Generator> generatorImpls = new ArrayList<>();
        // The args each generator will receive, in the same order — held back until the
        // whole suite is built. See the EmitsPhysicalNameConstants pass below: a generator
        // cannot answer "will <Entity>Names exist alongside my output?" on its own, and this
        // method is the one place that knows the answer.
        List<Map<String, String>> argsByGenerator = new ArrayList<>();

        if ( getGenerators() != null ) {
            for ( GeneratorParam g : getGenerators() ) {
                try {
                    // Reflective no-arg instantiation — the same SPI for every Generator
                    // impl regardless of source module (codegen-spring, codegen-kotlin, ...).
                    Class<?> generatorClass = projectClassLoader.loadClass(g.getClassname());
                    Constructor<?> constructor = generatorClass.getDeclaredConstructor();
                    Generator impl = (Generator) constructor.newInstance();

                    // Merge generator args and global args
                    Map<String, String> allargs = mergeAndOverwriteArgs(g);

                    // Apply any per-generator overrides (verify redirects outputDir here).
                    if ( argOverridesByGenerator != null ) {
                        Map<String, String> overrides = argOverridesByGenerator.get(g);
                        if ( overrides != null ) allargs.putAll(overrides);
                    }

                    // Merge loader filters and generator filters
                    List<String> allFilters = new ArrayList<>();
                    if ( g.getFilters() != null ) allFilters.addAll( g.getFilters() );
                    if ( loaderConfig.getFilters() != null ) allFilters.addAll( loaderConfig.getFilters() );
                    impl.setFilters( allFilters );

                    // Set the scripts
                    if ( g.getScripts() != null ) impl.setScripts(g.getScripts());

                    generatorImpls.add( impl );
                    argsByGenerator.add( allargs );
                }
                catch( Exception e ) {
                    throw new MetaDataException( "Error running generator ["+g.getClassname()+"]: "+e, e );
                }
            }
        }

        // NO MAGIC STRINGS — derive `useNames` from the SUITE, then hand every generator its
        // args. A generator that references `<Entity>Names.NAME` in a run with no names
        // generator emits code referencing a type nothing generated, so the substitution
        // shipped as an opt-in defaulting OFF and stayed off in practice. This is the
        // aggregation point that makes it safe to default from the run instead: the same
        // decision TypeScript makes from its `emitsNames` generator marker and C# from
        // GeneratorRegistry.IncludesNames. An explicit `<useNames>` in the pom still wins.
        for ( int i = 0; i < generatorImpls.size(); i++ ) {
            generatorImpls.get(i).setArgs(
                EmitsPhysicalNameConstants.deriveUseNames( argsByGenerator.get(i), generatorImpls ) );
        }

        return generatorImpls;
    }

    public Map<String, String> mergeAndOverwriteArgs(GeneratorParam g) {

        Map<String,String> allargs = new HashMap<>();
        if ( globals != null ) allargs.putAll(globals);
        if ( g.getArgs() != null ) allargs.putAll(g.getArgs());

        // Dump the args to debug
        getLog().debug( "-- Generator ["+g.getClass().getSimpleName()+"] merged Args");
        for ( String key : allargs.keySet()) {
            getLog().debug( "    "+key+" = '"+allargs.get(key) +
                    ((globals!=null && allargs.get(key).equals(globals.get(key)))?"  #GLOBAL#":""));
        }

        return allargs;
    }

    /**
     * Advisory nudge: if the consumer's copied-in agent context
     * ({@code .metaobjects/.agent-context.json} under the project basedir) was scaffolded
     * by a different MetaObjects version than the one running, print ONE warning line
     * suggesting {@code mvn metaobjects:agent-docs}.
     *
     * <p>Strictly advisory — never throws, never fails the build, never writes. A missing
     * or corrupt manifest is silently ignored (no agent context here → nothing to say).
     */
    protected void warnIfAgentContextStale() {
        try {
            File basedir = project != null ? project.getBasedir() : null;
            Path cwd = basedir != null ? basedir.toPath()
                    : Path.of(System.getProperty("user.dir"));
            Path manifestPath = cwd.resolve(AgentContextScaffold.MANIFEST_PATH);
            if (!Files.isRegularFile(manifestPath)) {
                return; // no agent context scaffolded here → nothing to nudge
            }
            JsonObject obj = JsonParser.parseString(
                    new String(Files.readAllBytes(manifestPath), StandardCharsets.UTF_8))
                    .getAsJsonObject();
            int version = obj.has("version") ? obj.get("version").getAsInt() : 1;
            String generatedBy = obj.has("generatedBy") && obj.get("generatedBy").isJsonPrimitive()
                    ? obj.get("generatedBy").getAsString() : null;
            AgentContextScaffold.Manifest manifest = new AgentContextScaffold.Manifest(
                    version, generatedBy, new ArrayList<>(), new ArrayList<>(),
                    new LinkedHashMap<>());
            // ACROSS VERSION LINES on purpose: the manifest is stamped by the Node CLI with an
            // npm version (0.24.1) while installedVersion() is the Maven one (7.24.1), so plain
            // equality never matched and this nudged on every build forever. See the javadoc.
            String nudge = AgentContextScaffold.stalenessAcrossVersionLines(
                    manifest, AgentContextScaffold.installedVersion());
            if (nudge != null) {
                getLog().warn(nudge);
            }
        } catch (Exception ignored) {
            // Advisory only — any failure to read/parse the manifest is silently ignored.
        }
    }

    protected abstract void executeGenerators(MetaDataLoader loader, List<Generator> generatorImpls);

    protected MetaDataLoader createLoader(ClassLoader projectClassLoader) {

        LoaderConfigurable configurable = null;
        String loaderClass = loaderConfig.getClassname();
        String loaderName = loaderConfig.getName();

        // ADR-0023 strict provenance with a #96 opt-out: lax=false (default) → strict load,
        // lax=true (-Dmeta.lax=true) → non-strict. The flag flows to BOTH loader-creation
        // paths — the LoaderOptions on the manual path, and the 'strict' loader argument
        // (honored by MetaDataLoader.processArguments) on the configured-class path.
        boolean strict = !lax;

        if (loaderClass != null) {
            configurable = getConfiguredLoader(projectClassLoader, loaderClass, loaderName);
        } else {
            configurable = new MetaDataLoader(
                    LoaderOptions.create(false, false, strict),
                    MetaDataLoader.SUBTYPE_MANUAL, loaderName);
        }

        // Configure the loader using the new pattern
        String sourceDir = null;
        File srcDir = getSourceDir();
        if (srcDir != null) {
            sourceDir = loaderConfig.getSourceDir();
        }

        // Precedence ladder (spec §5): when the pom names neither <sourceDir> nor
        // <sources>, fall back to the port-neutral .metaobjects/config.json (else the
        // built-in default directory) instead of silently loading nothing.
        List<String> sources = loaderConfig.getSources();
        List<String> neutralSources = resolveNeutralSourcesIfPomIsSilent(loaderConfig);
        if (!neutralSources.isEmpty()) {
            sources = neutralSources;
        } else if ((sources == null || sources.isEmpty()) && srcDir != null) {
            // <sourceDir> alone. The ladder above deliberately does not fire here —
            // naming EITHER key means the pom owns the concern — which used to leave
            // this branch with an empty source list: the generators ran against an
            // empty model, wrote zero files, and the build reported SUCCESS.
            //
            // That is the shape the adopter guidance teaches, and it is also the
            // remedy 0.24.0's own ERR_COLLECTION_NOT_FOUND prints ("declare
            // <sourceDir>/<sources> explicitly"), so following the fix for a silent
            // empty model landed you back in one. A directory names a directory:
            // expand it, through the SAME DirectorySource walk the loader itself uses
            // (via SourceResolver), so "which files count as metadata" keeps one
            // definition. The sourceDir base is dropped because the expansion is
            // already absolute.
            sources = expandSourceDir(srcDir);
            sourceDir = null;
        }

        // An unknown <library> name is a HARD failure naming the ones this version ships,
        // not a silent skip. `LibrarySources` skips deliberately for a programmatic caller
        // — asking for a package a given version does not ship should not stop that caller
        // loading its own metadata — but a name typed into a pom is a mistake worth failing
        // on: skipped, it resurfaces later as ERR_UNRESOLVED_SUPER pointing at the module's
        // OWN metadata, which is the wrong place to send someone looking. Same line the TS
        // and Python config readers draw, in the same place.
        List<String> libraries = loaderConfig.getLibraries();
        if (libraries != null && !libraries.isEmpty()) {
            List<String> available = com.metaobjects.library.LibrarySources.knownPackages();
            List<String> unknown = new ArrayList<>();
            for (String lib : libraries) {
                if (!available.contains(lib)) unknown.add(lib);
            }
            if (!unknown.isEmpty()) {
                // A MetaDataException, matching `failOnLoaderErrors` just below: this method
                // is not declared to throw the checked Maven type, and both failures are the
                // same kind of thing — the model this goal was asked to load cannot be.
                throw new MetaDataException(
                    "<loader><libraries> names unknown package(s) " + unknown
                        + "; available: " + available);
            }
        }

        MavenLoaderConfiguration.configure(configurable, sourceDir, projectClassLoader,
                                         sources, libraries, loaderArgs(strict));

        MetaDataLoader loader = configurable.getLoader();

        getLog().info("MetaData Mojo > Create Loader: " + loader.toString());

        // Strict provenance is RECORD-not-throw at the loader (ADR-0023): drain the
        // recorded errors here and fail the goal with an actionable hint. Skipped under
        // lax (where nothing is recorded). This is the shared reporting site for both the
        // generate and verify goals.
        failOnLoaderErrors(loader);

        return loader;
    }

    /**
     * Build the loader-argument map passed to {@link MavenLoaderConfiguration#configure}.
     * Carries the {@code globals} verbatim and injects the {@code strict} flag (from
     * {@code -Dmeta.lax}) so the configured-class loader path honors it via
     * {@link MetaDataLoader#processArguments}. An explicit {@code strict} in {@code globals}
     * wins (advanced override). Kept separate from {@link #mergeAndOverwriteArgs} so the
     * injected flag never pollutes generator args.
     */
    private Map<String, String> loaderArgs(boolean strict) {
        Map<String, String> args = new HashMap<>();
        if (globals != null) args.putAll(globals);
        args.putIfAbsent(LoaderConfigurationConstants.ARG_STRICT, String.valueOf(strict));
        return args;
    }

    /**
     * Fail the goal when a strict load RECORDED provenance errors (ADR-0023 records, it
     * does not throw). The loader's own error messages are reproduced verbatim (the loader
     * error code/text is unchanged); when an {@link ErrorCode#ERR_UNKNOWN_ATTR} is present
     * an actionable resolution hint — register a provider / use {@code attr.properties} /
     * {@code -Dmeta.lax=true} — is appended. No-op when there are no recorded errors (the
     * lax path, and every clean strict load).
     */
    private void failOnLoaderErrors(MetaDataLoader loader) {
        List<MetaDataException> errors = loader.getErrors();
        if (errors == null || errors.isEmpty()) return;

        boolean unknownAttr = errors.stream().anyMatch(
                e -> e.getCode().map(c -> c == ErrorCode.ERR_UNKNOWN_ATTR).orElse(false));

        StringBuilder sb = new StringBuilder();
        sb.append("MetaData loading failed under strict provenance (")
                .append(errors.size()).append(" error(s)):");
        for (MetaDataException e : errors) {
            sb.append("\n  - ").append(e.getMessage());
        }
        if (unknownAttr) {
            sb.append("\n\nAn @attribute is not declared by any registered metamodel provider. To resolve:")
                    .append("\n  • register the attribute via a metamodel provider (preferred — gates it cross-port); or")
                    .append("\n  • if it is arbitrary author-supplied data, carry it in the registered attr.properties bag; or")
                    .append("\n  • run with -Dmeta.lax=true to opt out of strict provenance (e.g. mid-migration, to")
                    .append("\n    inventory breakage before reconciling the metadata).");
        }
        throw new MetaDataException(sb.toString(),
                unknownAttr ? ErrorCode.ERR_UNKNOWN_ATTR : null);
    }

    private LoaderConfigurable getConfiguredLoader(ClassLoader projectClassLoader, String loaderClass, String loaderName) {

        LoaderConfigurable configurable;
        try {
            // Attempt to load the loader by classname
            Class c;
            try {
                c = projectClassLoader.loadClass(loaderClass);
            }
            catch (ClassNotFoundException ex) {
                throw new MetaDataException("Could not create MetaDataLoader(" + loaderName + ") with class " +
                        "[" + loaderClass + "] as it was not found on the Project ClassLoader");
            }

            // See if it's an interface
            if (c.isInterface()) {
                throw new MetaDataException("Could not create MetaDataLoader(" + loaderName + ") with class " +
                        "[" + loaderClass + "] as it is an interface");
            }

            // See if it implements LoaderConfigurable
            if (!LoaderConfigurable.class.isAssignableFrom(c)) {
                throw new MetaDataException("Could not create MetaDataLoader(" + loaderName + ") with class " +
                        "[" + loaderClass + "] as it does not implement LoaderConfigurable");
            }

            // Try for a constructor with a String for the loaderName
            Constructor cc = null;
            try {
                cc = c.getDeclaredConstructor(String.class);
            }
            catch (NoSuchMethodException | SecurityException ex) {
                throw new MetaDataException("Could not create MetaDataLoader(" + loaderName + ") with class " +
                        "[" + loaderClass + "] as the Constructor was not found or had security issues: " +
                        ex.getMessage(), ex);
            }

            configurable = (LoaderConfigurable) cc.newInstance(loaderName);
        }
        catch (InstantiationException | IllegalAccessException | InvocationTargetException ex) {
            throw new MetaDataException("Could not instantiate MetaDataLoader(" + loaderName + ") with class " +
                    "[" + loaderConfig.getClassname() + "]: " + ex.getMessage(), ex);
        }

        return configurable;
    }

    protected ClassLoader createProjectClassLoader()
    {
        ClassLoader thisLoader = getClass().getClassLoader(); //ClassLoader.getSystemClassLoader();

        if ( execution != null ) {
            try {
                String lifeCyclePhase = execution.getLifecyclePhase();
                if ( lifeCyclePhase == null ) lifeCyclePhase = "cli";

                getLog().info("MetaData Mojo > LifeCycle Phase: " + execution.getLifecyclePhase());

                List<String> runTimeClasspath   = project.getRuntimeClasspathElements();
                List<String> compileClasspath   = project.getCompileClasspathElements();
                //List<String> compileSources     = project.getCompileSourceRoots();
                List<String> testClasspath      = project.getTestClasspathElements();
                //List<String> testCompileSources = project.getTestCompileSourceRoots();
                //getLog().info( "runTimeClasspath: " + compileClasspath );
                //getLog().info( "compileClasspath: " + compileClasspath );
                //getLog().info( "compileSources: " + compileSources );
                //getLog().info( "testClasspath: " + compileClasspath );
                //getLog().info( "testSources: " + testCompileSources );

                List<String> classpathElements = new ArrayList<>();

                // Add runtime and compile time classes
                classpathElements.addAll(runTimeClasspath);
                classpathElements.addAll(compileClasspath);

                if ( lifeCyclePhase.equals(PHASE_GENERATE_SOURCES)) {
                    //classpathElements.add(project.getBuild().getOutputDirectory());
                }
                else if ( lifeCyclePhase.equals(PHASE_GENERATE_RESOURCES)) {
                    //classpathElements.add(project.getBuild().getOutputDirectory());
                    addDirIfExists( classpathElements, "generated-resources" );
                }
                else if (lifeCyclePhase.equals(PHASE_GENERATE_TEST_SOURCES)) {
                    // Get the processed resources and compiled classes
                    classpathElements.addAll(testClasspath);
                    classpathElements.add(project.getBuild().getOutputDirectory());
                    addDirIfExists( classpathElements, "generated-resources" );
                }
                else if (lifeCyclePhase.equals(PHASE_GENERATE_TEST_RESOURCES) ||
                        lifeCyclePhase.equals("cli")) {
                    // Get the processed resources and compiled classes
                    // Also get any generated-test-resources
                    classpathElements.addAll(testClasspath);
                    classpathElements.add(project.getBuild().getOutputDirectory());
                    addDirIfExists( classpathElements, "generated-resources" );
                    addDirIfExists( classpathElements, "generated-test-resources" );

                    //if ( lifeCyclePhase.equals("cli")) {
                    //    classpathElements.addAll(runTimeClasspath);
                    //    classpathElements.addAll(compileClasspath);
                    //}
                }

                if ( classpathElements.size() > 0 ) {
                    URL urls[] = new URL[classpathElements.size()];
                    for (int i = 0; i < classpathElements.size(); ++i) {
                        urls[i] = new File((String) classpathElements.get(i)).toURI().toURL();
                        
                        if (getLog().isDebugEnabled())
                            getLog().debug("MetaData Mojo > Adding Classpath URL: " + urls[i]);
                    }

                    thisLoader =  new URLClassLoader(urls, thisLoader );
                }
            }
            catch (Exception e) {
                //getLog().error("Error getting ProjectClassLoader, using SystemClassLoader: "+e.getMessage(), e);
                throw new MetaDataException( "Error getting ProjectClassLoader, using SystemClassLoader: "
                        + e.getMessage(), e);
            }
        } else {
            getLog().warn("Could not get phase from MojoExecution" );
        }

        return thisLoader;
    }

    protected void addDirIfExists(List<String> classpathElements, String s) {
        File f = new File( project.getBasedir()+"/target/"+s);
        //getLog().info( "Looking for: " + f.getPath());
        if ( f.exists() ) classpathElements.add( f.getPath() );
    }

    protected File getSourceDir() {
        String srcDir = loaderConfig.getSourceDir();
        File sourceDir = null;
        if ( srcDir != null ) {
            sourceDir = new File( loaderConfig.getSourceDir() );
            if ( !sourceDir.exists() ) {
                getLog().error( "SourceDir ["+srcDir+"] did not exist: "+sourceDir.getPath() );
                throw new IllegalArgumentException( "SourceDir [" + srcDir + "] does not exist" );
            }
        }
        return sourceDir;
    }

    /**
     * The module basedir metadata-source resolution is anchored to — the same
     * directory that would hold a project's {@code .metaobjects/} folder. Falls back
     * to the process working directory when {@code project} is unset (e.g. a Mojo
     * driven directly in a unit test, matching {@link #warnIfAgentContextStale()}'s
     * same fallback).
     */
    protected File getProjectBaseDir() {
        return project != null ? project.getBasedir() : new File(System.getProperty("user.dir"));
    }

    /**
     * The precedence ladder for where metadata lives (spec §5). First match wins.
     *
     * <p>1. The pom — {@code <loader><sourceDir>} or {@code <loader><sources>}. If
     * EITHER is present the pom owns the whole concern and the neutral file is not
     * consulted; precedence is whole-concern, not a per-entry merge.
     * <br>2. {@code sources} in the port-neutral {@code .metaobjects/config.json},
     * read from the module basedir.
     * <br>3. The built-in default directory.
     *
     * <p>A neutral file that EXISTS but is malformed throws rather than falling
     * through. {@code <filters>} is untouched by this ladder — {@code scope} stays
     * out of scope for this mechanism (Global Constraints).
     *
     * @return the resolved metadata file paths, or an empty list when the pom names
     *     either {@code <sourceDir>} or {@code <sources>} (i.e. the neutral file is
     *     not consulted at all)
     */
    /**
     * Expand a {@code <loader><sourceDir>} that carries no {@code <sources>} into the
     * metadata files it holds.
     *
     * <p>Delegates to {@link com.metaobjects.config.SourceResolver}, so the extension
     * filter and ordering are {@code DirectorySource}'s — the same walk the loader
     * performs for a directory source, rather than a second definition of what counts
     * as metadata.
     *
     * <p>A directory holding NOTHING is a failure, not an empty model. The whole point
     * of this branch is that generating zero files while reporting success is the
     * expensive outcome, and an empty directory reaches it by a different road than an
     * unnamed one.
     */
    protected List<String> expandSourceDir(File srcDir) {
        Path dir = srcDir.getAbsoluteFile().toPath().normalize();
        List<String> expanded = com.metaobjects.config.SourceResolver
                .resolveSources(getProjectBaseDir().toPath(),
                        List.of(java.util.Map.of("path", dir.toString())))
                .stream()
                .map(p -> "model:file:" + p.toString().replace(java.io.File.separatorChar, '/'))
                .toList();
        if (expanded.isEmpty()) {
            throw new MetaDataException(
                    "<loader><sourceDir> " + dir + " holds no metadata files. Point it at a "
                            + "directory containing metadata, or name the files with <sources>.",
                    ErrorCode.ERR_COLLECTION_NOT_FOUND);
        }
        return expanded;
    }

    protected List<String> resolveNeutralSourcesIfPomIsSilent(LoaderParam loaderConfig) {
        boolean pomNamesLocation =
                (loaderConfig.getSourceDir() != null && !loaderConfig.getSourceDir().isBlank())
                || (loaderConfig.getSources() != null && !loaderConfig.getSources().isEmpty());
        if (pomNamesLocation) return List.of();

        // Prefixed "model:file:" explicitly rather than handed back as a bare
        // Path::toString(): MetaDataLoader.processSources decides how to wrap a bare
        // source string by checking `s.indexOf(':') < 0`, and an absolute path is not
        // guaranteed colon-free — a Windows path (`C:\...`) fails that ambiguous
        // sniff and is handed to URIHelper.toURI() unwrapped, which dies in
        // validateUriType(). These are always fully-resolved absolute filesystem
        // paths (SourceResolver.resolveCollection), so there is nothing to sniff:
        // say "file" outright, the same shape processSources itself already builds
        // for its own `new File(s).exists()` branch.
        return com.metaobjects.config.SourceResolver
                .resolveCollection(getProjectBaseDir().toPath())
                .stream()
                .map(p -> "model:file:" + p.toString().replace(java.io.File.separatorChar, '/'))
                .toList();
    }
}
