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

/** Names of the lifecycle vocabulary: {@code transition.*} (ADR-0063). */
public final class TransitionConstants {

    private TransitionConstants() {
    }

    public static final String TYPE_TRANSITION = "transition";
    public static final String SUBTYPE_ACTION = "action";
    public static final String ATTR_FROM = "from";
    public static final String ATTR_TO = "to";
    public static final String ATTR_CONDITION = "condition";
    public static final String ATTR_PERMISSION = "permission";
    public static final String ATTR_PUBLIC = "public";
}
