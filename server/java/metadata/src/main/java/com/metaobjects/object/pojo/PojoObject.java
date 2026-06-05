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
package com.metaobjects.object.pojo;

import com.metaobjects.ValueException;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.MetaObjectAware;
import com.metaobjects.object.Validatable;

/**
 * Base class for code-generated POJOs that carry their {@link MetaObject}
 * back-reference. The {@code pojoAware} codegen flavor emits concrete entity
 * classes that {@code extends PojoObject}, so the generated type is
 * {@link MetaObjectAware} (and {@link Validatable}) without re-emitting the
 * boilerplate per entity.
 *
 * <p>The MetaObject is supplied at construction. Unlike the legacy reference —
 * whose {@code setMetaData} self-assigned ({@code metaObject = metaObject}) and
 * held the field {@code final}, so the back-ref could never be set — the field
 * here is mutable and {@code setMetaData(...)} actually replaces it.</p>
 */
public abstract class PojoObject implements MetaObjectAware, Validatable {

    /** Not final: the back-ref must be replaceable via setMetaData (legacy held this final — a bug). */
    private MetaObject metaObject;

    protected PojoObject(MetaObject metaObject) {
        this.metaObject = metaObject;
    }

    @Override
    public MetaObject getMetaData() {
        return metaObject;
    }

    @Override
    public void setMetaData(MetaObject metaObject) {
        // Legacy did `metaObject = metaObject` (self-assignment, no-op) — fixed.
        this.metaObject = metaObject;
    }

    @Override
    public void validate() throws ValueException {
        // No-op by default (mirrors ValueObject/MappedObject). Generated subclasses
        // may override to enforce metadata-derived constraints.
    }
}
