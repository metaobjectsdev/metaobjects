"""Runtime helpers shipped alongside generated routers.

Generated code from the PACKAGED ``routes`` generator imports from this package directly.
These modules are helper tier, not core (ADR-0034 Amendment 3): ``metaobjects eject
routes`` copies their source into the adopter's ``codegen/runtime/``, and the owned
generator's output imports that copy instead. So each module must stay self-contained —
standard library only, no ``metaobjects`` import and no FastAPI / SQLAlchemy / pg8000
dependency — or the copy would not run on its own.
"""
