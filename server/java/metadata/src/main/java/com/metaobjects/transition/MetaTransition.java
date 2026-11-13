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
package com.metaobjects.transition;

import com.metaobjects.MetaData;

/** Base node class for {@code type = "transition"} (ADR-0063): one allowed move of a lifecycle. Accessors are RESOLVING (ADR-0039). */
@SuppressWarnings("serial")
public abstract class MetaTransition extends MetaData {

    protected MetaTransition(String subType, String name) {
        super(TransitionConstants.TYPE_TRANSITION, subType, name);
    }
}
