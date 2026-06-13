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
package com.metaobjects.object;

import com.metaobjects.object.value.ValueObject;

/**
 * object.projection — a derived, read-only representation of entities (FR-024,
 * ADR-0028): fields {@code extends}-bound to entity fields and/or origin-derived
 * and/or self-declared under external assembly; identity optional and borrowed via
 * {@code extends}; sources restricted to read-only kinds.
 *
 * <p>Loader-grammar slice only: registration + canonical serialization. The FR-024
 * validation passes (identity pass-through, read-only source kinds, via inference,
 * agreement/providability) land with Phase-E validation parity — see the
 * {@code _comment_fr024*} notes in {@code conformance-expected-failures.json}.</p>
 */
@SuppressWarnings("serial")
public class ProjectionMetaObject extends AbstractObjectRepresentation {
    public ProjectionMetaObject(String name) { super(MetaObject.SUBTYPE_PROJECTION, name); }
    protected ProjectionMetaObject(String subType, String name) { super(subType, name); }
    @Override protected Class<?> getDefaultObjectClass() { return ValueObject.class; }
}
