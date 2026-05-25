package com.metaobjects.loader.file;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.registry.CoreTypeInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;

/**
 * Meta Class loader for Files
 */
public class FileMetaDataLoader extends MetaDataLoader {

    private static final Logger log = LoggerFactory.getLogger(FileMetaDataLoader.class);

    public final static String SUBTYPE_FILE = "file";

    // File extension constants
    public static final String XML_EXTENSION = "*.xml";
    public static final String JSON_EXTENSION = "*.json";

    // H3a Task 4: MetaDataLoader is no longer a MetaData node, so the loader is
    // not registered as a registry type. The metadata.root type (MetaRoot) is
    // the tree root and carries the child-acceptance rules.

    public FileMetaDataLoader(String name) {
        this( new FileLoaderOptions(), name );
    }

    public FileMetaDataLoader(FileLoaderOptions fileConfig, String name ) {
        super( fileConfig, SUBTYPE_FILE, name );
    }

    /** Initialize with the metadata source being set */
    public FileMetaDataLoader init( FileMetaDataSources sources ) {
        getLoaderOptions().addSources( sources );
        return init();
    }

    public FileLoaderOptions getLoaderOptions() {
        return (FileLoaderOptions) super.getLoaderOptions();
    }

    @Override
    public FileMetaDataLoader setMetaDataClassLoader(ClassLoader classLoader ) {
        return super.setMetaDataClassLoader(classLoader);
    }

    @Override
    protected ClassLoader getDefaultMetaDataClassLoader() {
        if ( log.isWarnEnabled() && !getName().toLowerCase().contains("test"))
            log.warn("A MetaDataClassLoader should have been set on loader: " + toString() );
        return super.getDefaultMetaDataClassLoader();
    }

    ////////////////////////////////////////////////////////////////////////////////////////////
    // MOJO Support Methods

    @Override
    protected void processSources(String sourceDir, List<String> rawSources) {
        if (rawSources == null) throw new IllegalArgumentException(
                "sourceURIList was null on setURIList for Loader: " + toString());

        List<String> localSourceList = new ArrayList<>();
        List<URI> uriSourceList = new ArrayList<>();

        // See if the raw input is a URI or not and add to appropriate list
        for (String raw : rawSources) {
            if (raw.indexOf(":") > 0) uriSourceList.add(URIHelper.toURI(raw));
            else localSourceList.add(raw);
        }

        // Set URI Sources
        if (!uriSourceList.isEmpty()) {
            URIFileMetaDataSources uriSources = new URIFileMetaDataSources(uriSourceList);
            getLoaderOptions().addSources(uriSources);
            uriSources.setLoaderClassLoader(getMetaDataClassLoader());
        }

        // Set Local Sources
        if (!localSourceList.isEmpty()) {
            LocalFileMetaDataSources localSources = null;
            if (sourceDir != null) localSources = new LocalFileMetaDataSources(sourceDir, localSourceList);
            else localSources = new LocalFileMetaDataSources(localSourceList);
            getLoaderOptions().addSources(localSources);
            localSources.setLoaderClassLoader(getMetaDataClassLoader());
        }
    }

    @Override
    public void configure(LoaderConfiguration config) {
        // Process configuration arguments first
        processArguments(config.getArguments());

        // Call parent to handle the rest of the configuration
        super.configure(config);
    }

    ////////////////////////////////////////////////////////////////////////////////////////////
    // Initialization Methods

    /** Initialize the MetaDataLoader */
    @Override
    public FileMetaDataLoader init() {

        if ( !getLoaderOptions().hasSources() ) {
            throw new IllegalStateException( "No Metadata Sources were defined [" + this + "]" );
        }

        // Ensure all core types are loaded and registered
        CoreTypeInitializer.initializeCoreTypes();

        super.init();

        loadSourceFiles();

        return this;
    }

    /**
     * Run file discovery, then hand the discovered files to the shared
     * {@link MetaDataLoader#load(List)} pipeline.
     *
     * <p>As of H3a Task 4 the file loader no longer carries its own direct-parser
     * branch. Discovery (directory scanning, {@code .bundle}-file expansion, and
     * the ClassLoader-chain resolution) still lives in {@link FileMetaDataSources}
     * and its subclasses — but the <em>output</em> of discovery is now a flat list
     * of {@link MetaDataSource}s ({@link FileMetaDataSources.SourceData} implements
     * it), which feeds straight into the inherited source pipeline. {@code .bundle}
     * files are expanded during discovery and never surface as their own source.</p>
     */
    protected void loadSourceFiles() {

        // Discovery already happened (FileMetaDataSources.read(...) during
        // construction / processSources). Collect the resolved files as
        // MetaDataSources — bundles are expanded into their member files here.
        List<MetaDataSource> sources = new ArrayList<>();
        for (FileMetaDataSources s : (List<FileMetaDataSources>) getLoaderOptions().getSources()) {
            for (FileMetaDataSources.SourceData d : s.getSourceData()) {
                if (log.isDebugEnabled()) log.debug("LOADING: " + d.filename);
                sources.add(d);
            }
        }

        // Parse via the shared source pipeline (JSON/XML routing by format).
        load(sources);

        if ( getLoaderOptions().isVerbose() ) {
            log.info( "METADATA - ("+sources.size()+") Source Files Loaded in " +toString() );
        }
    }

    /**
     * Lookup the specified class by name, include the classloaders provided by the metadata sources
     * NOTE:  This was done to handle OSGi and other complex ClassLoader scenarios
     */
    @Override
    public Class<?> loadClass( String className ) throws ClassNotFoundException {

        for (FileMetaDataSources s : (List<FileMetaDataSources>) getLoaderOptions().getSources() ) {
            try {
                return s.getClass().getClassLoader().loadClass(className);
            } catch( ClassNotFoundException ignore ) {}
        }

        // Use the default class loader
        return super.loadClass( className );
    }
}
