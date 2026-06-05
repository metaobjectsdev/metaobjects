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
package com.metaobjects.object;

import java.util.List;

/**
 * Test-only bound POJO for the object-model-conformance "bound-type" scenario
 * (scenario 6). Stands in for a port-local concrete type registered against the
 * FQN {@code com::example::om::Person} in the {@link com.metaobjects.registry.ObjectClassRegistry}.
 *
 * <p>Implements {@link MetaObjectAware} so {@code MetaObject.newInstance()} attaches
 * the Person {@link MetaObject} back-reference after construction (the no-arg ctor
 * path in {@code MetaObject.newInstance()}). Field shape mirrors the corpus Person:
 * {@code name:String}, {@code age:Integer}, {@code home:Object}, {@code tags:List}.</p>
 *
 * <p>Field access goes through plain getters/setters; the
 * {@code ValueMetaObject} value-access layer reads/writes these via the
 * reflection/map hybrid, so scalar/nested/array round-trips behave identically
 * to a {@code ValueObject}.</p>
 */
public class PersonPojoFixture implements MetaObjectAware {

    private MetaObject metaData;

    private String name;
    private Integer age;
    private Object home;
    private List<?> tags;

    public PersonPojoFixture() {
        // no-arg ctor — MetaObject.newInstance() attaches the back-ref via attachMetaObject()
    }

    @Override
    public MetaObject getMetaData() {
        return metaData;
    }

    @Override
    public void setMetaData(MetaObject metaObject) {
        this.metaData = metaObject;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public Integer getAge() {
        return age;
    }

    public void setAge(Integer age) {
        this.age = age;
    }

    public Object getHome() {
        return home;
    }

    public void setHome(Object home) {
        this.home = home;
    }

    public List<?> getTags() {
        return tags;
    }

    public void setTags(List<?> tags) {
        this.tags = tags;
    }
}
