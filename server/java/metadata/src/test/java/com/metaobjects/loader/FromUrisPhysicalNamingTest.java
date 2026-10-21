package com.metaobjects.loader;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.metaobjects.database.ColumnNaming;
import com.metaobjects.database.PhysicalNaming;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * ADR-0058 — {@link MetaDataLoader#fromUris} applies the {@code naming} of the
 * {@code .metaobjects/config.json} it finds walking up from the first {@code file:} URI,
 * warns once per loader when it finds none, and never overrides an explicit rule set after.
 */
public class FromUrisPhysicalNamingTest extends SharedRegistryTestBase {

    private static final String TINY = "{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}";
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();
    private final Logger logger = (Logger) LoggerFactory.getLogger(MetaDataLoader.class);

    @Before public void attach() {
        appender.start();
        logger.addAppender(appender);
        logger.setLevel(Level.WARN);
    }

    @After public void detach() {
        logger.detachAppender(appender);
    }

    private List<String> warnings() {
        return appender.list.stream()
            .filter(e -> e.getLevel() == Level.WARN && e.getFormattedMessage().contains("physical naming"))
            .map(ILoggingEvent::getFormattedMessage).collect(Collectors.toList());
    }

    private static Path project(String config, String... subdirs) throws IOException {
        Path root = Files.createTempDirectory("naming-proj-");
        if (config != null) {
            Files.createDirectories(root.resolve(".metaobjects"));
            Files.writeString(root.resolve(".metaobjects/config.json"), config);
        }
        Path dir = root;
        for (String s : subdirs) dir = dir.resolve(s);
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("meta.tiny.json"), TINY);
        return root;
    }

    private static URI first(Path root, String... subdirs) {
        Path dir = root;
        for (String s : subdirs) dir = dir.resolve(s);
        return dir.resolve("meta.tiny.json").toUri();
    }

    @Test public void findsConfigByWalkingUpFromTheFirstFileUri() throws IOException {
        Path root = project("{\"schema_version\":1,\"naming\":{\"columns\":\"literal\"}}", "metaobjects", "deep");
        MetaDataLoader loader = MetaDataLoader.fromUris("walkUp", List.of(first(root, "metaobjects", "deep")));
        assertEquals(ColumnNaming.LITERAL, loader.getRoot().getPhysicalNaming().columns());
        assertTrue(warnings().isEmpty());
    }

    @Test public void warnsOnceAndUsesSnakeCaseWhenNoConfigIsFound() throws IOException {
        Path root = project(null, "metaobjects");
        MetaDataLoader loader = MetaDataLoader.fromUris("noConfig", List.of(first(root, "metaobjects")));
        assertEquals(PhysicalNaming.DEFAULT.columns(), loader.getRoot().getPhysicalNaming().columns());
        List<String> w = warnings();
        assertEquals(1, w.size());
        assertTrue(w.get(0), w.get(0).contains("metaobjects.physical-naming-config"));
        assertTrue(w.get(0), w.get(0).contains("naming"));
    }

    @Test public void anExplicitRuleSetAfterTheLoadWins() throws IOException {
        Path root = project("{\"schema_version\":1,\"naming\":{\"columns\":\"literal\"}}", "m");
        MetaDataLoader loader = MetaDataLoader.fromUris("explicit", List.of(first(root, "m")));
        loader.getRoot().setPhysicalNaming(PhysicalNaming.of("kebab-case", "snake_case"));
        assertEquals(ColumnNaming.KEBAB_CASE, loader.getRoot().getPhysicalNaming().columns());
    }

    @Test public void aCallerSuppliedRuleSkipsDiscoveryAndTheWarning() throws IOException {
        Path root = project(null, "m");
        MetaDataLoader loader = MetaDataLoader.fromUris("supplied", List.of(first(root, "m")), null,
            PhysicalNaming.of("literal", "snake_case"));
        assertEquals(ColumnNaming.LITERAL, loader.getRoot().getPhysicalNaming().columns());
        assertTrue(warnings().isEmpty());
    }

    @Test public void fromDirectoryDiscoversNamingTheSameWay() throws IOException {
        Path root = project("{\"schema_version\":1,\"naming\":{\"columns\":\"literal\"}}", "metaobjects");
        MetaDataLoader loader = MetaDataLoader.fromDirectory("dirWalk", root.resolve("metaobjects"));
        assertEquals(ColumnNaming.LITERAL, loader.getRoot().getPhysicalNaming().columns());
        assertTrue(warnings().isEmpty());
    }

    @Test public void fromDirectoryWarnsOnceWhenNoConfigIsFound() throws IOException {
        Path root = project(null, "metaobjects");
        MetaDataLoader loader = MetaDataLoader.fromDirectory("dirNone", root.resolve("metaobjects"));
        assertEquals(PhysicalNaming.DEFAULT.columns(), loader.getRoot().getPhysicalNaming().columns());
        assertEquals(1, warnings().size());
    }
}
