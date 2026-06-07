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
