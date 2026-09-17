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

# Phase-1 shape:
#   logs + metrics  -> routed by team
#   traces          -> NOT routed. Tempo's generator pairs spans within one
#                      trace within one tenant, so splitting a cross-team trace
#                      would permanently destroy the service-graph edge between
#                      those teams, and Blast Radius is built on that edge.
#   metrics/platform -> its own tenant, not routed: the collector's own scrape
#                      carries no `team`, and platform self-telemetry must never
#                      be evictable by a team's cardinality.
sed -e 's#exporters: \[otlp_http/logs\]#exporters: [routing/logs]#' \
    -e 's#exporters: \[prometheus_remote_write\]#exporters: [routing/metrics]#' \
    "$BASE_SRC" > "$TMP/base.yaml"
sed -i '/metrics\/platform:/,/exporters:/ s#exporters: \[routing/metrics\]#exporters: [prometheus_remote_write/platform]#' \
    "$TMP/base.yaml"

# Sanity-check the transformation itself. A sed that silently matched nothing
# would leave the base unrouted and the fragment unreferenced, and the validation
# below would pass while proving nothing at all.
for expect in "routing/logs" "routing/metrics" "prometheus_remote_write/platform"; do
  grep -q "exporters: \[$expect\]" "$TMP/base.yaml" || {
    echo "transform failed: no pipeline exports to $expect"
    echo "  (the pipeline layout in $BASE_SRC changed; update this script)"
    exit 1
  }
done

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
