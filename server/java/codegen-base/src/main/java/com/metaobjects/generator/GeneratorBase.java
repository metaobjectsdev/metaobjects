package com.metaobjects.generator;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.metaobjects.MetaData;
import com.metaobjects.generator.util.GeneratorUtil;

import java.io.File;
import java.util.*;

/**
 * Base implementation for all metadata generators.
 * 
 * <p>Provides common functionality for code/configuration generators including
 * argument handling, filtering, and output management. Subclasses implement
 * specific generation logic for different output formats and targets.</p>
 * 
 * <p>Core features:</p>
 * <ul>
 *   <li>Argument parsing and validation</li>
 *   <li>Metadata filtering and selection</li>
 *   <li>Output directory and file management</li>
 *   <li>Script execution support</li>
 * </ul>
 * 
 * @author Doug Mealing  
 * @since 4.4.0
 */
public abstract class GeneratorBase implements Generator {

    private static final Logger log = LoggerFactory.getLogger(GeneratorBase.class);

    public static String ARG_OUTPUTDIR       = "outputDir";
    public static String ARG_OUTPUTFILENAME  = "outputFilename";

    private Map<String,String> args = new HashMap<>();
    private MetaDataFilters filters = new MetaDataFilters();
    private List<String> scripts = new ArrayList<>();
    private Set<String> entities = Set.of();

    @Override
    public GeneratorBase setArgs(Map<String, String> argMap) {
        if (argMap != null) {
            args.putAll( argMap );
        }
        return this;
    }

    protected Map<String,String> getArgs() {
        return args;
    }

    protected String getArg( String name ) {
        if (name == null) {
            return null;
        }
        return args.get( name );
    }
    protected String getArg( String name, String defValue ) {
        if ( !hasArg( name )) {
            return defValue;
        }
        return getArg( name );
    }

    protected String getArg( String name, boolean required ) {
        if ( !hasArg( name )) {
            throw new GeneratorException( "No argument '"+name+"' was specified in the args map" );
        }
        return getArg( name );
    }

    protected boolean hasArg( String name ) {
        return name != null && args.containsKey( name );
    }

    @Override
    public GeneratorBase setFilters(List<String> filters) {
        this.filters.addFilters( filters );
        return this;
    }

    protected MetaDataFilters getMetaDataFilters() {
        return filters;
    }

    protected List<String> getFilters() {
        return filters.getFilters();
    }

    /**
     * The run's entity selection: short object names ({@code Program}, not
     * {@code fitness::Program}), as {@code meta gen Program} takes them in TypeScript and
     * {@code --entities} in Python and C#. Empty, the default, selects every object. Set by
     * the Maven plugin from {@code <entities>} / {@code -Dmeta.entities}.
     *
     * <p>Unlike {@code <filters>}, which an adopter configures per generator to decide what it
     * covers, this is a choice about one run: regenerate these objects' files and leave the
     * rest alone. So it narrows per-object output only. A file built from the whole model (a
     * registry, a shared support class, a validator listing every table) still renders from
     * the whole model, or a narrowed run would rewrite it without the other objects.</p>
     */
    public GeneratorBase setEntities(List<String> entities) {
        this.entities = entities == null ? Set.of() : Set.copyOf(entities);
        return this;
    }

    public Set<String> getEntities() {
        return entities;
    }

    /**
     * True when {@code md} passes this generator's {@code <filters>}. A loop that builds one
     * whole-model file from a list of objects asks this; a per-object loop asks
     * {@link #isSelected}.
     */
    protected boolean passesFilters(MetaData md) {
        return GeneratorUtil.passesFilters(md, filters);
    }

    /**
     * True when this generator should write {@code md}'s own files this run: it passes the
     * generator's {@code <filters>} and the run's entity selection ({@link #setEntities}).
     * Every per-object loop asks this of the object it is about to emit.
     */
    protected boolean isSelected(MetaData md) {
        return passesFilters(md) && inEntitySelection(md);
    }

    /** True when the run selects no entities, or selects {@code md} by its short name. */
    protected boolean inEntitySelection(MetaData md) {
        return entities.isEmpty() || entities.contains(md.getShortName());
    }

    @Override
    public GeneratorBase setScripts(List<String> scripts) {
        this.scripts = scripts;
        return this;
    }

    protected List<String> getScripts() {
        return scripts;
    }

    protected String getOutputFilename() {
        return getArg(ARG_OUTPUTFILENAME, true );
    }

    protected File getOutputDir() {
        return getAndCreateDir( ARG_OUTPUTDIR, getArg(ARG_OUTPUTDIR, true ));
    }

    protected File getAndCreateDir( String name, String dirPath ) {

        File f = new File( dirPath );
        if (!f.exists()) {
            if ( !f.mkdirs() ) {
                throw new GeneratorException( "Directory ["+dirPath+"] could not be created for argument [" +name+ "]" );
            }
        }

        return f;
    }

    //////////////////////////////////////////////////////////////////////
    // Misc methods

    @Override
    public String toString() {
        final StringBuilder sb = new StringBuilder(this.getClass().getSimpleName()+"{");
        sb.append("args=").append(getArgs());
        sb.append(", filters=").append(getFilters());
        sb.append(", scripts=").append(getScripts());
        if (!entities.isEmpty()) sb.append(", entities=").append(new TreeSet<>(entities));
        sb.append('}');
        return sb.toString();
    }
}
