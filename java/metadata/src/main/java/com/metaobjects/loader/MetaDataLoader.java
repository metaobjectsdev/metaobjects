/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.loader;

import com.metaobjects.MetaData;
import com.metaobjects.MetaDataNotFoundException;
import com.metaobjects.MetaRoot;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import com.metaobjects.object.MetaObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.metaobjects.loader.uri.URIHelper;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * MetaDataLoader serves as the foundation for loading and managing metadata definitions.
 *
 * <p>As of H3a Task 4, {@code MetaDataLoader} is a <strong>plain class</strong> — it is no
 * longer a {@link MetaData} node. Instead it <em>produces</em> and owns a {@link MetaRoot}
 * (the real tree-root node), accessible via {@link #getRoot()}. All loaded objects/fields
 * attach as children of that root. The loader retains source consumption, parse
 * orchestration, deferred super-resolution, the validation passes, freeze, registry
 * integration, and error/warning collection — but no longer carries node identity
 * (no children/parent/attrs of its own).</p>
 *
 * <p>MetaDataLoader operates exactly like Java's ClassLoader - it loads metadata definitions
 * once at startup and keeps them permanently in memory for the application lifetime. This is
 * <strong>NOT</strong> a typical data access pattern but rather a metadata definition system
 * analogous to the Java reflection system.</p>
 *
 * <strong>Loading vs Runtime Phases</strong>:
 * <pre>{@code
 * // LOADING PHASE - Happens once at startup
 * MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true), "manual", "myLoader");
 * loader.setSourceURIs(Arrays.asList(URIHelper.toURI("model:file:/path/to/metadata.json")));
 * loader.init(); // Loads ALL metadata into permanent memory structures (including URI sources)
 *
 * // RUNTIME PHASE - All operations are READ-ONLY
 * MetaObject userMeta = loader.getMetaObjectByName("User");  // O(1) lookup
 * MetaField field = userMeta.getMetaField("email");          // Cached access
 * }</pre>
 *
 * @author Doug Mealing
 * @version 6.0.0
 * @since 1.0
 * @see MetaRoot
 */
public class MetaDataLoader implements LoaderConfigurable {

    private static final Logger log = LoggerFactory.getLogger(MetaDataLoader.class);

    // Concurrent loading protection
    private static final ConcurrentHashMap<String, CompletableFuture<MetaDataLoader>> activeLoaders = new ConcurrentHashMap<>();
    private static final long DEFAULT_LOADING_TIMEOUT_MS = 30000; // 30 seconds

    public final static String TYPE_LOADER = "loader";
    public final static String SUBTYPE_MANUAL = "manual";

    /** Package separator — re-exported for parser convenience (mirrors {@link MetaData#PKG_SEPARATOR}). */
    public final static String PKG_SEPARATOR = MetaData.PKG_SEPARATOR;

    // TODO:  Allow for custom configurations for overloaded MetaDataLoaders
    private final LoaderOptions loaderOptions;

    // Loader identity (the loader is no longer a MetaData node, so it keeps its
    // own type/subType/name fields).
    private final String subType;
    private final String name;

    // The tree-root node this loader produces and owns.
    private final MetaRoot root;

    // ClassLoader used for resolving metadata-referenced Java classes.
    private ClassLoader metaDataClassLoader = null;

    // v6.0.0: Unified registry
    private MetaDataRegistry typeRegistry = null;
    private MetaDataLoaderRegistry loaderRegistry = null;

    // Enhanced thread-safe loading state management (sole lifecycle authority;
    // the legacy isInitialized/isRegistered/isDestroyed booleans were removed
    // in H3a Task 4).
    private final LoadingState loadingState = new LoadingState();

    // URI-based source list (H3a Task 5: lifted from SimpleLoader).
    // If set before init(), sources are loaded automatically during init().
    private List<URI> sourceURIs = null;

    /**
     * Convenience constructor accepting only a name.
     * Uses {@link LoaderOptions} defaults (no-register, non-verbose, strict) and
     * {@link #SUBTYPE_MANUAL} as the subType.
     *
     * <p>This constructor satisfies the {@code Constructor(String)} reflection contract
     * required by {@code AbstractMetaDataMojo.getConfiguredLoader()} when
     * {@code MetaDataLoader} is specified as the loader classname in a Maven plugin
     * configuration.</p>
     *
     * @param name the loader name
     */
    public MetaDataLoader(String name) {
        this(LoaderOptions.create(false, false, true), SUBTYPE_MANUAL, name);
    }

    /**
     * Constructs a new MetaDataLoader
     * @param subtype The subType for the metadata loader
     */
    public MetaDataLoader(LoaderOptions loaderOptions, String subtype ) {
        this( loaderOptions, subtype, TYPE_LOADER + "-" + System.currentTimeMillis());
    }

    /**
     * Constructs a new MetaDataLoader
     * @param subtype The subtype of the metadata loader
     * @param name The name of the metadata loader
     */
    public MetaDataLoader(LoaderOptions loaderOptions, String subtype, String name ) {
        this.loaderOptions = loaderOptions;
        this.subType = subtype;
        this.name = name;
        // Produce the tree-root node. The root's name must satisfy the metadata
        // identifier pattern, so loader-name hyphens are normalized to underscores.
        this.root = new MetaRoot( sanitizeRootName( name ) );
        this.root.setLoader( this );
    }

    /** Normalize a loader name into a metadata-identifier-safe root name. */
    private static String sanitizeRootName(String loaderName) {
        if (loaderName == null || loaderName.isEmpty()) return "root";
        return loaderName.replace('-', '_');
    }

    /**
     * Manually construct a MetaDataLoader.  Usually used for unit testing.
     * @param name The name of the Manually create MetaDataLoader
     * @return The created MetaDataLoader
     */
    public static MetaDataLoader createManual( boolean shouldRegister, String name ) {
        return new MetaDataLoader(
                LoaderOptions.create( false, false, false),
                        SUBTYPE_MANUAL, name );
    }

    /**
     * Construct a MetaDataLoader, set the given URI list, then init + load — all in one call.
     * Equivalent to the old {@code SimpleLoader.createManualURIs(name, uris)}.
     *
     * @param name the loader name
     * @param uris model URIs to load (e.g. {@code model:resource:…}, {@code model:file:…})
     * @return a fully-initialized loader with all URIs loaded
     */
    public static MetaDataLoader createFromURIs(String name, List<URI> uris) {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), SUBTYPE_MANUAL, name);
        loader.setSourceURIs(uris);
        loader.init();
        return loader;
    }

    /**
     * Construct a MetaDataLoader from classpath resource paths, then init + load.
     * Each resource path is wrapped as {@code model:resource:<path>}.
     * Equivalent to the old {@code SimpleLoader.createManual(name, List&lt;String&gt;)}.
     *
     * @param name      the loader name
     * @param resources classpath resource paths (no {@code model:} prefix needed)
     * @return a fully-initialized loader with all resources loaded
     */
    public static MetaDataLoader createFromResources(String name, List<String> resources) {
        List<URI> uris = new ArrayList<>();
        for (String r : resources) uris.add(URIHelper.toURI("model:resource:" + r));
        return createFromURIs(name, uris);
    }

    ///////////////////////////////////////////////////////////////////////
    // Identity

    /** Returns the loader name. */
    public String getName() {
        return name;
    }

    /** Returns the loader subType. */
    public String getSubType() {
        return subType;
    }

    /** Returns the loader type — always {@link #TYPE_LOADER}. */
    public String getType() {
        return TYPE_LOADER;
    }

    /** Returns the short (unqualified) loader name. */
    public String getShortName() {
        int i = name.lastIndexOf(MetaData.PKG_SEPARATOR);
        return i >= 0 ? name.substring(i + MetaData.PKG_SEPARATOR.length()) : name;
    }

    ///////////////////////////////////////////////////////////////////////
    // Root access (H3a Task 4)

    /**
     * Returns the {@link MetaRoot} tree-root node this loader produces and owns.
     * Loaded metadata attaches as children of this root.
     *
     * @return the owned MetaRoot; never null
     */
    public MetaRoot getRoot() {
        return root;
    }

    /**
     * {@inheritDoc}
     * <p>The loader is a {@link LoaderConfigurable}; {@code getLoader()} returns
     * the loader itself.</p>
     */
    @Override
    public MetaDataLoader getLoader() {
        return this;
    }

    ///////////////////////////////////////////////////////////////////////
    // ClassLoader

    /**
     * Sets the ClassLoader used to resolve metadata-referenced Java classes.
     * @param <T> the loader type for fluent chaining
     * @param classLoader the ClassLoader to use
     * @return this loader
     */
    @SuppressWarnings("unchecked")
    public <T extends MetaDataLoader> T setMetaDataClassLoader( ClassLoader classLoader ) {
        this.metaDataClassLoader = classLoader;
        return (T) this;
    }

    protected ClassLoader getDefaultMetaDataClassLoader() {
        return getClass().getClassLoader();
    }

    public ClassLoader getMetaDataClassLoader() {
        if (metaDataClassLoader != null) {
            return metaDataClassLoader;
        }
        return getDefaultMetaDataClassLoader();
    }

    ///////////////////////////////////////////////////////////////////////
    // Source URIs (H3a Task 5: lifted from SimpleLoader)

    /**
     * Set the URI list to be loaded during {@link #init()}.
     *
     * @param sourceURIs list of model URIs; must not be {@code null}
     * @return this loader (for fluent chaining)
     */
    @SuppressWarnings("unchecked")
    public <T extends MetaDataLoader> T setSourceURIs(List<URI> sourceURIs) {
        this.sourceURIs = sourceURIs;
        return (T) this;
    }

    /**
     * Returns the URI list set via {@link #setSourceURIs}, or {@code null} if none was set.
     */
    public List<URI> getSourceURIs() {
        return sourceURIs;
    }

    ///////////////////////////////////////////////////////////////////////
    // Configs

    public LoaderOptions getLoaderOptions() {
        return loaderOptions;
    }

    public MetaDataRegistry getTypeRegistry() {
        if (typeRegistry == null) {
            typeRegistry = MetaDataRegistry.getInstance();
        }
        return typeRegistry;
    }

    public MetaDataLoader setTypeRegistry(MetaDataRegistry typeRegistry) {
        this.typeRegistry = typeRegistry;
        return this;
    }

    public MetaDataLoaderRegistry getLoaderRegistry() {
        if (loaderRegistry == null) {
            loaderRegistry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
        }
        return loaderRegistry;
    }

    public MetaDataLoader setLoaderRegistry(MetaDataLoaderRegistry loaderRegistry) {
        this.loaderRegistry = loaderRegistry;
        return this;
    }

    /**
     * Check the state of the MetaDataLoader to ensure it is initialized and not destroyed.
     */
    protected void checkState() {
        if (!loadingState.isUsable()) {
            throw new IllegalStateException(
                String.format("MetaDataLoader [%s] is not usable. %s",
                    getName(), loadingState.getStatusDescription()));
        }
    }

    /**
     * Get the current loading state
     * @return The LoadingState instance
     */
    public LoadingState getLoadingState() {
        return loadingState;
    }

    /**
     * Check if the loader is currently loading
     * @return true if loading is in progress
     */
    public boolean isLoading() {
        return loadingState.isLoadingInProgress();
    }

    /**
     * Get detailed status information
     * @return String describing the current loader status
     */
    public String getDetailedStatus() {
        return String.format("MetaDataLoader[%s] %s", getName(), loadingState.getStatusDescription());
    }

    /**
     * Build a unique key for this loader instance for concurrent loading protection
     */
    private String buildLoaderKey() {
        return String.format("%s:%s:%s", getClass().getSimpleName(), getSubType(), getName());
    }

    /**
     * Check if this loader is currently being initialized by another thread
     * @return true if initialization is in progress
     */
    public boolean isInitializationInProgress() {
        String loaderKey = buildLoaderKey();
        CompletableFuture<MetaDataLoader> future = activeLoaders.get(loaderKey);
        return future != null && !future.isDone();
    }

    /**
     * Get the number of loaders currently being initialized
     * @return Number of active initializations
     */
    public static int getActiveInitializationCount() {
        return (int) activeLoaders.values().stream().filter(f -> !f.isDone()).count();
    }

    /**
     * Force cleanup of failed or stale loader initialization attempts
     * @param loaderKey The key of the loader to cleanup, or null to cleanup all failed attempts
     */
    public static void cleanupFailedInitializations(String loaderKey) {
        if (loaderKey != null) {
            CompletableFuture<MetaDataLoader> future = activeLoaders.get(loaderKey);
            if (future != null && (future.isDone() || future.isCompletedExceptionally())) {
                activeLoaders.remove(loaderKey);
                log.debug("Cleaned up failed initialization for loader: {}", loaderKey);
            }
        } else {
            activeLoaders.entrySet().removeIf(entry -> {
                CompletableFuture<MetaDataLoader> future = entry.getValue();
                if (future.isDone() || future.isCompletedExceptionally()) {
                    log.debug("Cleaned up initialization for loader: {}", entry.getKey());
                    return true;
                }
                return false;
            });
        }
    }

    /**
     * Retry initialization with error recovery
     * @param maxRetries Maximum number of retry attempts
     * @param retryDelayMs Delay between retries in milliseconds
     * @return This MetaDataLoader
     * @throws MetaDataLoadingException if all retries fail
     */
    public MetaDataLoader initWithRetry(int maxRetries, long retryDelayMs) {
        MetaDataLoadingException lastException = null;

        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    log.debug("Retrying initialization for loader [{}], attempt {} of {}",
                           getName(), attempt + 1, maxRetries + 1);

                    resetForRetry();

                    if (retryDelayMs > 0) {
                        Thread.sleep(retryDelayMs);
                    }
                }

                return init();

            } catch (MetaDataLoadingException e) {
                lastException = e;
                log.warn("Initialization attempt {} failed for loader [{}]: {}",
                        attempt + 1, getName(), e.getMessage());

                cleanupFailedInitializations(buildLoaderKey());

                if (attempt == maxRetries) {
                    break;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new MetaDataLoadingException(
                    "Initialization retry interrupted for loader: " + getName(), e);
            }
        }

        throw new MetaDataLoadingException(
            "Failed to initialize loader [" + getName() + "] after " + (maxRetries + 1) + " attempts",
            getName(), LoadingState.Phase.INITIALIZING, 0, lastException);
    }

    /**
     * Reset loader state for retry attempts
     */
    private void resetForRetry() {
        loadingState.forceTransition(LoadingState.Phase.UNINITIALIZED);
        loadingState.clearError();

        if (typeRegistry != null || loaderRegistry != null) {
            log.debug("Clearing partial registry state for retry");
            typeRegistry = null;
            loaderRegistry = null;
        }

        log.debug("Reset loader state for retry: {}", getName());
    }

    /**
     * Graceful shutdown with cleanup
     */
    public void shutdown() {
        try {
            log.info("Shutting down MetaDataLoader [{}]", getName());

            String loaderKey = buildLoaderKey();
            CompletableFuture<MetaDataLoader> future = activeLoaders.get(loaderKey);
            if (future != null && !future.isDone()) {
                future.cancel(true);
                log.debug("Cancelled active initialization for loader: {}", loaderKey);
            }

            if (!isDestroyed()) {
                destroy();
            }

            cleanupFailedInitializations(loaderKey);

            log.info("Successfully shut down MetaDataLoader [{}]", getName());

        } catch (Exception e) {
            log.error("Error during shutdown of MetaDataLoader [{}]", getName(), e);
        }
    }

    ////////////////////////////////////////////////////////////////////////////////////////////
    // LoaderConfigurable Support Methods
    private String configSourceDir = null;

    @Override
    public void configure(LoaderConfiguration config) {
        if (config.getClassLoader() != null) {
            if (log.isDebugEnabled()) log.debug("Setting ClassLoader: " + config.getClassLoader());
            setMetaDataClassLoader(config.getClassLoader());
        }

        if (config.getSourceDir() != null) {
            File sd = new File(config.getSourceDir());
            if (!sd.exists()) throw new IllegalStateException("SourceDir [" + config.getSourceDir() + "] does not exist");
            if (log.isDebugEnabled()) log.debug("Setting SourceDir: " + config.getSourceDir());
            configSourceDir = config.getSourceDir();
        }

        if (config.getSources() != null && !config.getSources().isEmpty()) {
            if (log.isDebugEnabled()) log.debug("Processing sources: " + config.getSources());
            processSources(configSourceDir, config.getSources());
        }

        processArguments(config.getArguments());
        init();
    }

    /**
     * Convert a list of source strings to URIs and store them for loading during {@link #init()}.
     * Each string may be a bare path (resolved against {@code sourceDir} or the classpath) or a
     * fully-qualified {@code model:…} URI string.  This is the same logic that used to live in
     * {@code SimpleLoader.processSources()} and is invoked by {@link #configure(LoaderConfiguration)}.
     */
    protected void processSources(String sourceDir, List<String> sourceList) {
        if (sourceList == null) throw new IllegalArgumentException(
                "sourceList was null on processSources for " + getName());

        List<URI> uris = new ArrayList<>();
        for (String s : sourceList) {
            if (s.indexOf(':') < 0) {
                if (sourceDir != null) {
                    s = "model:file:" + s + ";" + com.metaobjects.loader.uri.URIHelper.URI_ARG_SOURCEDIR + "=" + sourceDir;
                } else if (new File(s).exists()) {
                    s = "model:file:" + s;
                } else {
                    s = "model:resource:" + s;
                }
            }
            uris.add(URIHelper.toURI(s));
        }
        setSourceURIs(uris);
    }

    protected void processArguments(Map<String, String> args) {
        if (args == null) return;

        if (args.get(LoaderConfigurationConstants.ARG_REGISTER) != null) {
            getLoaderOptions().setShouldRegister(Boolean.parseBoolean(args.get(LoaderConfigurationConstants.ARG_REGISTER)));
        }
        if (args.get(LoaderConfigurationConstants.ARG_VERBOSE) != null) {
            getLoaderOptions().setVerbose(Boolean.parseBoolean(args.get(LoaderConfigurationConstants.ARG_VERBOSE)));
        }
        if (args.get(LoaderConfigurationConstants.ARG_STRICT) != null) {
            getLoaderOptions().setStrict(Boolean.parseBoolean(args.get(LoaderConfigurationConstants.ARG_STRICT)));
        }
    }

    ////////////////////////////////////////////////////////////////////////////////////////////
    // Initialization Methods

    protected void initDefaultRegistries() {
        if (typeRegistry == null) {
            typeRegistry = MetaDataRegistry.getInstance();
            log.debug("Initialized default MetaDataRegistry for loader: {}", getName());
        }

        if (loaderRegistry == null) {
            loaderRegistry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());
            log.debug("Initialized default MetaDataLoaderRegistry for loader: {}", getName());
        }
    }

    /**
     * Initialize the MetaDataLoader with enhanced thread-safe state management and concurrent protection.
     * @return This MetaDataLoader
     * @throws MetaDataLoadingException if initialization fails
     */
    public MetaDataLoader init() {
        return initWithConcurrencyProtection(DEFAULT_LOADING_TIMEOUT_MS);
    }

    /**
     * Initialize the MetaDataLoader with concurrent protection and custom timeout.
     * @param timeoutMs Maximum time to wait for initialization in milliseconds
     * @return This MetaDataLoader
     * @throws MetaDataLoadingException if initialization fails or times out
     */
    public MetaDataLoader initWithTimeout(long timeoutMs) {
        return initWithConcurrencyProtection(timeoutMs);
    }

    /**
     * Internal initialization method with concurrent protection
     */
    private MetaDataLoader initWithConcurrencyProtection(long timeoutMs) {
        String loaderKey = buildLoaderKey();

        CompletableFuture<MetaDataLoader> loadingFuture = activeLoaders.computeIfAbsent(loaderKey,
            key -> CompletableFuture.supplyAsync(() -> performInitialization(key),
                                               ForkJoinPool.commonPool()));

        try {
            return loadingFuture.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            activeLoaders.remove(loaderKey);
            throw new MetaDataLoadingException(
                "Loader initialization timeout after " + timeoutMs + "ms: " + loaderKey,
                getName(), LoadingState.Phase.INITIALIZING, timeoutMs, e);
        } catch (InterruptedException | ExecutionException e) {
            activeLoaders.remove(loaderKey);
            Throwable cause = e instanceof ExecutionException ? e.getCause() : e;
            throw new MetaDataLoadingException(
                "Loader initialization failed: " + loaderKey,
                getName(), LoadingState.Phase.INITIALIZING, 0, cause);
        }
    }

    /**
     * Internal method that performs the actual initialization work
     */
    private MetaDataLoader performInitialization(String loaderKey) {
        long startTime = System.currentTimeMillis();

        try {
            return performInitializationInternal(startTime);
        } catch (Exception e) {
            throw new RuntimeException("Failed to initialize loader: " + loaderKey, e);
        } finally {
            activeLoaders.remove(loaderKey);
        }
    }

    /**
     * Core initialization logic
     */
    private MetaDataLoader performInitializationInternal(long startTime) {
        validateAndTransitionToInitializing();

        try {
            logInitializationStart();
            initializeRegistriesIfNeeded();
            loadSourceURIsIfPresent();
            transitionToInitialized(startTime);
            registerIfRequested();
            logInitializationSuccess(startTime);

            return this;

        } catch (Exception e) {
            handleInitializationFailure(e, startTime);
            throw e;
        }
    }

    /**
     * If {@link #sourceURIs} has been populated (e.g. via {@link #setSourceURIs} or
     * {@link #processSources}), parse each URI into this loader's {@link MetaRoot}.
     * Called automatically from {@link #performInitializationInternal} so that
     * {@code setSourceURIs(...).init()} is the standard URI-based loading pattern.
     *
     * <p>Each URI is wrapped in a {@link URIMetaDataSource} (which infers JSON vs XML
     * from the file extension) and routed through the canonical
     * {@link #load(List)} method, ensuring a single parser-dispatch path.</p>
     */
    private void loadSourceURIsIfPresent() {
        if (sourceURIs == null || sourceURIs.isEmpty()) return;

        List<MetaDataSource> sources = new ArrayList<>();
        for (URI uri : sourceURIs) {
            sources.add(new URIMetaDataSource(uri));
        }
        load(sources);
    }

    private void validateAndTransitionToInitializing() {
        if (!loadingState.tryTransition(LoadingState.Phase.UNINITIALIZED, LoadingState.Phase.INITIALIZING)) {
            LoadingState.Phase currentPhase = loadingState.getCurrentPhase();
            if (currentPhase == LoadingState.Phase.INITIALIZED || currentPhase == LoadingState.Phase.REGISTERED) {
                throw new IllegalStateException("MetaDataLoader [" + getName() + "] was already initialized");
            } else {
                throw new IllegalStateException("MetaDataLoader [" + getName() + "] cannot be initialized from phase: " + currentPhase);
            }
        }
    }

    private void logInitializationStart() {
        if (loaderOptions.isVerbose()) {
            log.info("Loading the [" + getClass().getSimpleName() + "] MetaDataLoader with name [" + getName() + "]");
        }
    }

    private void initializeRegistriesIfNeeded() {
        if (typeRegistry == null || loaderRegistry == null) {
            initDefaultRegistries();
        }
    }

    private void transitionToInitialized(long startTime) {
        if (!loadingState.tryTransition(LoadingState.Phase.INITIALIZING, LoadingState.Phase.INITIALIZED)) {
            throw new MetaDataLoadingException(
                "Failed to transition to INITIALIZED phase",
                getName(), loadingState.getCurrentPhase(),
                System.currentTimeMillis() - startTime);
        }
    }

    private void registerIfRequested() {
        if (loaderOptions.shouldRegister()) {
            register();
        }
    }

    private void logInitializationSuccess(long startTime) {
        if (loaderOptions.isVerbose()) {
            log.info("Successfully loaded MetaDataLoader [" + getName() + "] in " +
                    (System.currentTimeMillis() - startTime) + "ms");
        }
    }

    private void handleInitializationFailure(Exception e, long startTime) {
        loadingState.setError(e, LoadingState.Phase.UNINITIALIZED);

        if (!(e instanceof MetaDataLoadingException)) {
            throw new MetaDataLoadingException(
                "Failed to initialize MetaDataLoader [" + getName() + "]",
                getName(), LoadingState.Phase.INITIALIZING,
                System.currentTimeMillis() - startTime, e);
        }
    }

    /**
     * Returns if the MetaDataLoader is initialized
     * @return True if initialized
     */
    public boolean isInitialized() {
        return loadingState.isInPhase(LoadingState.Phase.INITIALIZED, LoadingState.Phase.REGISTERED);
    }

    /**
     * Register this MetaDataLoader using enhanced state management
     */
    public MetaDataLoader register() {
        if (!loadingState.tryTransition(LoadingState.Phase.INITIALIZED, LoadingState.Phase.REGISTERING)) {
            LoadingState.Phase currentPhase = loadingState.getCurrentPhase();
            if (currentPhase == LoadingState.Phase.REGISTERED) {
                return this;
            } else {
                throw new IllegalStateException(
                    "Cannot register MetaDataLoader [" + getName() + "] from phase: " + currentPhase);
            }
        }

        try {
            if (!loadingState.tryTransition(LoadingState.Phase.REGISTERING, LoadingState.Phase.REGISTERED)) {
                throw new IllegalStateException(
                    "Failed to transition to REGISTERED phase for MetaDataLoader [" + getName() + "]");
            }

            if (loaderOptions.isVerbose()) {
                log.info("Successfully registered MetaDataLoader [" + getName() + "]");
            }

            return this;

        } catch (Exception e) {
            loadingState.setError(e, LoadingState.Phase.INITIALIZED);
            throw new MetaDataLoadingException(
                "Failed to register MetaDataLoader [" + getName() + "]",
                getName(), LoadingState.Phase.REGISTERING, 0, e);
        }
    }

    /**
     * Returns whether the MetaDataLoader is registered
     */
    public boolean isRegistered() {
        return loadingState.isInPhase(LoadingState.Phase.REGISTERED);
    }

    ////////////////////////////////////////////////////////////////////////////////////////////
    // Source-based load pipeline (H3a Task 4)

    /**
     * Load metadata from a list of {@link MetaDataSource} instances. Each source's
     * raw content is read and parsed into this loader's {@link MetaRoot}; parsed
     * nodes accumulate on the root across sources. Mirrors the TypeScript
     * {@code MetaDataLoader.load(MetaDataSource[])} pipeline.
     *
     * <p>This is a thin wrapper over the existing parser machinery — it routes
     * each source to the JSON or XML parser based on {@link MetaDataSource#getFormat()}.
     * The loader must already be initialized (see {@link #init()}).</p>
     *
     * @param sources the sources to consume, in order
     * @return this loader
     */
    public MetaDataLoader load(List<MetaDataSource> sources) {
        if (sources == null) throw new IllegalArgumentException("sources must not be null");

        for (MetaDataSource source : sources) {
            String content;
            try {
                content = source.read();
            } catch (IOException e) {
                throw new MetaDataLoadingException(
                    "Failed to read metadata source [" + source.getId() + "]: " + e.getMessage(),
                    getName(), LoadingState.Phase.INITIALIZING, 0, e);
            }

            // All metadata sources are canonical JSON; dispatch unconditionally to CanonicalJsonParser.
            InputStream is = new ByteArrayInputStream(content.getBytes(StandardCharsets.UTF_8));
            CanonicalJsonParser parser = new CanonicalJsonParser(this, source.getId());
            parser.loadFromStream(is);
        }

        return this;
    }

    ////////////////////////////////////////////////////////////////////////////////////////////
    // Node-style QUERY accessors — read-only delegations to the owned MetaRoot.
    //
    // As of H3a Task 4 the loader carries no node identity. Tree MUTATION
    // (addChild/clearChildren/addMetaAttr) is NOT exposed here — callers that
    // need to build the tree must do so through {@link #getRoot()}.

    /** Wrap the MetaDataLoader (unsupported). */
    public MetaDataLoader overload() {
        throw new IllegalStateException( "You cannot wrap a MetaDataLoader!" );
    }

    /** Returns all direct children of the root node. */
    public List<MetaData> getChildren() {
        return root.getChildren();
    }

    /** Returns all children of the root node of the given class. */
    public <N extends MetaData> List<N> getChildren(Class<N> c) {
        return root.getChildren(c);
    }

    /** Returns all children of the root node of the given class. */
    public <N extends MetaData> List<N> getChildren(Class<N> c, boolean includeParentData) {
        return root.getChildren(c, includeParentData);
    }

    /** Returns the root child with the given type and name. */
    public MetaData getChildOfType(String type, String name) throws MetaDataNotFoundException {
        return root.getChildOfType(type, name);
    }

    /** Returns the root child with the given name and class. */
    public <T extends MetaData> T getChild(String name, Class<T> c) throws MetaDataNotFoundException {
        return root.getChild(name, c);
    }

    /**
     * Whether the MetaDataLoader handles the object specified
     */
    protected boolean handles(Object obj) {
        checkState();
        return getMetaObjectFor(obj) != null;
    }

    /**
     * Retrieves a collection of all MetaData of the specified type
     */
    public List<MetaData> getMetaDataOfType( String type ) {
        return getMetaDataOfType(type, true);
    }

    /**
     * Retrieves a collection of all MetaData of the specified type
     */
    public List<MetaData> getMetaDataOfType( String type, boolean includeParentData ) {
        checkState();
        return root.getChildrenOfType(type, includeParentData);
    }

    /**
     * Retrieves a collection of all MetaObjects
     */
    public List<MetaObject> getMetaObjects() {
        checkState();
        return root.getChildren( MetaObject.class, true );
    }

    /**
     * Retrieves a MetaObject by name
     */
    public MetaObject getMetaObjectByName(String name ) {
        checkState();
        return (MetaObject) root.getChildOfType( MetaObject.TYPE_OBJECT, name );
    }

    /**
     * Return the matching object instance
     */
    @SuppressWarnings("unchecked")
    public <T> T newObjectInstance(Class<T> clazz) throws ClassNotFoundException {
        for(MetaObject mo : getMetaObjects()) {
            if (mo.getObjectClass().equals(clazz)) {
                return (T) mo.newInstance();
            }
        }
        throw new ClassNotFoundException("Could not find MetaObject for class ["+clazz.getName()+"]");
    }

    /**
     * Gets the MetaObject of the specified Object
     */
    public MetaObject getMetaObjectFor(Object obj) {
        checkState();
        for (MetaObject mc : root.getChildren( MetaObject.class, true )) {
            if (mc.produces(obj)) {
                return mc;
            }
        }
        return null;
    }

    /**
     * Retrieves a collection of all MetaData of the specified Class type
     */
    public <N extends MetaData> List<N> getMetaData(Class<N> c ) {
        return getMetaData(c, true);
    }

    /**
     * Retrieves a collection of all MetaData of the specified Class type
     */
    public <N extends MetaData> List<N> getMetaData( Class<N> c, boolean includeParentData ) {
        checkState();
        return root.getChildren(c, includeParentData);
    }

    /**
     * Gets the MetaData with the specified Class type and name
     */
    @SuppressWarnings("unchecked")
    public <N extends MetaData> N getMetaDataByName( Class<N> c, String metaDataName) throws MetaDataNotFoundException {

        checkState();

        String KEY = "QuickCache-"+c.getName()+"-"+metaDataName;

        MetaData mc = (MetaData) root.getCacheValue(KEY);
        if (mc == null) {
            synchronized( this ) {
                mc = (MetaData) root.getCacheValue(KEY);
                if (mc == null) {
                    for (MetaData mc2 : getMetaData( c )) {
                        if (mc2.getName().equals(metaDataName)) {
                            mc = mc2;
                            break;
                        }
                    }
                    if (mc != null) {
                        root.setCacheValue(KEY, mc);
                    }
                }
            }

            if (mc == null) {
                throw new MetaDataNotFoundException( "MetaData with name [" + metaDataName + "] not found in MetaDataLoader [" + toString() + "]", metaDataName );
            }
        }

        return (N) mc;
    }

    /**
     * Gets the MetaData with the specified name in parent hierarchy.
     * Only uses direct 'super' relationship, not 'inherits'
     */
    @SuppressWarnings("unchecked")
    protected List<MetaObject> getMetaDataBySuper(String metaDataName, List<MetaObject> objects) throws MetaDataNotFoundException {

        checkState();

        String KEY = "QuickCacheDerived-" + metaDataName;
        List<MetaObject> result = (List<MetaObject>) root.getCacheValue(KEY);
        if (result == null) {
            synchronized (this) {
                result = (List<MetaObject>) root.getCacheValue(KEY);
                if (result == null) {
                    result = new ArrayList<>();

                    for (MetaObject mo : objects) {
                        if (null != mo.getSuperObject()) {
                            if (mo.getSuperObject().getName().equals(metaDataName)) {
                                result.add( mo);
                                result.addAll( getMetaDataBySuper(mo.getName(), objects));
                            }
                        }
                    }
                    root.setCacheValue(KEY, result);
                }
            }
        }
        return result;
    }

    /**
     * Gets the MetaData with the specified name in parent hierarchy.
     * Only uses direct 'super' relationship, not 'inherits'
     */
    @SuppressWarnings("unchecked")
    public List<MetaObject> getMetaDataBySuper(String metaDataName) throws MetaDataNotFoundException {

        checkState();

        String KEY = "QuickCacheDerived-" + metaDataName;
        List<MetaObject> result = (List<MetaObject>) root.getCacheValue(KEY);
        if (result == null) {
            synchronized (this) {
                result = (List<MetaObject>) root.getCacheValue(KEY);
                if (result == null) {
                    List<MetaObject> objects = getMetaObjects();
                    result = getMetaDataBySuper(metaDataName, objects);
                }
            }
        }

        return result;
    }

    /**
     * Lookup the specified class by name
     */
    public Class<?> loadClass(String className ) throws ClassNotFoundException {

        checkState();
        try {
            return getClass().getClassLoader().loadClass( className );
        } catch (ClassNotFoundException e) {
            throw new ClassNotFoundException("Specified Java Class [" + className + "] was not found: " + e.getMessage(), e);
        }
    }

    /**
     * Unloads the MetaDataLoader with enhanced state management
     */
    public void destroy() {
        if (loadingState.isDestroyed()) {
            throw new IllegalStateException("MetaDataLoader [" + getName() + "] was already destroyed!");
        }

        if (loaderOptions.isVerbose()) {
            log.info("Destroying the [" + getName() + "] MetaDataLoader");
        }

        try {
            root.clearChildren();

            loadingState.forceTransition(LoadingState.Phase.DESTROYED);

            if (loaderOptions.isVerbose()) {
                log.info("Successfully destroyed MetaDataLoader [" + getName() + "]");
            }

        } catch (Exception e) {
            loadingState.setError(e);
            log.error("Error during destruction of MetaDataLoader [" + getName() + "]", e);
            throw new RuntimeException("Failed to destroy MetaDataLoader [" + getName() + "]", e);
        }
    }

    public boolean isDestroyed() {
        return loadingState.isDestroyed();
    }

    ////////////////////////////////////////////////////
    // MISC METHODS

    public String toString() {
        return getClass().getSimpleName() + "[" + getSubType() + ":" + getName() + "]";
    }

}
