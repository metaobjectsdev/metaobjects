/*
 * Copyright 2003-2012 Doug Mealing LLC dba Meta Objects
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
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v1.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v10.html
 */
package com.metaobjects.manager;

import com.metaobjects.MetaDataException;
import com.metaobjects.field.MetaField;

/**
 * Defines MetaObject implementations where the objects are aware of their state.
 * 
 * @author dmealing
 */
public interface StateAwareMetaObject {
    ///////////////////////////////////////////////////////////////
    // Object State Methods

    public boolean isNew(Object obj) throws MetaDataException;

    public boolean isModified(Object obj) throws MetaDataException;

    public boolean isDeleted(Object obj) throws MetaDataException;

    public void setNew(Object obj, boolean state) throws MetaDataException;

    public void setModified(Object obj, boolean state) throws MetaDataException;

    public void setDeleted(Object obj, boolean state) throws MetaDataException;

    public long getCreationTime(Object obj) throws MetaDataException;

    public long getModifiedTime(Object obj) throws MetaDataException;

    public long getDeletedTime(Object obj) throws MetaDataException;

    /**
     * Returns whether the field on the object was modified
     */
    public boolean isFieldModified(MetaField f, Object obj) throws MetaDataException;

    /**
     * Sets whether the field is modified
     */
    public void setFieldModified(MetaField f, Object obj, boolean state) throws MetaDataException;

    /**
     * Gets the time the field was modified
     */
    public long getFieldModifiedTime(MetaField f, Object obj) throws MetaDataException;
}
