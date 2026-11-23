# shellcheck shell=bash
# Sourced, never run. Gives the calling script a PRIVATE local Maven repository, so no step
# that installs this tree (at the current, unreleased version) writes a repository anyone
# else reads.
#
# Why: every worktree and every lane builds the same version (e.g. 8.3.0). Installed into a
# shared repository (~/.m2, or the ~/.m2-ci that scripts/ci-local.sh used to install into),
# a branch's jars replace what every other checkout's `-pl <module>` build resolves, and that
# checkout then tests against code it does not have. Reactor builds (`mvn -pl X -am`,
# `mvn verify`) need no installed artifacts at all; this is for the few steps that do (the
# out-of-reactor integration modules, the fat-jar smoke).
#
# The private repository is a small HEAD in front of a READ-ONLY shared cache (Maven 3.9's
# maven.repo.local.tail): third-party artifacts resolve from the cache, only what this run
# installs or newly downloads lands in the head, and the cache is never written. No full
# per-run copy of the dependency cache is made; the head lives in RAM ($DEV_SCRATCH).
#
#   METAOBJECTS_CI_M2_REPO      the shared, read-only cache. Default ~/.m2-ci/repository when
#                               it exists, else ~/.m2/repository.
#   METAOBJECTS_CI_M2_RUN_REPO  use this directory as the head instead of a temp one, and do
#                               not delete it: an EPHEMERAL hosted runner passes
#                               ~/.m2/repository so setup-java's cache keeps what it downloads.
#
# Call mo_maven_private_repo once; it exports MAVEN_ARGS (Maven 3.9+ reads it on every `mvn`,
# spawned scripts included) and sets MO_M2_OWNED to the directory the caller must delete
# (empty when it owns nothing). A MAVEN_ARGS that already names -Dmaven.repo.local is left
# alone: an enclosing script (ci-local.sh) chose already.
# shellcheck disable=SC2034  # MO_M2_OWNED is read by the sourcing script
mo_maven_private_repo() {
  MO_M2_OWNED=""
  case " ${MAVEN_ARGS:-} " in *" -Dmaven.repo.local="*) return 0 ;; esac
  local cache="${METAOBJECTS_CI_M2_REPO:-}" head
  if [ -z "$cache" ]; then
    cache="$HOME/.m2-ci/repository"
    [ -d "$cache" ] || cache="$HOME/.m2/repository"
  fi
  if [ -n "${METAOBJECTS_CI_M2_RUN_REPO:-}" ]; then
    head="$METAOBJECTS_CI_M2_RUN_REPO"
    mkdir -p "$head"
  else
    head="$(mktemp -d "${DEV_SCRATCH:-${TMPDIR:-/tmp}}/mo-m2.XXXXXX")"
    MO_M2_OWNED="$head"
  fi
  local tail=""
  if [ -d "$cache" ] && [ "$(cd "$cache" && pwd -P)" != "$(cd "$head" && pwd -P)" ]; then
    tail=" -Dmaven.repo.local.tail=$cache"
  fi
  export MAVEN_ARGS="${MAVEN_ARGS:+$MAVEN_ARGS }-Dmaven.repo.local=$head$tail"
}
