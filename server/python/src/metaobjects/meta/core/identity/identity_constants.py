"""Identity subtype + attr vocabulary (colocated)."""
IDENTITY_SUBTYPE_PRIMARY = "primary"
IDENTITY_SUBTYPE_SECONDARY = "secondary"
IDENTITY_SUBTYPE_REFERENCE = "reference"
IDENTITY_SUBTYPES = (IDENTITY_SUBTYPE_PRIMARY, IDENTITY_SUBTYPE_SECONDARY, IDENTITY_SUBTYPE_REFERENCE)

# The identity subtypes that denote a UNIQUE key (#310).
#
# ADR-0040 put uniqueness in the TYPE: primary and secondary are both unique keys
# (secondary IS the unique alternate key — @unique was removed from it precisely because
# the subtype already says so), while reference is a foreign key and carries no uniqueness.
# Named here because more than one rule needs "is this a candidate key?", and answering it
# by listing subtypes at each site is how the sites drift apart.
IDENTITY_UNIQUE_KEY_SUBTYPES = (IDENTITY_SUBTYPE_PRIMARY, IDENTITY_SUBTYPE_SECONDARY)

IDENTITY_ATTR_FIELDS = "fields"
IDENTITY_ATTR_GENERATION = "generation"
IDENTITY_ATTR_UNIQUE = "unique"

# Allowed values for @generation on identity.primary
GENERATION_INCREMENT = "increment"
GENERATION_UUID = "uuid"
GENERATION_ASSIGNED = "assigned"
GENERATION_VALUES = (GENERATION_INCREMENT, GENERATION_UUID, GENERATION_ASSIGNED)

# identity.reference attrs: target entity and enforcement flag
IDENTITY_REFERENCE_ATTR_REFERENCES = "references"
IDENTITY_REFERENCE_ATTR_ENFORCE = "enforce"
