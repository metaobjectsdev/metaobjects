package com.metaobjects.generator;

import com.metaobjects.loader.MetaDataLoader;

import java.util.List;
import java.util.Map;

public interface Generator {

    public Generator setArgs( Map<String,String> args );
    public Generator setFilters( List<String> filters );
    public Generator setScripts( List<String> scripts );

    public void execute( MetaDataLoader loader );

    /**
     * Whether a run that includes this generator may be skipped when none of its inputs changed
     * (ADR-0062). Return {@code false} when the output depends on anything the build cannot
     * name: an environment variable, the network, a file lookup relative to the working
     * directory. A run that includes such a generator always runs in full.
     */
    default boolean cacheable() {
        return true;
    }

    /**
     * Files and directories, besides the metadata and the generator's own class, whose content
     * this generator reads (template roots, lookup tables). Their content is hashed into the
     * run's fingerprint, so editing one makes the next run regenerate. A relative path is
     * relative to the module basedir; a directory counts every file under it.
     */
    default List<String> extraInputs() {
        return List.of();
    }
}
