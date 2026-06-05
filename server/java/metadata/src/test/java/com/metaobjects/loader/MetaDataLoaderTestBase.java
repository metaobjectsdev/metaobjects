/*
 * Copyright 2012 Doug Mealing LLC dba Meta Objects
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
 * Contributors:
 *    Doug Mealing LLC - initial API and implementation and/or initial documentation
 */
package com.metaobjects.loader;

import com.metaobjects.registry.SharedRegistryTestBase;
import java.net.URI;
import java.util.List;

/**
 * Base class for loader tests that uses the shared registry approach
 * to prevent registry conflicts between tests.
 *
 * <p>H3a Task 6: renamed from {@code SimpleLoaderTestBase} (package
 * {@code com.metaobjects.loader.simple}) to reflect that the class now
 * delegates to {@link MetaDataLoader}, not the removed {@code SimpleLoader}.</p>
 *
 * @author dmealing
 */
public class MetaDataLoaderTestBase extends SharedRegistryTestBase {

    /**
     * Initialize a loader with specific sources while using the shared registry.
     * This prevents registry conflicts that cause missing type registrations.
     */
    protected MetaDataLoader initLoader(List<URI> sources) {
        // Use the shared registry approach to create a loader with specific sources
        return createTestLoader(getClass().getSimpleName(), sources);
    }
}
