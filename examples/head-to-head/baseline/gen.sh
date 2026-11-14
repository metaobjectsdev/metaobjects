#!/usr/bin/env bash
# Regenerate everything derived from the TypeSpec model.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$PWD/.venv/bin:$PATH"
npx tsp compile spec/main.tsp
npx openapi-typescript generated/openapi.yaml -o generated/api.d.ts
datamodel-codegen --input generated/openapi.yaml --input-file-type openapi \
  --output-model-type pydantic_v2.BaseModel --target-python-version 3.12 \
  --disable-timestamp --formatters black isort --output generated/models.py
