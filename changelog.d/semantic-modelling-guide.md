- **docs, agent skills: how to model vocabulary of your own semantically.** A new page,
  `docs/features/semantic-modelling.md`, states the rules a custom type, subtype or attribute is
  held to: the type says what a thing is and what it relates to, the subtype says which kind
  (it adds attributes and constraints, never a relationship), and products, versions, steps and
  environment values belong to the generators and their layered configuration. It gives the
  ordered test for where one fact goes, worked before and after examples, and the wrong turns
  an AI assistant makes. The `metaobjects-authoring` skill carries the same guidance as
  `references/semantic-modelling.md` and opens it whenever custom vocabulary is added or
  changed; the always-on file gains one rule. Run `meta agent-docs` to take the new text in an
  existing project. `agent-context/evals/skill-triggers/` gains twelve cases for that skill.
