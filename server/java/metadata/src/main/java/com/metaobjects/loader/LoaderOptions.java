package com.metaobjects.loader;

import com.metaobjects.registry.MetaDataTypeProvider;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Objects;


/**
 * MetaDataLoader configuration settings — toggle behavior flags that apply
 * across all loader sources (file, URI, directory, in-memory).
 */
public class LoaderOptions {

    private boolean shouldRegister = false;
    private boolean verbose = true;
    private boolean strict = true;

    /** Extra vocabulary providers composed into the loader's registry; empty = the shared default. */
    private List<MetaDataTypeProvider> providers = List.of();

    public LoaderOptions() {}

    public static LoaderOptions create(boolean shouldRegister, boolean verbose, boolean strict ) {
        LoaderOptions config = new LoaderOptions()
                .setShouldRegister( shouldRegister )
                .setVerbose( verbose)
                .setStrict( strict);
        return config;
    }

    ///////////////////////////////////////////////////////////////////////////
    // Flags

    public <T extends LoaderOptions> T setShouldRegister(boolean shouldRegister ) {
        this.shouldRegister = shouldRegister;
        return (T) this;
    }

    public boolean shouldRegister() {
        return shouldRegister;
    }

    public <T extends LoaderOptions>T setVerbose(boolean verbose) {
        this.verbose = verbose;
        return (T) this;
    }

    public boolean isVerbose() {
        return verbose;
    }

    public <T extends LoaderOptions>T setStrict(boolean strict) {
        this.strict = strict;
        return (T) this;
    }

    public boolean isStrict() {
        return strict;
    }

    /**
     * A project's own vocabulary: the loader composes
     * {@link com.metaobjects.registry.RegistryManifest#composeLoaderRegistry(Collection)} with these
     * providers appended after the metamodel set, instead of using the shared default registry.
     * Empty (the default) leaves loading byte-identical to a loader given no providers.
     */
    public LoaderOptions setProviders(Collection<? extends MetaDataTypeProvider> providers) {
        this.providers = providers == null ? List.of() : List.copyOf(new ArrayList<>(providers));
        return this;
    }

    /** The extra providers (never null, unmodifiable). */
    public List<MetaDataTypeProvider> getProviders() {
        return providers;
    }

    ///////////////////////////////////////////////////////////////////////////
    // Misc Functions

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        LoaderOptions that = (LoaderOptions) o;
        return shouldRegister == that.shouldRegister &&
                verbose == that.verbose &&
                strict == that.strict &&
                providers.equals(that.providers);
    }

    @Override
    public int hashCode() {
        return Objects.hash(shouldRegister, verbose);
    }

    protected String getToStringOptions() {
        return "shouldRegister=" + shouldRegister +
                ", verbose=" + verbose +
                ", strict=" + strict;
    }

    @Override
    public String toString() {
        return getClass().getSimpleName() +
                "{" + getToStringOptions() + '}';
    }
}
