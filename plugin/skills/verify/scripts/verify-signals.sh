#!/usr/bin/env bash
# Stage A of the verify skill: synthetic OTLP round-trip from a CLIENT machine.
# Pushes one trace + one correlated log + one metric to the platform's OTLP
# endpoint, then reads each back through Grafana's datasource proxy.
#
#   ./verify-signals.sh            # reads .observability/platform.json
#
# Optional env:
#   GRAFANA_SA_TOKEN   bearer token, needed only if the platform requires login
#
# This is the REFERENCE implementation. On machines without bash, perform the
# same steps with any HTTP tool — the skill documents each one.
set -uo pipefail

CFG=".observability/platform.json"
[ -f "$CFG" ] || { echo "ERROR: $CFG not found — run the onboard skill first"; exit 2; }

# Minimal JSON field extraction; jq if present, sed fallback so the only hard
# dependencies are curl + coreutils.
field() {
  if command -v jq >/dev/null 2>&1; then jq -r ".$1 // empty" "$CFG";
  else sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CFG" | head -1; fi
}
OTLP="$(field otlp_http)"; GRAFANA="$(field grafana)"
[ -n "$OTLP" ] && [ -n "$GRAFANA" ] || { echo "ERROR: otlp_http/grafana missing from $CFG"; exit 2; }

AUTH=()
[ -n "${GRAFANA_SA_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GRAFANA_SA_TOKEN")

FAIL=0
note() { printf '%-38s %s\n' "$1" "$2"; }
bad()  { note "$1" "FAIL — $2"; FAIL=1; }

# --- identifiers ------------------------------------------------------------
# First nibble forced non-zero: the trace store strips leading zeros from ids,
# which silently breaks exact-string matching ~1 time in 16.
TID="$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n' | sed 's/^0/a/')"
SID="$(head -c8  /dev/urandom | od -An -tx1 | tr -d ' \n')"
# tr strips spaces and other shell/query-hostile characters from usernames.
SVC="verify-$(whoami 2>/dev/null | tr -cd 'a-zA-Z0-9-' || echo client)-$(date +%m%d%H%M)"
NOW="$(date +%s)000000000"
echo "service=$SVC trace=$TID"
echo

# --- push -------------------------------------------------------------------
RES="{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"$SVC\"}}]}"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OTLP/v1/traces" -H 'content-type: application/json' -d "{
 \"resourceSpans\":[{\"resource\":$RES,\"scopeSpans\":[{\"spans\":[{
   \"traceId\":\"$TID\",\"spanId\":\"$SID\",\"name\":\"GET /verify\",\"kind\":2,
   \"startTimeUnixNano\":\"$NOW\",\"endTimeUnixNano\":\"$NOW\"}]}]}]}")
[ "$code" = "200" ] && note "push trace"  "OK" || bad "push trace" "HTTP $code from $OTLP/v1/traces"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OTLP/v1/logs" -H 'content-type: application/json' -d "{
 \"resourceLogs\":[{\"resource\":$RES,\"scopeLogs\":[{\"logRecords\":[{
   \"timeUnixNano\":\"$NOW\",\"severityText\":\"INFO\",
   \"body\":{\"stringValue\":\"signal verification\"},
   \"traceId\":\"$TID\",\"spanId\":\"$SID\"}]}]}]}")
[ "$code" = "200" ] && note "push log"    "OK" || bad "push log" "HTTP $code"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OTLP/v1/metrics" -H 'content-type: application/json' -d "{
 \"resourceMetrics\":[{\"resource\":$RES,\"scopeMetrics\":[{\"metrics\":[{
   \"name\":\"verify_signals\",\"sum\":{\"dataPoints\":[{\"asInt\":\"1\",
   \"startTimeUnixNano\":\"$NOW\",\"timeUnixNano\":\"$NOW\"}],
   \"aggregationTemporality\":2,\"isMonotonic\":true}}]}]}]}")
[ "$code" = "200" ] && note "push metric" "OK" || bad "push metric" "HTTP $code"

[ "$FAIL" = "0" ] || { echo; echo "Push failed — network/endpoint problem; read-back skipped."; exit 1; }
echo "waiting 20s for batching + ingest..."; sleep 20; echo

# --- read back through the Grafana datasource proxy --------------------------
PROXY="$GRAFANA/api/datasources/proxy/uid"

# Trace: response encodes ids as base64 of raw bytes, not hex.
hex2b64() { local h="$1" e=""; while [ -n "$h" ]; do e="$e\\x${h:0:2}"; h="${h:2}"; done; printf '%b' "$e" | base64; }
SID_B64="$(hex2b64 "$SID")"
body=$(curl -s "${AUTH[@]}" "$PROXY/tempo/api/traces/$TID")
echo "$body" | grep -qF "$SID_B64" \
  && note "trace read back (Tempo)" "OK" \
  || bad  "trace read back (Tempo)" "span $SID ($SID_B64) not in response"

START="$(( $(date +%s) - 600 ))000000000"
body=$(curl -s "${AUTH[@]}" --get "$PROXY/loki/loki/api/v1/query_range" \
  --data-urlencode "query={service_name=\"$SVC\"}" --data-urlencode "start=$START")
echo "$body" | grep -q "signal verification" \
  && note "log read back (Loki)" "OK" \
  || bad  "log read back (Loki)" "log line not returned"

# trace_id lives in queryable metadata, not the body; 0* absorbs stripped zeros.
body=$(curl -s "${AUTH[@]}" --get "$PROXY/loki/loki/api/v1/query_range" \
  --data-urlencode "query={service_name=\"$SVC\"} | trace_id=~\`0*$TID\`" --data-urlencode "start=$START")
echo "$body" | grep -q "signal verification" \
  && note "log<->trace correlation" "OK" \
  || bad  "log<->trace correlation" "no log matched trace_id=$TID"

# Monotonic sums arrive with a _total suffix.
body=$(curl -s "${AUTH[@]}" --get "$PROXY/prometheus/api/v1/query" \
  --data-urlencode "query=verify_signals_total{service_name=\"$SVC\"}")
echo "$body" | grep -q "verify_signals_total" \
  && note "metric read back (Mimir)" "OK" \
  || bad  "metric read back (Mimir)" "series not found (queried verify_signals_total)"

echo
[ "$FAIL" = "0" ] && echo "STAGE A PASSED — pipeline works from this machine. Now run Stage B (the real app)." \
                  || echo "STAGE A FAILED — see FAIL lines; consult the skill's troubleshooting table."
exit "$FAIL"
