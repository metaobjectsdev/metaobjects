#!/usr/bin/env bash
# Run the pinned Atlas image inside the Postgres container's network namespace.
exec docker run --rm --network "container:${H2H_PG_CONTAINER}" -v "$PWD":/w -w /w \
  --user "$(id -u):$(id -g)" arigaio/atlas:1.3.6-community "$@"
