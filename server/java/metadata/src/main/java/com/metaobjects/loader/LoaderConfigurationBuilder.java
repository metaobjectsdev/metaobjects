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

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Builder for creating LoaderConfiguration instances.
 * This provides a fluent API for build tools to configure loaders
 * without depending on build-tool-specific interfaces.
 */
public class LoaderConfigurationBuilder {
    
    private String sourceDir;
    private ClassLoader classLoader;
    private List<String> sources = new ArrayList<>();
    private List<String> libraries = new ArrayList<>();
    private Map<String, String> arguments = new HashMap<>();
    
    public LoaderConfigurationBuilder() {
    }
    
    public LoaderConfigurationBuilder sourceDir(String sourceDir) {
        this.sourceDir = sourceDir;
        return this;
    }
    
    public LoaderConfigurationBuilder classLoader(ClassLoader classLoader) {
        this.classLoader = classLoader;
        return this;
    }
    
    public LoaderConfigurationBuilder source(String source) {
        this.sources.add(source);
        return this;
    }
    
    public LoaderConfigurationBuilder sources(List<String> sources) {
        if (sources != null) {
            this.sources.addAll(sources);
        }
        return this;
    }
    
    /**
     * MetaObjects-shipped library packages to load alongside the sources — see
     * {@link LoaderConfigurable.LoaderConfiguration#getLibraries()}.
     *
     * @param libraries package names (e.g. {@code ["ai"]}); null is ignored
     * @return this builder
     */
    public LoaderConfigurationBuilder libraries(List<String> libraries) {
        if (libraries != null) {
            this.libraries.addAll(libraries);
        }
        return this;
    }

    public LoaderConfigurationBuilder argument(String key, String value) {
        this.arguments.put(key, value);
        return this;
    }
    
    public LoaderConfigurationBuilder arguments(Map<String, String> arguments) {
        if (arguments != null) {
            this.arguments.putAll(arguments);
        }
        return this;
    }
    
    public LoaderConfigurationBuilder register(boolean register) {
        return argument(LoaderConfigurationConstants.ARG_REGISTER, String.valueOf(register));
    }
    
    public LoaderConfigurationBuilder verbose(boolean verbose) {
        return argument(LoaderConfigurationConstants.ARG_VERBOSE, String.valueOf(verbose));
    }
    
    public LoaderConfigurationBuilder strict(boolean strict) {
        return argument(LoaderConfigurationConstants.ARG_STRICT, String.valueOf(strict));
    }
    
    public LoaderConfigurable.LoaderConfiguration build() {
        return new LoaderConfigurationImpl(sourceDir, classLoader, new ArrayList<>(sources),
                new ArrayList<>(libraries), new HashMap<>(arguments));
    }
    
    /**
     * Internal implementation of LoaderConfiguration
     */
    private static class LoaderConfigurationImpl implements LoaderConfigurable.LoaderConfiguration {
        private final String sourceDir;
        private final ClassLoader classLoader;
        private final List<String> sources;
        private final List<String> libraries;
        private final Map<String, String> arguments;

        public LoaderConfigurationImpl(String sourceDir, ClassLoader classLoader,
                                     List<String> sources, List<String> libraries,
                                     Map<String, String> arguments) {
            this.sourceDir = sourceDir;
            this.classLoader = classLoader;
            this.sources = sources;
            this.libraries = libraries;
            this.arguments = arguments;
        }
        
        @Override
        public String getSourceDir() {
            return sourceDir;
        }
        
        @Override
        public ClassLoader getClassLoader() {
            return classLoader;
        }
        
        @Override
        public List<String> getSources() {
            return sources;
        }
        
        @Override
        public List<String> getLibraries() {
            return libraries;
        }

        @Override
        public Map<String, String> getArguments() {
            return arguments;
        }
    }
}