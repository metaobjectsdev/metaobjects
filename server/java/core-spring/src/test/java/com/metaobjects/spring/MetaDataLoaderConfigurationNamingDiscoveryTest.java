package com.metaobjects.spring;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * ADR-0058 / B1 — the Spring runtime finds the project's {@code naming} the way codegen
 * does: the property takes a classpath location or a file path, an unset property defaults to
 * {@code classpath:.metaobjects/config.json}, and one WARN is logged when nothing is found.
 */
public class MetaDataLoaderConfigurationNamingDiscoveryTest {

    private static final String LITERAL = "{\"schema_version\":1,\"naming\":{\"columns\":\"literal\"}}";

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(
            MetaDataAutoConfiguration.class, ConfigurationPropertiesAutoConfiguration.class));
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();
    private final Logger logger = (Logger) LoggerFactory.getLogger(com.metaobjects.loader.MetaDataLoader.class);
    private ClassLoader originalLoader;

    @Before public void attach() {
        appender.start();
        logger.addAppender(appender);
        logger.setLevel(Level.WARN);
        originalLoader = Thread.currentThread().getContextClassLoader();
    }

    @After public void detach() {
        logger.detachAppender(appender);
        Thread.currentThread().setContextClassLoader(originalLoader);
    }

    private long namingWarnings() {
        return appender.list.stream()
            .filter(e -> e.getLevel() == Level.WARN && e.getFormattedMessage().contains("physical naming"))
            .count();
    }

    private static Path projectWithConfig() throws Exception {
        Path root = Files.createTempDirectory("spring-naming-");
        Files.createDirectories(root.resolve(".metaobjects"));
        Files.writeString(root.resolve(".metaobjects/config.json"), LITERAL);
        return root;
    }

    @Test public void unsetPropertyDefaultsToTheClasspathProjectConfig() throws Exception {
        Path root = projectWithConfig();
        Thread.currentThread().setContextClassLoader(
            new URLClassLoader(new URL[] {root.toUri().toURL()}, originalLoader));
        runner.run(ctx -> assertThat(ctx.getBean(MetaDataLoader.class).getRoot().getPhysicalNaming().columns())
            .isEqualTo("literal"));
        assertThat(namingWarnings()).isZero();
    }

    @Test public void propertyAcceptsAPlainFilePath() throws Exception {
        Path root = projectWithConfig();
        runner.withPropertyValues("metaobjects.physical-naming-config=" + root.resolve(".metaobjects/config.json"))
            .run(ctx -> assertThat(ctx.getBean(MetaDataLoader.class).getRoot().getPhysicalNaming().columns())
                .isEqualTo("literal"));
        assertThat(namingWarnings()).isZero();
    }

    @Test public void propertyAcceptsAClasspathLocation() {
        runner.withPropertyValues("metaobjects.physical-naming-config=classpath:naming-config/config.json")
            .run(ctx -> assertThat(ctx.getBean(MetaDataLoader.class).getRoot().getPhysicalNaming().columns())
                .isEqualTo("literal"));
        assertThat(namingWarnings()).isZero();
    }

    @Test public void warnsOnceWhenNoProjectConfigIsFound() {
        runner.run(ctx -> assertThat(ctx.getBean(MetaDataLoader.class).getRoot().getPhysicalNaming().columns())
            .isEqualTo("snake_case"));
        assertThat(namingWarnings()).isEqualTo(1);
    }

    @Test public void aMissingConfiguredLocationIsAnErrorNotADefault() {
        runner.withPropertyValues("metaobjects.physical-naming-config=/nonexistent/.metaobjects/config.json")
            .run(ctx -> assertThat(ctx.getStartupFailure()).isNotNull());
    }

    @Test public void anExplicitRuleSetOnTheRootStillWins() {
        runner.withPropertyValues("metaobjects.physical-naming-config=classpath:naming-config/config.json")
            .run(ctx -> {
                MetaDataLoader l = ctx.getBean(MetaDataLoader.class);
                l.getRoot().setPhysicalNaming(com.metaobjects.database.PhysicalNaming.of("kebab-case", "snake_case"));
                assertThat(l.getRoot().getPhysicalNaming().columns()).isEqualTo("kebab-case");
            });
    }
}
