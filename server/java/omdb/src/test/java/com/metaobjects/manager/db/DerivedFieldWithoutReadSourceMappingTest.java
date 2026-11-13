package com.metaobjects.manager.db;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.db.defs.BaseTableDef;
import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.db.defs.TableDef;
import com.metaobjects.object.MetaObject;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * An entity may carry a derived ({@code origin.*}) field that only a projection reads, with no
 * read view of its own: the shared fixture {@code entity-derived-filter-gate}
 * ({@code Member.hasActiveAgreement}, an {@code origin.first} a projection's {@code @filter}
 * reaches). Its table, the one {@code meta migrate} creates, holds only {@code id}. So the table
 * mapping OMDB reads and writes {@code members} through must name no column for the derived field.
 */
public class DerivedFieldWithoutReadSourceMappingTest {

    private static Path fixtureInput() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/conformance/entity-derived-filter-gate/input");
            if (Files.isDirectory(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new AssertionError("fixtures/conformance/entity-derived-filter-gate not found");
    }

    private static List<String> columns(ObjectMappingDB mapping) {
        return ((BaseTableDef) mapping.getDBDef()).getColumns().stream()
            .map(ColumnDef::getName).collect(Collectors.toList());
    }

    @Test
    public void theTableMappingNamesNoColumnForTheDerivedField() {
        MetaDataLoader loader = MetaDataLoader.fromDirectory("entity-derived-filter-gate", fixtureInput());
        MetaObject member = null;
        for (MetaObject o : loader.getRoot().getChildren(MetaObject.class, false)) {
            if ("Member".equals(o.getShortName())) member = o;
        }
        SimpleMappingHandlerDB handler = new SimpleMappingHandlerDB();

        ObjectMappingDB read = (ObjectMappingDB) handler.getReadMapping(member);
        assertTrue(read.getDBDef() instanceof TableDef);
        assertEquals(List.of("id"), columns(read));
        assertEquals(List.of("id"), columns((ObjectMappingDB) handler.getCreateMapping(member)));
    }
}
