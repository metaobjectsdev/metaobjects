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
package com.metaobjects.mojo;

import com.metaobjects.loader.LoaderConfigurable;
import com.metaobjects.loader.LoaderConfigurationBuilder;

import java.util.List;
import java.util.Map;

/**
 * Maven-specific implementation of LoaderConfiguration.
 * This bridges Maven Mojo configuration to the generic LoaderConfigurable interface.
 */
public class MavenLoaderConfiguration {
    
    /**
     * Configure a LoaderConfigurable instance using Maven-specific configuration
     * 
     * @param configurable The loader to configure
     * @param sourceDir The Maven source directory
     * @param classLoader The Maven project class loader
     * @param sources The list of source files
     * @param globals The global arguments map
     */
    public static void configure(LoaderConfigurable configurable, 
                               String sourceDir, 
                               ClassLoader classLoader,
                               List<String> sources, 
                               Map<String, String> globals) {
        
        
        // Trigger lazy initialization of ServiceLoader type discovery
        if (configurable instanceof com.metaobjects.loader.MetaDataLoader) {
            com.metaobjects.loader.MetaDataLoader loader = (com.metaobjects.loader.MetaDataLoader) configurable;
            // Just access registry to trigger ServiceLoader discovery - no manual registration needed
            loader.getTypeRegistry().getRegisteredTypes();
        }
        
        LoaderConfigurable.LoaderConfiguration config = new LoaderConfigurationBuilder()
                .sourceDir(sourceDir)
                .classLoader(classLoader)
                .sources(sources)
                .arguments(globals)
                .build();
                
        configurable.configure(config);
    }
}