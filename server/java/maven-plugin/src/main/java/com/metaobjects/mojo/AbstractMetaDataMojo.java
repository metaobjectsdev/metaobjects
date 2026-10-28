package com.metaobjects.mojo;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.agentcontext.AgentContextScaffold;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.ProjectClassLoaderAware;
import com.metaobjects.generator.RunAware;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.spring.SpringRenderHelperGenerator;
import com.metaobjects.generator.template.TemplateScopeGenerator;
import com.metaobjects.loader.LoaderConfigurable;
import com.metaobjects.loader.LoaderConfigurationConstants;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.generator.EmitsPhysicalNameConstants;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.generator.util.HashManifest;
import org.apache.maven.model.Plugin;
import org.apache.maven.model.PluginExecution;
import org.apache.maven.execution.MavenSession;
import org.apache.maven.model.Profile;
import org.apache.maven.model.building.ModelBuildingRequest;
import org.apache.maven.plugin.AbstractMojo;
import org.apache.maven.plugin.MojoExecution;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.Component;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.project.DefaultProjectBuildingRequest;
import org.apache.maven.project.MavenProject;
import org.apache.maven.project.ProjectBuilder;
import org.apache.maven.project.ProjectBuildingException;
import org.apache.maven.project.ProjectBuildingRequest;
import org.codehaus.plexus.util.xml.Xpp3Dom;

import java.io.File;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

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

    @Parameter( defaultValue = "${session}", readonly = true )
    protected MavenSession session;

    @Component
    protected ProjectBuilder projectBuilder;

    @Parameter( defaultValue = "${mojoExecution}", readonly = true, required = true )
    protected MojoExecution execution;

    /** This plugin's key in a module's build model. */
    static final String PLUGIN_KEY = "com.metaobjects:metaobjects-maven-plugin";

    /**
     * What a codegen hash manifest entry {@code g} writes is recorded against: the
     * generator's registry id and its output directory relative to the module basedir.
     * It names the configuration, not the Maven execution, so a command-line run, a
     * renamed execution and the lifecycle execution with the same configuration agree.
     * {@code null} for a generator with no {@code outputDir}.
     */
    protected HashManifest.Owner ownerOf(GeneratorParam g) {
        return ownerOf(g.getClassname(), mergeAndOverwriteArgs(g).get(GeneratorBase.ARG_OUTPUTDIR));
    }

    private HashManifest.Owner ownerOf(String classname, String outputDir) {
        if (classname == null || outputDir == null) return null;
        return new HashManifest.Owner(RequiresCheck.registryId(classname), moduleDir(Path.of(outputDir)));
    }

    /** {@code dir} as an owner names it: relative to the module basedir when inside it. */
    private String moduleDir(Path outputDir) {
        Path dir = outputDir.toAbsolutePath().normalize();
        String shown = dir.toString();
        if (project != null && project.getBasedir() != null) {
            Path base = project.getBasedir().toPath().toAbsolutePath().normalize();
            if (dir.startsWith(base)) shown = base.relativize(dir).toString();
        }
        return shown.replace(File.separatorChar, '/');
    }

    /**
     * Whether no generator the module configures for {@code dir}, in any execution or the
     * plugin-level configuration, keeps hand edits: an edited orphan there may be deleted
     * only when every writer of the directory says {@code handEdits=overwrite}. {@code false}
     * when what is configured is unknown, so an edited orphan is never deleted on a guess.
     */
    protected boolean noConfiguredWriterKeeps(Path dir) {
        ConfiguredOwners c = configured();
        return c.owners() != null && !c.keepDirs().contains(moduleDir(dir));
    }

    /**
     * Every generator/output-directory pair the module configures for
     * {@code metaobjects:generate}: in each of its executions and in the plugin-level
     * configuration a command-line run uses. It is the union over the module built with
     * no profile, with each profile of the module and its parents active alone, and with
     * this build's own active profiles, so a profile switched off for one build does not
     * make its generators' files look stranded, and two profiles that set the same
     * property or execution differently each count. Maven builds each model, so profile
     * properties, inherited profiles and basedirs resolve as they do when the profile is
     * on. {@code null} when a model cannot be built or none declares this plugin, so what
     * is configured is unknown. Computed once per module per build and kept in the
     * project's build context, since every execution of the module reads the same POMs.
     */
    protected Set<HashManifest.Owner> configuredOwners() {
        return configured().owners();
    }

    /**
     * Fail before anything is written when two {@code metaobjects:generate} executions of
     * the module, in any of the models {@link #configuredOwners} reads, configure the same
     * generator into the same output directory. Their files would share one owner, so
     * neither execution could tell the other's output from its own orphans. The
     * plugin-level configuration is no execution of its own: a command-line run of it and
     * the one execution that inherits it are the same configuration. An execution disabled
     * with {@code <phase>none</phase>} is not counted here, though its pairs still count as
     * configured, so the output of an on-demand run is never stranded; run explicitly
     * ({@code mvn metaobjects:generate@<id>}), it is refused when an enabled execution owns
     * one of its generator/output-directory pairs.
     */
    protected void refuseSharedGeneratorDirs() {
        List<String> shared = new ArrayList<>();
        Map<HashManifest.Owner, List<String>> executions = configured().executions();
        executions.forEach((owner, by) -> {
            if (by.size() > 1) shared.add("'" + owner + "' in executions " + String.join(" and ", by));
        });
        String self = execution != null ? execution.getExecutionId() : null;
        if (isDisabledGenerateExecution(self) && getGenerators() != null) {
            for (GeneratorParam g : getGenerators()) {
                HashManifest.Owner owner = ownerOf(g);
                List<String> by = owner != null ? executions.get(owner) : null;
                if (by != null && !by.isEmpty()) {
                    shared.add("'" + owner + "' in executions " + String.join(" and ", by) + " and '" + self
                            + "' (<phase>none</phase>, invoked explicitly)");
                }
            }
        }
        if (shared.isEmpty()) return;
        shared.sort(String::compareTo);
        throw new MetaDataException("Two metaobjects:generate executions of this module configure the same "
                + "generator into the same output directory: " + String.join("; ", shared) + ". Give each "
                + "execution its own <outputDir>, or merge them into one execution.");
    }

    private ConfiguredOwners configured() {
        if (project == null || project.getFile() == null || projectBuilder == null || session == null) {
            return ConfiguredOwners.UNKNOWN;
        }
        if (project.getContextValue(CONFIGURED_OWNERS_CONTEXT_KEY) instanceof ConfiguredOwners known) {
            return known;
        }
        ConfiguredOwners read = readConfiguredOwners();
        project.setContextValue(CONFIGURED_OWNERS_CONTEXT_KEY, read);
        return read;
    }

    private record ConfiguredOwners(Set<HashManifest.Owner> owners, Map<HashManifest.Owner, List<String>> executions,
                                    Set<String> keepDirs) {
        static final ConfiguredOwners UNKNOWN = new ConfiguredOwners(null, Map.of(), Set.of());
    }

    private static final String CONFIGURED_OWNERS_CONTEXT_KEY =
            AbstractMetaDataMojo.class.getName() + ".configuredOwners";

    private ConfiguredOwners readConfiguredOwners() {
        Set<String> profileIds = new LinkedHashSet<>();
        for (MavenProject p = project; p != null; p = p.getParent()) {
            if (p.getModel() == null) continue;
            for (Profile profile : p.getModel().getProfiles()) profileIds.add(profile.getId());
        }
        List<MavenProject> models = new ArrayList<>();
        models.add(project);
        MavenProject base = projectWith(null, profileIds);
        if (base == null) return ConfiguredOwners.UNKNOWN;
        models.add(base);
        for (String id : profileIds) {
            MavenProject alone = projectWith(id, profileIds);
            if (alone == null) return ConfiguredOwners.UNKNOWN;
            models.add(alone);
        }
        Set<HashManifest.Owner> out = new HashSet<>();
        Set<String> keepDirs = new HashSet<>();
        Map<HashManifest.Owner, Set<String>> executions = new HashMap<>();
        Map<String, String> profileOf = new HashMap<>();
        Set<String> baseIds = generateExecutionIds(base);
        List<String> profiles = new ArrayList<>(profileIds);
        for (int i = 0; i < profiles.size(); i++) {
            for (String id : generateExecutionIds(models.get(i + 2))) {
                if (!baseIds.contains(id)) profileOf.putIfAbsent(id, profiles.get(i));
            }
        }
        boolean declared = false;
        for (MavenProject model : models) {
            Plugin plugin = model.getPlugin(PLUGIN_KEY);
            if (plugin == null) continue;
            declared = true;
            Xpp3Dom pluginLevel = plugin.getConfiguration() instanceof Xpp3Dom dom ? dom : null;
            out.addAll(configuredIn(pluginLevel, keepDirs));
            for (PluginExecution e : plugin.getExecutions()) {
                if (!e.getGoals().contains("generate")) continue;
                if (!(e.getConfiguration() instanceof Xpp3Dom execution)) continue;
                for (HashManifest.Owner owner : configuredIn(pluginLevel == null ? execution
                        : Xpp3Dom.mergeXpp3Dom(new Xpp3Dom(execution), pluginLevel), keepDirs)) {
                    out.add(owner);
                    if (isEnabledGenerate(e)) {
                        executions.computeIfAbsent(owner, k -> new LinkedHashSet<>()).add(e.getId());
                    }
                }
            }
        }
        if (!declared) return ConfiguredOwners.UNKNOWN;
        Map<HashManifest.Owner, List<String>> byOwner = new HashMap<>();
        executions.forEach((owner, ids) -> byOwner.put(owner, ids.stream()
                .map(id -> "'" + id + "'" + (profileOf.containsKey(id) ? " (profile '" + profileOf.get(id) + "')" : ""))
                .toList()));
        return new ConfiguredOwners(out, byOwner, keepDirs);
    }

    private static Set<String> generateExecutionIds(MavenProject model) {
        Set<String> ids = new HashSet<>();
        Plugin plugin = model.getPlugin(PLUGIN_KEY);
        if (plugin == null) return ids;
        for (PluginExecution e : plugin.getExecutions()) {
            if (isEnabledGenerate(e)) ids.add(e.getId());
        }
        return ids;
    }

    /** A {@code metaobjects:generate} execution not switched off with {@code <phase>none</phase>}
     *  (how a module disables an execution it inherits). */
    private static boolean isEnabledGenerate(PluginExecution e) {
        return e.getGoals().contains("generate") && !"none".equals(e.getPhase());
    }

    /** Whether {@code id} names a generate execution of this module disabled with
     *  {@code <phase>none</phase>}, as {@code mvn metaobjects:generate@<id>} can still run. */
    private boolean isDisabledGenerateExecution(String id) {
        Plugin plugin = project != null && id != null ? project.getPlugin(PLUGIN_KEY) : null;
        if (plugin == null) return false;
        for (PluginExecution e : plugin.getExecutions()) {
            if (id.equals(e.getId()) && e.getGoals().contains("generate") && !isEnabledGenerate(e)) return true;
        }
        return false;
    }

    /** This module built by Maven with only profile {@code active} on ({@code null}: none of
     *  {@code all}); {@code null} when the build fails. */
    private MavenProject projectWith(String active, Set<String> all) {
        List<String> inactive = new ArrayList<>(all);
        inactive.remove(active);
        ProjectBuildingRequest request = new DefaultProjectBuildingRequest(session.getProjectBuildingRequest());
        request.setActiveProfileIds(active == null ? List.of() : List.of(active));
        request.setInactiveProfileIds(inactive);
        request.setResolveDependencies(false);
        request.setValidationLevel(ModelBuildingRequest.VALIDATION_LEVEL_MINIMAL);
        request.setProject(null);
        try {
            return projectBuilder.build(project.getFile(), request).getProject();
        } catch (ProjectBuildingException e) {
            getLog().warn("MetaData Mojo > Could not read every profile's configuration of this module, so files "
                    + "only a removed generator wrote are not cleaned up this run: " + e.getMessage());
            return null;
        }
    }

    /** The generator/output-directory pairs {@code dom} configures; adds to {@code keepDirs}
     *  the output directory of each one that keeps hand edits. */
    private List<HashManifest.Owner> configuredIn(Xpp3Dom dom, Set<String> keepDirs) {
        List<HashManifest.Owner> out = new ArrayList<>();
        if (dom == null) return out;
        Map<String, String> domGlobals = childValues(dom.getChild("globals"));
        Xpp3Dom generators = dom.getChild("generators");
        if (generators == null) return out;
        for (Xpp3Dom generator : generators.getChildren()) {
            Xpp3Dom classname = generator.getChild("classname");
            if (classname == null) continue;
            Map<String, String> args = mergeArgs(domGlobals, childValues(generator.getChild("args")));
            HashManifest.Owner owner = ownerOf(classname.getValue(), args.get(GeneratorBase.ARG_OUTPUTDIR));
            if (owner == null) continue;
            out.add(owner);
            Xpp3Dom handEdits = generator.getChild("handEdits");
            if (handEdits == null || handEdits.getValue() == null
                    || !GeneratorParam.HAND_EDITS_OVERWRITE.equals(handEdits.getValue().trim())) {
                keepDirs.add(owner.outputDir());
            }
        }
        return out;
    }

    private static Map<String, String> childValues(Xpp3Dom dom) {
        Map<String, String> out = new HashMap<>();
        if (dom == null) return out;
        for (Xpp3Dom child : dom.getChildren()) {
            if (child.getValue() != null) out.put(child.getName(), child.getValue().trim());
        }
        return out;
    }

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

    // The parameters of the `docs` goal removed in 8.1.0 (ADR-0034 Amendment 9), which nothing
    // reads. They are declared so that a pom still setting one is refused by name: Maven drops
    // an element no goal declares without a word, and the build would then write no
    // documentation and say nothing. (The goal's fifth parameter, <outputDirectory>, is this
    // class's own build directory and cannot be told apart.)
    @Parameter(property = "metaobjects.docs.language")
    private String language;
    @Parameter(property = "metaobjects.docs.apiSubDir")
    private String apiSubDir;
    @Parameter(property = "metaobjects.docs.layout")
    private String layout;
    @Parameter(property = "metaobjects.docs.modelBaseUrl")
    private String modelBaseUrl;

    /**
     * Refuse a pom that still carries the removed {@code docs} goal's configuration. ADR-0034
     * Amendment 9 fixes the sentence for every port.
     *
     * @param goal the goal refusing, as the adopter typed it ({@code generate}, {@code verify})
     */
    protected void refuseRemovedDocsConfiguration(String goal) throws MojoFailureException {
        List<String> set = new ArrayList<>();
        if (language != null) set.add("<language>");
        if (apiSubDir != null) set.add("<apiSubDir>");
        if (layout != null) set.add("<layout>");
        if (modelBaseUrl != null) set.add("<modelBaseUrl>");
        if (set.isEmpty()) return;
        throw new MojoFailureException(
                "metaobjects:" + goal + ": found 1.0 docs configuration (" + String.join(", ", set)
                    + " in the plugin's <configuration>). Nothing reads it any more, so this run would "
                    + "write no documentation. Declare each docs generator as a <generator> entry in the "
                    + "plugin's <generators>. See " + DocsMojo.MIGRATION + ".");
    }

    public void execute() throws MojoExecutionException, MojoFailureException
    {
        // #233: warm the global registry singletons before this reactor module's load
        // can race a sibling module's first-init under `mvn -T`. Must precede
        // createLoader(), which triggers MavenLoaderConfiguration's eager
        // getTypeRegistry().getRegisteredTypes() first-touch on this thread.
        refuseRemovedDocsConfiguration( execution != null ? execution.getGoal() : "generate" );
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
                    // A generator that loads a class the project names in an arg (a requirement
                    // test renderer or filter) must look in the project's loader, not its own.
                    if ( impl instanceof ProjectClassLoaderAware ) {
                        ((ProjectClassLoaderAware) impl).setProjectClassLoader( projectClassLoader );
                    }

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
        // args. A generator that references `<Entity>Names` in a run with no names
        // generator emits code referencing a type nothing generated, so the substitution
        // shipped as an opt-in defaulting OFF and stayed off in practice. This is the
        // aggregation point that makes it safe to default from the run instead: the same
        // decision TypeScript makes from its `emitsNames` generator marker and C# from
        // GeneratorRegistry.IncludesNames. An explicit `<useNames>` in the pom still wins.
        for ( int i = 0; i < generatorImpls.size(); i++ ) {
            generatorImpls.get(i).setArgs(
                EmitsPhysicalNameConstants.deriveUseNames( argsByGenerator.get(i), generatorImpls ) );
        }
        // A generator whose output depends on its siblings (the routes generator mounts a
        // report's ?format branch only beside a report-export generator) is handed the suite.
        List<Generator> run = Collections.unmodifiableList( generatorImpls );
        for ( Generator impl : generatorImpls ) {
            if ( impl instanceof RunAware ) ((RunAware) impl).setRun( run );
        }

        return generatorImpls;
    }

    /**
     * Generator args that name a filesystem path. A relative one is resolved against the
     * module basedir, as {@code <sourceDir>} is ({@link #getSourceDir}): left alone, the JVM
     * resolves it against the shell's working directory, so {@code mvn -f <module>/pom.xml}
     * run from anywhere else read templates from, and wrote output to, the wrong place.
     */
    static final Set<String> PATH_ARGS = Set.of(
            GeneratorBase.ARG_OUTPUTDIR,
            MultiFileDirectGeneratorBase.ARG_FINALOUTPUTDIR,
            TemplateScopeGenerator.ARG_TEMPLATES_DIR,
            // Kotlin's render helper reads the same key (KotlinRenderHelperGenerator.ARG_TEMPLATE_ROOT).
            SpringRenderHelperGenerator.ARG_TEMPLATE_ROOT);

    public Map<String, String> mergeAndOverwriteArgs(GeneratorParam g) {

        Map<String,String> allargs = mergeArgs(globals, g.getArgs());

        // Dump the args to debug
        getLog().debug( "-- Generator ["+g.getClass().getSimpleName()+"] merged Args");
        for ( String key : allargs.keySet()) {
            getLog().debug( "    "+key+" = '"+allargs.get(key) +
                    ((globals!=null && allargs.get(key).equals(globals.get(key)))?"  #GLOBAL#":""));
        }

        return allargs;
    }

    /** {@code args} over {@code globalArgs}, with every path arg resolved against the
     *  module basedir. */
    private Map<String, String> mergeArgs(Map<String, String> globalArgs, Map<String, String> args) {
        Map<String,String> allargs = new HashMap<>();
        if ( globalArgs != null ) allargs.putAll(globalArgs);
        if ( args != null ) allargs.putAll(args);

        File basedir = project != null ? project.getBasedir() : null;
        if ( basedir != null ) {
            for ( String key : PATH_ARGS ) {
                String value = allargs.get(key);
                if ( value == null || value.isEmpty() || new File(value).isAbsolute() ) continue;
                allargs.put(key, basedir.toPath().resolve(value).normalize().toString());
            }
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
            sourceDir = srcDir.getPath(); // basedir-resolved, not the pom's raw string
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
            // knownTokens(), NOT knownPackages(): a selection is layer-granular
            // ("iam/db"), and knownPackages() answers with the LIBRARY names ([ai, iam]).
            // Validating against the latter rejected the very selection the TS and Python
            // configs carry, and printed a list the user could not act on. knownTokens()
            // is the set a selection is actually drawn from — its javadoc has said "what a
            // config error prints" since layers landed; this is the caller it never had.
            List<String> available = com.metaobjects.library.LibrarySources.knownTokens();
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

        // ADR-0058 — the project's physical-naming rules, set on the loaded root so every
        // resolver downstream of this load (codegen, OMDB) reads the one setting.
        loader.getRoot().setPhysicalNaming(resolvePhysicalNaming(srcDir));
        // ADR-0019 Amendment 2 — the wire setting, from the same file, read by the generators.
        loader.getRoot().setWireFormat(resolveProjectConfig(srcDir)
                .map(com.metaobjects.config.NeutralConfig::getWireFormat)
                .orElse(com.metaobjects.config.WireFormat.DEFAULT));

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

    /**
     * The pom's {@code <sourceDir>}, a relative one resolved against the module basedir the
     * way every relative path in a pom is. {@code new File(relative)} alone resolves against
     * the JVM's working directory, which in a reactor build is the PARENT for every module —
     * so the documented {@code <sourceDir>src/main/metaobjects</sourceDir>} failed "does not
     * exist" from the root, and under {@code mvn -f <module>/pom.xml}.
     */
    protected File getSourceDir() {
        String srcDir = loaderConfig.getSourceDir();
        File sourceDir = null;
        if ( srcDir != null ) {
            sourceDir = new File( srcDir );
            if ( !sourceDir.isAbsolute() && project != null && project.getBasedir() != null ) {
                sourceDir = new File( project.getBasedir(), srcDir );
            }
            if ( !sourceDir.exists() ) {
                getLog().error( "SourceDir ["+srcDir+"] did not exist: "+sourceDir.getPath() );
                throw new IllegalArgumentException( "SourceDir [" + srcDir + "] does not exist" );
            }
        }
        return sourceDir;
    }

    /**
     * ADR-0058 — the {@code naming} setting of the project that holds this goal's metadata.
     * When the pom names where metadata lives ({@code <sourceDir>}, or a {@code <sources>}
     * entry that is a local path), that project is the nearest ancestor of the metadata
     * location carrying a {@code .metaobjects/config.json}, searched up to the repository
     * root — so a per-port pom in a subdirectory ({@code <sourceDir>../metaobjects</sourceDir>})
     * reads the root project's rule, as C#'s {@code MetadataLocation} does. Otherwise, and
     * when no such ancestor exists, the module basedir's config (or the default).
     */
    protected com.metaobjects.database.PhysicalNaming resolvePhysicalNaming(File srcDir) {
        return resolveProjectConfig(srcDir)
                .map(com.metaobjects.config.NeutralConfig::getPhysicalNaming)
                .orElse(com.metaobjects.database.PhysicalNaming.DEFAULT);
    }

    /**
     * The {@code .metaobjects/config.json} of the project that holds this goal's metadata, found
     * as {@link #resolvePhysicalNaming(File)} describes; empty when there is none.
     */
    protected java.util.Optional<com.metaobjects.config.NeutralConfig> resolveProjectConfig(File srcDir) {
        Path basedir = getProjectBaseDir().toPath();
        Path location = srcDir != null ? srcDir.toPath() : localSourceLocation(basedir);
        if (location != null) {
            for (Path dir = location.toAbsolutePath().normalize(); dir != null; dir = dir.getParent()) {
                java.util.Optional<com.metaobjects.config.NeutralConfig> cfg =
                        com.metaobjects.config.NeutralConfig.read(dir);
                if (cfg.isPresent()) return cfg;
                if (Files.exists(dir.resolve(".git"))) break;
            }
        }
        return com.metaobjects.config.NeutralConfig.read(basedir.toAbsolutePath().normalize());
    }

    /** The first {@code <sources>} entry that is an existing local path, as a directory; else null. */
    private Path localSourceLocation(Path basedir) {
        List<String> sources = loaderConfig.getSources();
        if (sources == null) return null;
        for (String s : sources) {
            if (s.indexOf(':') >= 0) continue;
            Path p = basedir.resolve(s);
            if (Files.isDirectory(p)) return p;
            if (Files.exists(p)) return p.getParent();
        }
        return null;
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
