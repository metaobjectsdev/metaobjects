/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.source;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.net.URI;
import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * ERR_COLUMN_NAME_COLLISION advice wording and the {@code @sql} view exemption. Mirrors
 * {@code packages/metadata/test/column-name-collision-message.test.ts} in the TS reference port.
 */
public class ColumnNameCollisionMessageTest extends SharedRegistryTestBase {

    private static final String TABLE = "{ \"source.rdb\": { \"@kind\": \"table\", \"@table\": \"account\" } }";

    private static String doc(String source, String fieldA, String fieldB) {
        return "{ \"metadata.root\": { \"package\": \"demo\", \"children\": ["
            + " { \"object.entity\": { \"name\": \"Account\", \"children\": ["
            + source + ","
            + " { \"field.long\": { \"name\": \"id\" } },"
            + fieldA + "," + fieldB + ","
            + " { \"identity.primary\": { \"name\": \"id\", \"@fields\": [\"id\"] } }"
            + " ] } } ] } }";
    }

    private void load(String canonical, String id) {
        MetaDataLoader loader = createTestLoader("ColumnNameCollisionMessageTest",
            java.util.Collections.<URI>emptyList());
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
    }

    private String collisionMessage(String canonical, String id) {
        try {
            load(canonical, id);
        } catch (MetaDataException e) {
            assertTrue("expected ERR_COLUMN_NAME_COLLISION; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_COLUMN_NAME_COLLISION).isPresent());
            return e.getMessage();
        }
        fail("expected ERR_COLUMN_NAME_COLLISION");
        return null;
    }

    @Test
    public void twoExplicitColumnsOnOneColumnDoNotSuggestAddingAColumn() {
        String msg = collisionMessage(doc(TABLE,
            "{ \"field.string\": { \"name\": \"userName\", \"@column\": \"username\" } }",
            "{ \"field.string\": { \"name\": \"displayName\", \"@column\": \"username\" } }"), "explicit.json");
        assertTrue(msg, msg.contains("point one @column at a different column"));
        assertFalse(msg, msg.contains("give one an explicit @column"));
    }

    @Test
    public void implicitCollisionStillSuggestsAnExplicitColumn() {
        String msg = collisionMessage(doc(TABLE,
            "{ \"field.string\": { \"name\": \"userId\" } }",
            "{ \"field.string\": { \"name\": \"userID\" } }"), "implicit.json");
        assertTrue(msg, msg.contains("give one an explicit @column"));
    }

    @Test
    public void sqlViewMayShareAColumnBetweenFields() {
        load("""
            { "metadata.root": { "package": "demo", "children": [
              { "object.projection": { "name": "UserView", "children": [
                { "source.rdb": { "@kind": "view", "@view": "v", "@sql": "SELECT id, username FROM t" } },
                { "field.long": { "name": "id", "@column": "id" } },
                { "field.string": { "name": "userName", "@column": "username" } },
                { "field.string": { "name": "displayName", "@column": "username" } }
              ] } }
            ] } }
            """, "sqlview.json");
    }
}
