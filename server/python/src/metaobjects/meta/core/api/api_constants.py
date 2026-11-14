"""Declared API surface constants (ADR-0030, ADR-0063): type names, subtypes and attribute
keys for ``api.*``, ``operation.*`` and ``binding.*``. Mirrors TS ``core/api/api-constants.ts``.
"""
import re

# A request/response surface whose children are operations. The axis is the interaction
# model, never the protocol (ADR-0030).
API_SUBTYPE_OPERATIONAL = "operational"
API_SUBTYPES = (API_SUBTYPE_OPERATIONAL,)

OPERATION_SUBTYPE_COMMAND = "command"
OPERATION_SUBTYPE_QUERY = "query"
OPERATION_SUBTYPES = (OPERATION_SUBTYPE_COMMAND, OPERATION_SUBTYPE_QUERY)

# The HTTP binding of an operation (overrides the derived method and path).
BINDING_SUBTYPE_REST = "rest"
BINDING_SUBTYPES = (BINDING_SUBTYPE_REST,)

# Attrs on operation.* (@permission / @public are on transition.* too).
OPERATION_ATTR_INPUT_REF = "inputRef"
OPERATION_ATTR_OUTPUT_REF = "outputRef"
OPERATION_ATTR_OBJECT_REF = "objectRef"
OPERATION_ATTR_TRANSITIONS = "transitions"
OPERATION_ATTR_PERMISSION = "permission"
OPERATION_ATTR_PUBLIC = "public"
OPERATION_ATTR_ERRORS = "errors"
OPERATION_ATTR_MANY = "many"

# Attrs on binding.rest.
BINDING_ATTR_METHOD = "method"
BINDING_ATTR_PATH = "path"
HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")

# Names a declared operation or a transition may not take: they are the derived CRUD verbs
# of the same service (ERR_TRANSITION_NAME_COLLISION).
RESERVED_OPERATION_NAMES = ("create", "get", "list", "update", "delete")

# A declared @permission: a dotted identifier path (``purchasing.approve``). A package prefix may
# use ``::``, so a derived name can be declared as it is. Matched with ``fullmatch`` so a
# trailing newline does not match.
PERMISSION_NAME_PATTERN = re.compile(
    r"[A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z_][A-Za-z0-9_]*)*"
)

# A declared business error code: lower snake case.
BUSINESS_ERROR_CODE_PATTERN = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")

# Wire error codes an operation's route answers on its own, so a body may not declare them in
# @errors (O5). Order matters: it appears in a message.
RESERVED_ERROR_CODES = (
    "not_found",
    "forbidden",
    "invalid_transition",
    "transition_condition_failed",
    "state_managed",
    "validation",
    "invalid_json",
    "invalid_id",
    "method_not_allowed",
    "constraint_violation",
    "internal",
)
