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
package com.metaobjects.api;

import java.util.List;
import java.util.regex.Pattern;

/** Names of the declared API surface vocabulary: {@code api.*}, {@code operation.*}, {@code binding.*} (ADR-0030, ADR-0063). */
public final class ApiConstants {

    private ApiConstants() {
    }

    public static final String TYPE_API = "api";
    public static final String TYPE_OPERATION = "operation";
    public static final String TYPE_BINDING = "binding";

    public static final String API_SUBTYPE_OPERATIONAL = "operational";
    public static final String OPERATION_SUBTYPE_COMMAND = "command";
    public static final String OPERATION_SUBTYPE_QUERY = "query";
    public static final String BINDING_SUBTYPE_REST = "rest";

    public static final String ATTR_INPUT_REF = "inputRef";
    public static final String ATTR_OUTPUT_REF = "outputRef";
    public static final String ATTR_OBJECT_REF = "objectRef";
    public static final String ATTR_PERMISSION = "permission";
    public static final String ATTR_PUBLIC = "public";
    public static final String ATTR_TRANSITIONS = "transitions";
    public static final String ATTR_ERRORS = "errors";
    public static final String ATTR_MANY = "many";
    public static final String ATTR_METHOD = "method";
    public static final String ATTR_PATH = "path";

    /** The HTTP methods a {@code binding.rest @method} may name. */
    public static final List<String> BINDING_METHODS = List.of("GET", "POST", "PUT", "PATCH", "DELETE");

    /** The derived CRUD verbs a transition or operation may not be named. */
    public static final List<String> RESERVED_OPERATION_NAMES = List.of("create", "get", "list", "update", "delete");

    /** Wire error codes the route answers itself, so an operation's {@code @errors} may not declare them (O5); the order appears in a message. */
    public static final List<String> RESERVED_ERROR_CODES = List.of(
        "not_found", "forbidden", "invalid_transition", "transition_condition_failed", "state_managed",
        "validation", "invalid_json", "invalid_id", "method_not_allowed", "constraint_violation", "internal");

    /** A business error code: lower snake case. */
    public static final Pattern BUSINESS_ERROR_CODE_PATTERN = Pattern.compile("^[a-z][a-z0-9]*(_[a-z0-9]+)*$");
}
