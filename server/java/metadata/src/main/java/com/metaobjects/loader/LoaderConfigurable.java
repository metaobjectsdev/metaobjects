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
package com.metaobjects.loader;

import java.util.List;
import java.util.Map;

/**
 * Generic interface for configuring MetaDataLoaders from external build tools.
 * This abstraction keeps build-tool-specific dependencies out of the core metadata package.
 * 
 * Implementation Pattern:
 * - Core metadata classes implement this interface
 * - Build tools (Maven, Gradle, etc.) create specific configuration builders
 * - Configuration is applied through this generic interface
 */
public interface LoaderConfigurable {
    
    /**
     * Configure the loader with a configuration object
     * @param config The configuration to apply
     */
    void configure(LoaderConfiguration config);
    
    /**
     * Get the configured MetaDataLoader instance
     * @return The configured loader
     */
    MetaDataLoader getLoader();
    
    /**
     * Configuration data holder
     */
    interface LoaderConfiguration {
        String getSourceDir();
        ClassLoader getClassLoader();
        List<String> getSources();
        Map<String, String> getArguments();

        /**
         * MetaObjects-shipped library packages to load ALONGSIDE the configured sources
         * (e.g. {@code ["ai"]} for {@code metaobjects::ai::LlmCallBase}). Prepended, so an
         * {@code extends} onto a library-shipped abstract base resolves.
         *
         * <p>Opt-in, never automatic: a library package registers real top-level nodes, and
         * a project that never references one should not find them in its model or its
         * generated output.</p>
         *
         * <p>A {@code default} rather than an abstract method deliberately — this interface
         * is the build-tool seam, and an existing implementor outside this repo must keep
         * compiling. Absent an override the answer is "no libraries", which is exactly the
         * behaviour every implementor had before the option existed.</p>
         *
         * @return the requested package names; never null
         */
        default List<String> getLibraries() {
            return java.util.Collections.emptyList();
        }
    }
}