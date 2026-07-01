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
package com.metaobjects.index;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Index Types MetaData provider.
 *
 * <p>Registers the {@code index.lookup} type: a non-unique database index that
 * carries the cross-port logical {@code @fields} attr. The RDB-physical attrs
 * ({@code @orders} / {@code @expr} / {@code @where} / {@code @using}) are
 * contributed by {@link com.metaobjects.database.CoreDBMetaDataProvider} via
 * {@code extendType}, mirroring the TS db provider's {@code extends} block.</p>
 *
 * <p>Depends on {@code core-types} for {@code metadata.base} inheritance.</p>
 */
public class IndexTypesMetaDataProvider implements MetaDataTypeProvider {

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        LookupIndex.registerTypes(registry);
    }

    @Override
    public String getProviderId() {
        return "index-types";
    }

    @Override
    public String[] getDependencies() {
        return new String[]{"core-types"};
    }

    @Override
    public String getDescription() {
        return "Index Types (lookup) — non-unique query-performance indexes";
    }
}
