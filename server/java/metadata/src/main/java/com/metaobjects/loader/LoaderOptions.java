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
    private long initTimeoutMs = defaultInitTimeoutMs();

    /** How long {@code init()} waits for the load when nothing sets it: 30 seconds. */
    public static final long DEFAULT_INIT_TIMEOUT_MS = 30_000L;

    /**
     * The JVM system property that changes the default for every loader in the process, for an
     * embedder that builds its loaders where no option reaches (a Spring context, a test runner):
     * {@code -Dmetaobjects.loader.initTimeoutMs=120000}.
     */
    public static final String INIT_TIMEOUT_PROPERTY = "metaobjects.loader.initTimeoutMs";

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
     * How long {@link MetaDataLoader#init()} waits for the load to finish, in milliseconds,
     * before it fails with a timeout. The default is {@link #DEFAULT_INIT_TIMEOUT_MS} unless the
     * {@link #INIT_TIMEOUT_PROPERTY} system property says otherwise. The load time grows with
     * the model, and a busy build machine stretches it, so a very large model may need more.
     *
     * @param initTimeoutMs a positive number of milliseconds
     */
    public <T extends LoaderOptions> T setInitTimeoutMs(long initTimeoutMs) {
        if (initTimeoutMs <= 0) {
            throw new IllegalArgumentException("initTimeoutMs must be a positive number of milliseconds, got " + initTimeoutMs);
        }
        this.initTimeoutMs = initTimeoutMs;
        return (T) this;
    }

    public long getInitTimeoutMs() {
        return initTimeoutMs;
    }

    /** {@link #DEFAULT_INIT_TIMEOUT_MS}, or the {@link #INIT_TIMEOUT_PROPERTY} system property when set. */
    static long defaultInitTimeoutMs() {
        String raw = System.getProperty(INIT_TIMEOUT_PROPERTY);
        if (raw == null || raw.isBlank()) return DEFAULT_INIT_TIMEOUT_MS;
        try {
            long value = Long.parseLong(raw.trim());
            if (value > 0) return value;
        } catch (NumberFormatException ignored) {
            // fall through to the refusal below
        }
        throw new IllegalArgumentException("-D" + INIT_TIMEOUT_PROPERTY + " must be a positive number of milliseconds, got \"" + raw + "\"");
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
                initTimeoutMs == that.initTimeoutMs &&
                providers.equals(that.providers);
    }

    @Override
    public int hashCode() {
        return Objects.hash(shouldRegister, verbose);
    }

    protected String getToStringOptions() {
        return "shouldRegister=" + shouldRegister +
                ", verbose=" + verbose +
                ", strict=" + strict +
                ", initTimeoutMs=" + initTimeoutMs;
    }

    @Override
    public String toString() {
        return getClass().getSimpleName() +
                "{" + getToStringOptions() + '}';
    }
}
