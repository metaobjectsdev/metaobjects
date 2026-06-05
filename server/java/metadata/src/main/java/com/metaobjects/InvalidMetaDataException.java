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

package com.metaobjects;

import com.metaobjects.util.MetaDataUtil;

public class InvalidMetaDataException extends MetaDataException {

    public InvalidMetaDataException( MetaData md, String msg) {
        super(prefix(md)+msg);
    }
    public InvalidMetaDataException( MetaData md, String msg, Throwable cause) {
        super(prefix(md)+msg, cause);
    }

    protected static String prefix( MetaData md ) {
        if ( md == null ) return "[null] ";
        String pkg = md.getPackage();
        if (pkg.isEmpty() && !(md instanceof MetaRoot)) pkg = MetaDataUtil.findPackageForMetaData(md);
        if (!pkg.isEmpty()) pkg+=MetaData.PKG_SEPARATOR;
        return "["+md.getClass().getSimpleName()+":"+pkg+md.getShortName()+"] ";
    }
}
