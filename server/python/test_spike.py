import unittest

from metaobjects import MetaField, MetaObject


class CrossLanguageSpike(unittest.TestCase):
    def test_super_chain_effective_fields_and_caching(self) -> None:
        base = MetaObject("entity", "BaseEntity")
        base.is_abstract = True
        base.add_child(MetaField("long", "id"))

        sub = MetaObject("entity", "Subscriber")
        sub.add_child(MetaField("string", "email"))
        sub.super_data = base

        base.freeze()
        sub.freeze()

        field_names = [f.name for f in sub.fields()]
        self.assertIn("id", field_names)       # inherited via super_data
        self.assertIn("email", field_names)    # own
        self.assertEqual(len(field_names), 2)

        own_names = [f.name for f in sub.own_fields()]
        self.assertEqual(own_names, ["email"])

        self.assertIs(sub.fields(), sub.fields())  # cached — same list object


if __name__ == "__main__":
    unittest.main()
