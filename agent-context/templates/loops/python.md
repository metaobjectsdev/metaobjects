### Python: generate with `metaobjects gen`

1. **Config.** `metaobjects.config.yaml` names each target's `outDir` and its generators. Nothing
   is generated until it is listed:

   ```yaml
   targets:
     app:
       outDir: generated
       generators: [entity, names]     # Pydantic models + physical-name constants
   ```

   `routes` and `filter-allowlist` add FastAPI routers over a repository `Protocol` you
   implement; `requirement-tests` writes one pytest file per package of requirements;
   `api-docs` writes `api/python/AGENT-API.md`. `metaobjects gen --list` is the catalog.
   Install what the output imports: `pip install "pydantic[email]>=2" fastapi`.
2. **Generate.** `metaobjects gen`. `metaobjects eject <name>` copies a generator into the repo
   to change what it emits.
