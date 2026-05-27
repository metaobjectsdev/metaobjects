/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

/**
 * Optional structural context attached to a loader error (T2 field per
 * ADR-0009 — RECOMMENDED, not conformance-enforced).
 *
 * <p>Mirrors {@code NodeContext} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}. FR5a does not
 * populate this field; FR5b–FR5e may.</p>
 *
 * @param type optional metadata type discriminant (e.g. {@code "field"}, {@code "object"})
 * @param subType optional metadata subtype (e.g. {@code "enum"}, {@code "entity"})
 * @param name optional node name (short form)
 * @param fqn optional fully qualified name (e.g. {@code "myapp::commerce::Program"})
 */
public record NodeContext(String type, String subType, String name, String fqn) {

    /** All-null context — useful as a placeholder when no node is in scope. */
    public static final NodeContext EMPTY = new NodeContext(null, null, null, null);
}
