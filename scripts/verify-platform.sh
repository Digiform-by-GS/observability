#!/usr/bin/env bash
# Acceptance check for the shared platform host (see platform_guide.md).
#
#   cd /opt/observability && ./scripts/verify-platform.sh
#
# Brings the stack up and proves each signal end-to-end by pushing telemetry
# through the collector's public OTLP port and reading it back out of the
# backend — "container is Up" is not evidence that a pipeline works.
#
# Exits non-zero if any check fails, so it is safe to run from CI or a cron.
set -uo pipefail
cd "$(dirname "$0")/.."

C=(docker compose -f docker-compose.yml -f docker-compose.platform.yml)
NET="$(docker network ls --format '{{.Name}}' | grep -m1 obs)"
FAIL=0
note() { printf '%-46s %s\n' "$1" "$2"; }
bad()  { note "$1" "FAIL — $2"; FAIL=1; }

# curl runs inside the obs network: Loki/Tempo/Mimir deliberately have no host
# ports, and their images are distroless so `exec curl` is not an option.
inet() { docker run --rm --network "$NET" curlimages/curl:latest -s "$@" 2>/dev/null; }

echo "=== 1. CPU capability ==="
# Tempo and Pyroscope ship GOAMD64=v2 builds and abort instantly on CPU models
# that mask these — notably KVM's default kvm64 ("Common KVM processor").
# /proc/cpuinfo spells two of these differently from the spec: SSE3 appears as
# `pni` (Prescott New Instructions) and CMPXCHG16B as `cx16`. Grepping the spec
# names reports them missing on a CPU that plainly has them — which reads as
# "the hypervisor fix didn't work" on a host where it did. Pairs are spec:proc.
MISSING=""
FLAGS="$(grep -m1 ^flags /proc/cpuinfo)"
for pair in cmpxchg16b:cx16 lahf_lm:lahf_lm popcnt:popcnt sse3:pni \
            ssse3:ssse3 sse4_1:sse4_1 sse4_2:sse4_2; do
  grep -qw "${pair##*:}" <<<"$FLAGS" || MISSING="$MISSING ${pair%%:*}"
done
if [ -n "$MISSING" ]; then
  bad "x86-64-v2" "missing:$MISSING — set the guest CPU model to host-passthrough"
  echo "    (Tempo and Pyroscope cannot start until this is fixed.)"
else
  note "x86-64-v2" "OK"
fi

echo
echo "=== 2. bring the stack up ==="
"${C[@]}" up -d 2>&1 | tail -3

echo
echo "=== 3. service readiness ==="
ready() { # name url expected_code
  for _ in $(seq 1 12); do
    code="$(inet -o /dev/null -w '%{http_code}' "$2")"
    [ "$code" = "$3" ] && { note "$1" "OK ($code)"; return 0; }
    sleep 10
  done
  bad "$1" "last status $code from $2"
}
ready "loki  /ready"        http://loki:3100/ready        200
ready "mimir /ready"        http://mimir:9009/ready       200
ready "tempo /ready"        http://tempo:3200/ready       200
ready "pyroscope /ready"    http://pyroscope:4040/ready   200
ready "otel-collector /"    http://otel-collector:13133/  200
ready "grafana /api/health" http://grafana:3000/api/health 200

echo
echo "=== 4. end-to-end signal round-trip ==="
NOW="$(date +%s)000000000"
# Leading nibble is non-zero on purpose: Tempo's search API strips leading
# zeros from trace ids, which silently breaks id matching about 1 time in 16.
TID="$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n' | sed 's/^0/a/')"
SID="$(head -c8  /dev/urandom | od -An -tx1 | tr -d ' \n')"
SVC="platform-smoke"

curl -s -o /dev/null -X POST http://localhost:4318/v1/traces -H 'content-type: application/json' -d "{
 \"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"$SVC\"}}]},
 \"scopeSpans\":[{\"spans\":[{\"traceId\":\"$TID\",\"spanId\":\"$SID\",\"name\":\"GET /smoke\",\"kind\":2,
 \"startTimeUnixNano\":\"$NOW\",\"endTimeUnixNano\":\"$NOW\"}]}]}]}"

curl -s -o /dev/null -X POST http://localhost:4318/v1/logs -H 'content-type: application/json' -d "{
 \"resourceLogs\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"$SVC\"}}]},
 \"scopeLogs\":[{\"logRecords\":[{\"timeUnixNano\":\"$NOW\",\"severityText\":\"INFO\",
 \"body\":{\"stringValue\":\"platform verification\"},
 \"traceId\":\"$TID\",\"spanId\":\"$SID\"}]}]}]}"

# service.instance.id and process.pid are sent deliberately: the platform
# collector config must strip them before Mimir. See config.platform.yaml.
curl -s -o /dev/null -X POST http://localhost:4318/v1/metrics -H 'content-type: application/json' -d "{
 \"resourceMetrics\":[{\"resource\":{\"attributes\":[
   {\"key\":\"service.name\",\"value\":{\"stringValue\":\"$SVC\"}},
   {\"key\":\"service.instance.id\",\"value\":{\"stringValue\":\"must-be-pruned\"}},
   {\"key\":\"process.pid\",\"value\":{\"intValue\":\"4242\"}}]},
 \"scopeMetrics\":[{\"metrics\":[{\"name\":\"platform_smoke\",\"sum\":{
   \"dataPoints\":[{\"asInt\":\"1\",\"startTimeUnixNano\":\"$NOW\",\"timeUnixNano\":\"$NOW\"}],
   \"aggregationTemporality\":2,\"isMonotonic\":true}}]}]}]}"

sleep 20

# Tempo renders ids in the OTLP JSON protobuf mapping, i.e. base64 of the raw
# bytes ("Gpe4399EfWk="), NOT the hex string we sent. Grepping for the hex form
# never matches and makes a healthy Tempo look broken, so convert before
# comparing. Asserting on the span id (rather than just HTTP 200) keeps this a
# real round-trip check: the exact span we emitted came back.
hex2b64() { local h="$1" e=""; while [ -n "$h" ]; do e="$e\\x${h:0:2}"; h="${h:2}"; done; printf '%b' "$e" | base64; }
SID_B64="$(hex2b64 "$SID")"
inet "http://tempo:3200/api/traces/$TID" | grep -qF "$SID_B64" \
  && note "trace readable from Tempo" "OK" \
  || bad  "trace readable from Tempo" "span $SID ($SID_B64) not found for trace $TID"

inet --get http://loki:3100/loki/api/v1/query_range \
     --data-urlencode "query={service_name=\"$SVC\"}" \
     --data-urlencode "start=$(( $(date +%s) - 600 ))000000000" \
  | grep -q "platform verification" \
  && note "log readable from Loki" "OK" \
  || bad  "log readable from Loki" "log line not returned"

# Correlation is what makes the logs useful — trace_id is stored as structured
# metadata, not in the body, which is why the Grafana derived field matches on
# a label rather than a body regex.
inet --get http://loki:3100/loki/api/v1/query_range \
     --data-urlencode "query={service_name=\"$SVC\"} | trace_id=~\`0*$TID\`" \
     --data-urlencode "start=$(( $(date +%s) - 600 ))000000000" \
  | grep -q "platform verification" \
  && note "log carries trace_id (correlation)" "OK" \
  || bad  "log carries trace_id (correlation)" "no log matched trace_id=$TID"

SERIES="$(inet --get http://mimir:9009/prometheus/api/v1/series --data-urlencode 'match[]=platform_smoke_total')"
grep -q platform_smoke_total <<<"$SERIES" \
  && note "metric readable from Mimir" "OK" \
  || bad  "metric readable from Mimir" "series not found"
grep -qE 'service_instance_id|process_pid' <<<"$SERIES" \
  && bad  "high-cardinality labels pruned" "service_instance_id/process_pid reached Mimir" \
  || note "high-cardinality labels pruned" "OK"

echo
echo "=== 5. memory headroom ==="
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}'
free -h | head -2

echo
[ "$FAIL" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED (see FAIL lines above)"
exit "$FAIL"
