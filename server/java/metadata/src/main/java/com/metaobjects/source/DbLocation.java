/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

/**
 * Database location for a node sourced from a row (FR5e reserved slot).
 *
 * <p>Mirrors {@code DbLocation} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.</p>
 *
 * @param table table name (no schema prefix unless the row is in a non-default schema)
 * @param id identifier of the originating row (string-form regardless of underlying type)
 */
public record DbLocation(String table, String id) {
}
