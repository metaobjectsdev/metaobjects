package com.metaobjects.mojo;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaDataException;
import com.metaobjects.agentcontext.AgentContextScaffold;
import com.metaobjects.generator.Generator;
import com.metaobjects.loader.LoaderConfigurable;
import com.metaobjects.loader.LoaderOptions;
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

    public void execute() throws MojoExecutionException, MojoFailureException
    {
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
                    impl.setArgs(allargs);

                    // Merge loader filters and generator filters
                    List<String> allFilters = new ArrayList<>();
                    if ( g.getFilters() != null ) allFilters.addAll( g.getFilters() );
                    if ( loaderConfig.getFilters() != null ) allFilters.addAll( loaderConfig.getFilters() );
                    impl.setFilters( allFilters );

                    // Set the scripts
                    if ( g.getScripts() != null ) impl.setScripts(g.getScripts());

                    generatorImpls.add( impl );
                }
                catch( Exception e ) {
                    throw new MetaDataException( "Error running generator ["+g.getClassname()+"]: "+e, e );
                }
            }
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
            String nudge = AgentContextScaffold.staleness(
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

        if (loaderClass != null) {
            configurable = getConfiguredLoader(projectClassLoader, loaderClass, loaderName);
        } else {
            configurable = new MetaDataLoader(
                    LoaderOptions.create(false, false, true),
                    MetaDataLoader.SUBTYPE_MANUAL, loaderName);
        }

        // Configure the loader using the new pattern
        String sourceDir = null;
        File srcDir = getSourceDir();
        if (srcDir != null) {
            sourceDir = loaderConfig.getSourceDir();
        }

        MavenLoaderConfiguration.configure(configurable, sourceDir, projectClassLoader, 
                                         loaderConfig.getSources(), getGlobals());

        MetaDataLoader loader = configurable.getLoader();

        getLog().info("MetaData Mojo > Create Loader: " + loader.toString());

        return loader;
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
}
