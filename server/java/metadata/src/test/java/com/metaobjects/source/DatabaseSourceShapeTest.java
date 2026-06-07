/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
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
/*
 * FR5e — cross-port envelope shape lock for `format: "database"`. The schema
 * is reserved by ADR-0009 and instantiable in every port today; a real
 * database-source loader is future work. This test pins the shape so a
 * future loader (FR5e implementation) has a guaranteed-correct target.
 */
package com.metaobjects.source;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

public class DatabaseSourceShapeTest {

    @Test
    public void formatIsDatabase() {
        DatabaseSource src = new DatabaseSource(new DbLocation("metaobjects_field_attr", "fld_abc123/currency"));
        assertEquals("database", src.format());
    }

    @Test
    public void dbLocationCarriesTableAndId() {
        DbLocation loc = new DbLocation("metaobjects_object", "obj_42");
        assertEquals("metaobjects_object", loc.table());
        assertEquals("obj_42", loc.id());
    }

    @Test
    public void jsonPathIsOptional() {
        DatabaseSource noPath = new DatabaseSource(new DbLocation("t", "id"));
        assertNull(noPath.jsonPath());

        DatabaseSource withPath = new DatabaseSource(
            new DbLocation("metaobjects_field_attr", "fld_abc123/currency"),
            "$.metadata.root.children[0].field.currency.@currency");
        assertNotNull(withPath.jsonPath());
        assertEquals("$.metadata.root.children[0].field.currency.@currency", withPath.jsonPath());
    }

    @Test
    public void compositeKeyEncodedInIdString() {
        // FR5e design lock: composite primary keys are encoded as a single
        // delimited string in the id, e.g. "row_id/attr_name". This keeps the
        // envelope schema dialect-neutral and avoids a deeper DbLocation shape.
        DbLocation loc = new DbLocation("metaobjects_field_attr", "fld_abc123/currency");
        assertEquals("fld_abc123/currency", loc.id());
    }

    @Test
    public void rejectsNullDbLocation() {
        assertThrows(NullPointerException.class,
            () -> new DatabaseSource(null, null));
    }
}
