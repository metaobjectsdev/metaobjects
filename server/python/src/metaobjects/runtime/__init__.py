"""Minimal runtime persistence layer — ObjectManager + Postgres driver.

Cross-port shape mirrors TS runtime-ts and Java ObjectManagerDB: method-based
query API (`find_by_id` / `find_many` / `count`) that translates a Filter dict
into parameterized SQL via a pluggable driver. The corpus query scenarios
exercise eq/ne/gt/gte/lt/lte/in/like/isNull operators + the top-level `and:`
combinator + asc/desc sort + limit/offset.
"""
from .object_manager import Filter, ObjectManager, PostgresDriver

__all__ = ["Filter", "ObjectManager", "PostgresDriver"]
