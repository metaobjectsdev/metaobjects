package com.metaobjects.spring;

import com.metaobjects.config.NeutralConfig;
import com.metaobjects.database.PhysicalNaming;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.core.io.DefaultResourceLoader;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Example Spring configuration showing how to set up MetaDataLoaders as beans.
 * 
 * <p>Spring Boot applications can use this pattern to automatically configure
 * MetaDataLoaders that will be discovered and registered by {@link MetaDataAutoConfiguration}.</p>
 * 
 * <p><strong>application.yml Example:</strong></p>
 * <pre>{@code
 * metaobjects:
 *   metadata-sources:
 *     - "classpath:metadata/core-metadata.json"
 *     - "classpath:metadata/user-metadata.json"
 *     - "file:/path/to/external-metadata.xml"
 *   auto-attrs: true
 *   strict: false
 *   # ADR-0058 — this classpath runtime has no project directory, so give it the
 *   # project's .metaobjects/config.json directly (a FILE location, never a bare rule).
 *   physical-naming-config: "classpath:.metaobjects/config.json"
 * }</pre>
 * 
 * <p><strong>Or use @Bean methods directly:</strong></p>
 * <pre>{@code
 * @Configuration
 * public class MyMetaDataConfig {
 *
 *     @Bean
 *     public MetaDataLoader userMetaDataLoader() {
 *         return MetaDataLoader.fromUris("userLoader", List.of(
 *             URI.create("classpath:metadata/users.json")
 *         ));
 *     }
 * }
 * }</pre>
 * 
 * @since 6.0.0
 */
@Configuration
@ConfigurationProperties(prefix = "metaobjects")
public class MetaDataLoaderConfiguration {
    
    private List<String> metadataSources = new ArrayList<>();
    private boolean autoAttrs = true;
    private boolean strict = false;
    private boolean verbose = false;

    /**
     * ADR-0058 — where to read the project's physical-naming rules from, for a runtime
     * that loads metadata off the classpath and so has no project directory for
     * {@code SourceResolver.resolvePhysicalNaming(Path)} to resolve against. A Spring
     * resource location pointing at the {@code .metaobjects/config.json} FILE itself
     * (never a directory) — e.g. {@code classpath:.metaobjects/config.json} or
     * {@code file:/opt/app/.metaobjects/config.json}. Parsed with {@link NeutralConfig};
     * never a bare rule value ({@code naming.columns}/{@code naming.tables}) configured
     * here directly — ADR-0058 removed every such setter. Accepts a Spring location
     * ({@code classpath:}, {@code file:}) or a plain file path. Absent means
     * {@code classpath:.metaobjects/config.json} when that resource exists, else the
     * default ({@code snake_case}/{@code snake_case}) with one WARN.
     */
    private String physicalNamingConfig;

    /**
     * Creates MetaDataLoader from application properties.
     *
     * <p>This bean will be automatically discovered and registered by
     * {@link MetaDataAutoConfiguration}.</p>
     */
    @Bean
    @ConditionalOnMissingBean(MetaDataLoader.class)
    public MetaDataLoader applicationMetaDataLoader() throws Exception {
        if (metadataSources.isEmpty()) {
            // Default: look for metadata files in classpath
            metadataSources = discoverDefaultMetadataSources();
        }

        if (metadataSources.isEmpty()) {
            // No metadata sources configured - return null so it's optional
            return null;
        }

        // Convert string sources to URIs
        List<URI> sourceURIs = new ArrayList<>();
        for (String source : metadataSources) {
            sourceURIs.add(URI.create(source));
        }

        // Build a loader via the unified factory (init + load + register in one call).
        // Preserve the pre-unification strict=true default (the no-options
        // fromUris overload routes through createManual which uses strict=false).
        LoaderOptions opts = LoaderOptions.create(false, false, true);
        // ADR-0058: the naming is resolved BEFORE the load call so the loader's own
        // "no config found" WARN fires only when neither this property, the default
        // classpath:.metaobjects/config.json, nor the file: walk found a project config.
        return MetaDataLoader.fromUris("applicationLoader", sourceURIs, opts, resolvePhysicalNaming());
    }

    /** The default location read when {@code metaobjects.physical-naming-config} is unset. */
    static final String DEFAULT_PHYSICAL_NAMING_CONFIG = "classpath:.metaobjects/config.json";

    /**
     * ADR-0058 — the project's physical-naming rules from {@link #physicalNamingConfig}
     * (a {@code classpath:}/{@code file:}/URL location, or a plain file path), else from
     * {@value #DEFAULT_PHYSICAL_NAMING_CONFIG} when that resource exists, else {@code null}
     * (the loader then walks up from a {@code file:} source and warns once if it finds
     * nothing). A configured location that does not exist is an error, never a silent default.
     */
    private PhysicalNaming resolvePhysicalNaming() throws IOException {
        String location = physicalNamingConfig;
        boolean explicit = location != null && !location.isBlank();
        if (!explicit) location = DEFAULT_PHYSICAL_NAMING_CONFIG;
        Resource resource = locate(location.trim());
        if (!resource.exists()) {
            if (explicit) {
                throw new IllegalStateException("metaobjects.physical-naming-config points at "
                    + location + ", which does not exist");
            }
            return null;
        }
        String content;
        try (InputStream in = resource.getInputStream()) {
            content = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        return NeutralConfig.parse(content, location).getPhysicalNaming();
    }

    /** A Spring location when it has a scheme, otherwise a file-system path. */
    private static Resource locate(String location) {
        DefaultResourceLoader loader = new DefaultResourceLoader();
        if (location.startsWith("classpath:") || location.matches("^[A-Za-z][A-Za-z0-9+.-]+:.*")) {
            return loader.getResource(location);
        }
        return new FileSystemResource(location);
    }

    /**
     * Example: Database metadata loader bean
     * 
     * This shows how to create specialized loaders for different data sources.
     */
    // @Bean
    // public MetaDataLoader databaseMetaDataLoader(DataSource dataSource) {
    //     DatabaseMetaDataLoader loader = new DatabaseMetaDataLoader("dbLoader", dataSource);
    //     loader.init();
    //     return loader;
    // }
    
    /**
     * Example: External file system loader
     */
    // @Bean
    // @ConditionalOnProperty("metaobjects.external-path")
    // public MetaDataLoader externalMetaDataLoader(@Value("${metaobjects.external-path}") String path) {
    //     return MetaDataLoader.fromUris("externalLoader", List.of(URI.create("file:" + path)));
    // }
    
    /**
     * Discover default metadata sources from classpath
     */
    private List<String> discoverDefaultMetadataSources() {
        List<String> sources = new ArrayList<>();
        PathMatchingResourcePatternResolver resolver = new PathMatchingResourcePatternResolver();
        
        try {
            // Look for common metadata file patterns
            String[] patterns = {
                "classpath*:metadata/*.json",
                "classpath*:metadata/*.xml", 
                "classpath*:META-INF/metadata/*.json",
                "classpath*:META-INF/metadata/*.xml"
            };
            
            for (String pattern : patterns) {
                Resource[] resources = resolver.getResources(pattern);
                for (Resource resource : resources) {
                    sources.add(resource.getURI().toString());
                }
            }
        } catch (Exception e) {
            // Ignore discovery errors - sources will be empty
        }
        
        return sources;
    }
    
    // Property setters for Spring Boot configuration binding
    public List<String> getMetadataSources() { return metadataSources; }
    public void setMetadataSources(List<String> metadataSources) { this.metadataSources = metadataSources; }
    
    public boolean isAutoAttrs() { return autoAttrs; }
    public void setAutoAttrs(boolean autoAttrs) { this.autoAttrs = autoAttrs; }
    
    public boolean isStrict() { return strict; }
    public void setStrict(boolean strict) { this.strict = strict; }
    
    public boolean isVerbose() { return verbose; }
    public void setVerbose(boolean verbose) { this.verbose = verbose; }

    public String getPhysicalNamingConfig() { return physicalNamingConfig; }
    public void setPhysicalNamingConfig(String physicalNamingConfig) { this.physicalNamingConfig = physicalNamingConfig; }
}