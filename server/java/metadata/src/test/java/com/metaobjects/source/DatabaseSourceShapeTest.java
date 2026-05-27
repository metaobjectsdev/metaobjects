/*
 * Copyright (c) 2026 Doug Mealing LLC. All Rights Reserved.
 *
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
