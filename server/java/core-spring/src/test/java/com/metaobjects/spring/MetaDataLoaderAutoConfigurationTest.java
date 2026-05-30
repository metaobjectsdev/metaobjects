package com.metaobjects.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import org.junit.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Verifies the starter honors metaobjects.metadata-sources: the autoconfiguration
 * builds a MetaDataLoader from the property and exposes it through the registry,
 * with no app-supplied loader bean.
 */
public class MetaDataLoaderAutoConfigurationTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(MetaDataAutoConfiguration.class));

    @Test
    public void buildsLoaderFromMetadataSourcesProperty() {
        runner.withPropertyValues("metaobjects.metadata-sources=classpath:metadata/test-omdb-starter.json")
            .run(ctx -> {
                assertThat(ctx).hasSingleBean(MetaDataLoaderRegistry.class);
                assertThat(ctx).hasBean("primaryMetaDataLoader");
                MetaDataLoaderRegistry reg = ctx.getBean(MetaDataLoaderRegistry.class);
                assertThat(reg.getDataLoaders()).isNotEmpty();
                MetaDataLoader primary = ctx.getBean(MetaDataLoader.class);
                assertThat(primary).isNotNull();
            });
    }
}
