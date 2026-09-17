#!/usr/bin/env bash
# Validates the generated per-tenant collector fragment AGAINST THE BASE CONFIG,
# using the real collector binary at the pinned version.
#
#   ./scripts/check-collector-merge.sh
#
# Why this exists as its own check: the fragment produced by gen-tenants.py is
# never used alone. It is merged at startup by a second --config flag, and every
# interesting failure is a cross-file one - an exporter the fragment references
# but the base defines, a pipeline the routing table names that nothing creates,
# a mistyped OTTL function. None of those are visible when either file is read
# on its own, and all of them surface on the VM as a collector that refuses to
# start, taking every signal with it.
#
# The base config is transformed here into its phase-1 shape rather than being
# read as-is, because until phase 1 lands the committed base still exports
# directly and never mentions the connectors. Testing the shape we are about to
# deploy is the point; testing the shape we already have proves nothing.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

IMAGE="otel/opentelemetry-collector-contrib:0.154.0"
BASE_SRC="infra/otel-collector/config.platform.yaml"
FRAGMENT="infra/otel-collector/tenants.platform.yaml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for f in "$BASE_SRC" "$FRAGMENT"; do
  [ -f "$f" ] || { echo "missing $f - run: python3 scripts/gen-tenants.py"; exit 1; }
done

if ! docker info >/dev/null 2>&1; then
  echo "  [skip]  docker is not available; cannot validate the merged config"
  exit 0
fi

# No transformation any more. The base config now exports logs and metrics into
# the routing connectors directly, so what is validated here is exactly what the
# platform runs. This block used to synthesise that shape with sed, which was
# necessary before routing landed and is now a liability: a sed that silently
# matched nothing would validate a config nobody deploys.
#
# Sanity-check that the base really is the routed shape, so this check cannot
# quietly degrade into validating two unrelated files.
for expect in "routing/logs" "routing/metrics" "prometheus_remote_write/platform"; do
  grep -q "exporters: \[$expect\]" "$BASE_SRC" || {
    echo "$BASE_SRC has no pipeline exporting to $expect"
    echo "  (routing was removed, or the pipeline layout changed - update this script)"
    exit 1
  }
done
cp "$BASE_SRC" "$TMP/base.yaml"

OUT="$(docker run --rm -e DEPLOYMENT_ENVIRONMENT=ci \
  -v "$TMP/base.yaml:/base.yaml:ro" \
  -v "$PWD/$FRAGMENT:/tenants.yaml:ro" \
  "$IMAGE" validate --config=/base.yaml --config=/tenants.yaml 2>&1)"
RC=$?

if [ "$RC" -ne 0 ]; then
  echo "merged collector config is INVALID:"
  printf '%s\n' "$OUT" | tail -5 | sed 's/^/    /'
  exit 1
fi

echo "  merged collector config validates ($(grep -c 'X-Scope-OrgID' "$FRAGMENT") tenant exporters)"
