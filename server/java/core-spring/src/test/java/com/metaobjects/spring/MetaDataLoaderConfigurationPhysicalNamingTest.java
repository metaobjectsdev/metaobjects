package com.metaobjects.spring;

import com.metaobjects.database.PhysicalNaming;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * ADR-0058 — a runtime that loads metadata off the classpath has no project directory for
 * {@code SourceResolver.resolvePhysicalNaming(Path)} to resolve against, so
 * {@link MetaDataLoaderConfiguration} takes a Spring resource location naming the project's
 * {@code .metaobjects/config.json} FILE directly ({@code metaobjects.physical-naming-config}),
 * parses it with {@link com.metaobjects.config.NeutralConfig}, and sets the rules on the
 * loaded root — never a bare rule value.
 */
public class MetaDataLoaderConfigurationPhysicalNamingTest {

    // ConfigurationPropertiesAutoConfiguration must be explicit: ApplicationContextRunner's
    // AutoConfigurations.of(...) activates ONLY the listed classes, not Spring Boot's full
    // auto-configuration chain -- without it @ConfigurationProperties binding never runs
    // and every property silently reads as unset (metadataSources stays empty too, masked
    // in the sibling MetaDataLoaderAutoConfigurationTest by its classpath-discovery
    // fallback matching the same resource by coincidence).
    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(
            MetaDataAutoConfiguration.class, ConfigurationPropertiesAutoConfiguration.class));

    // metadataSources is left UNSET on both runs here (matches
    // MetaDataLoaderAutoConfigurationTest's classpath-discovery path,
    // discoverDefaultMetadataSources(), which resolves to proper `file:` URIs via Spring's
    // own Resource abstraction): explicitly naming `metaobjects.metadata-sources` as a bare
    // "classpath:" string hits a SEPARATE, pre-existing bug in this example bean -- the
    // property is handed straight to `URI.create(...)`, which has no "classpath:" scheme
    // handler, unlike `physicalNamingConfig` below, which this feature resolves through
    // Spring's `DefaultResourceLoader` correctly. That bug is orthogonal to ADR-0058 and
    // out of scope here.

    @Test
    public void physicalNamingConfigPropertySetsTheRootsRules() {
        runner.withPropertyValues("metaobjects.physical-naming-config=classpath:naming-config/config.json")
            .run(ctx -> {
                MetaDataLoader primary = ctx.getBean(MetaDataLoader.class);
                assertThat(primary.getRoot().getPhysicalNaming().columns())
                    .isEqualTo(PhysicalNaming.of("literal", "snake_case").columns());
            });
    }

    @Test
    public void withNoPhysicalNamingConfigPropertyTheRootKeepsTheDefault() {
        runner.run(ctx -> {
            MetaDataLoader primary = ctx.getBean(MetaDataLoader.class);
            assertThat(primary.getRoot().getPhysicalNaming().columns())
                .isEqualTo(PhysicalNaming.DEFAULT.columns());
        });
    }
}
