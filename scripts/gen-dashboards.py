#!/usr/bin/env python3
"""Generates the Platform Health and Browser (RUM) dashboards.

Written as a generator rather than hand-edited JSON because Grafana dashboard
JSON is mostly boilerplate: a panel is ~60 lines of field config around one
PromQL expression. Hand-maintaining that is how panels drift apart visually and
how a typo in a query survives review.

Every metric name and label below was read off live data, not assumed. That
matters more here than usual, because the OTLP -> Prometheus translation renames
things:

    browser.web_vital.lcp  (unit ms)  ->  browser_web_vital_lcp_milliseconds_*
    browser.web_vital.cls  (unit 1)   ->  browser_web_vital_cls_*      (no suffix!)

The unit becomes part of the name for `ms` but not for `1`, so the obvious guess
is wrong for four metrics out of five, and wrong in a way that produces an empty
panel rather than an error.

Run: python3 scripts/gen-dashboards.py
"""
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "infra/grafana/provisioning/dashboards"

PROM = {"type": "prometheus", "uid": "prometheus"}
LOKI = {"type": "loki", "uid": "loki"}


def target(expr, legend, datasource=PROM, ref="A", instant=False):
    t = {
        "datasource": datasource,
        "editorMode": "code",
        "expr": expr,
        "refId": ref,
        "range": not instant,
    }
    if legend is not None:
        t["legendFormat"] = legend
    if instant:
        t["instant"] = True
    return t


def timeseries(title, targets, x, y, w, h, unit="short", desc="", thresholds=None,
               stack=False, fill=10):
    steps = [{"color": "green", "value": None}]
    if thresholds:
        steps += [{"color": c, "value": v} for v, c in thresholds]
    return {
        "type": "timeseries",
        "title": title,
        "description": desc,
        "datasource": PROM if targets[0]["datasource"] is PROM else targets[0]["datasource"],
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "fieldConfig": {
            "defaults": {
                "color": {"mode": "palette-classic"},
                "custom": {
                    "axisCenteredZero": False,
                    "axisColorMode": "text",
                    "axisLabel": "",
                    "axisPlacement": "auto",
                    "drawStyle": "line",
                    "fillOpacity": fill,
                    "gradientMode": "none",
                    "lineInterpolation": "linear",
                    "lineWidth": 2,
                    "pointSize": 5,
                    "scaleDistribution": {"type": "linear"},
                    "showPoints": "never",
                    "spanNulls": False,
                    "stacking": {"group": "A", "mode": "normal" if stack else "none"},
                    "thresholdsStyle": {"mode": "dashed" if thresholds else "off"},
                },
                "mappings": [],
                "thresholds": {"mode": "absolute", "steps": steps},
                "unit": unit,
            },
            "overrides": [],
        },
        "options": {
            "legend": {"calcs": [], "displayMode": "list", "placement": "bottom", "showLegend": True},
            "tooltip": {"mode": "multi", "sort": "desc"},
        },
        "targets": targets,
    }


def stat(title, targets, x, y, w, h, desc="", unit="short", mappings=None, thresholds=None):
    steps = [{"color": "green", "value": None}]
    if thresholds:
        steps += [{"color": c, "value": v} for v, c in thresholds]
    return {
        "type": "stat",
        "title": title,
        "description": desc,
        "datasource": PROM,
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "fieldConfig": {
            "defaults": {
                "color": {"mode": "thresholds"},
                "mappings": mappings or [],
                "thresholds": {"mode": "absolute", "steps": steps},
                "unit": unit,
            },
            "overrides": [],
        },
        "options": {
            "colorMode": "background",
            "graphMode": "none",
            "justifyMode": "auto",
            "orientation": "auto",
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "textMode": "auto",
        },
        "targets": targets,
    }


def text(title, content, x, y, w, h):
    return {
        "type": "text",
        "title": title,
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "options": {"mode": "markdown", "content": content},
        "transparent": True,
    }


def logs(title, expr, x, y, w, h, desc=""):
    return {
        "type": "logs",
        "title": title,
        "description": desc,
        "datasource": LOKI,
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "options": {
            "dedupStrategy": "none",
            "enableLogDetails": True,
            "prettifyLogMessage": False,
            "showCommonLabels": False,
            "showLabels": False,
            "showTime": True,
            "sortOrder": "Descending",
            "wrapLogMessage": True,
        },
        "targets": [target(expr, None, LOKI)],
    }


def table(title, targets, x, y, w, h, desc="", transformations=None,
          units=None, sort_by=None, descending=True):
    """A list panel. Use it when the question is "what exists", not "what changed".

    `units` maps a column name to a Grafana unit, applied as a field override -
    a table mixes rates, ratios and durations in one frame, so a single
    panel-wide unit would mislabel two columns out of three.

    Targets are instant + table-formatted. A range query would return a series
    per timestamp and render one row per scrape, which looks like duplicate
    services rather than a wrong panel setting.
    """
    for t in targets:
        t["instant"] = True
        t["range"] = False
        t["format"] = "table"
    overrides = [
        {"matcher": {"id": "byName", "options": col},
         "properties": [{"id": "unit", "value": unit}]}
        for col, unit in (units or {}).items()
    ]
    return {
        "type": "table",
        "title": title,
        "description": desc,
        "datasource": targets[0]["datasource"],
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "fieldConfig": {
            "defaults": {
                "custom": {"align": "auto", "cellOptions": {"type": "auto"},
                           "inspect": False, "filterable": True},
                "thresholds": {"mode": "absolute",
                               "steps": [{"color": "text", "value": None}]},
            },
            "overrides": overrides,
        },
        "options": {
            "showHeader": True,
            "cellHeight": "sm",
            "footer": {"show": False, "reducer": ["sum"], "countRows": False, "fields": ""},
            "sortBy": ([{"displayName": sort_by, "desc": descending}] if sort_by else []),
        },
        "transformations": transformations or [],
        "targets": targets,
    }


def dashboard(uid, title, description, tags, panels, templating=None, time_from="now-30m"):
    return {
        "annotations": {"list": []},
        "description": description,
        "editable": True,
        "fiscalYearStartMonth": 0,
        "graphTooltip": 1,
        "liveNow": False,
        "panels": panels,
        "refresh": "30s",
        "schemaVersion": 39,
        "tags": tags,
        "templating": {"list": templating or []},
        "time": {"from": time_from, "to": "now"},
        "timepicker": {},
        "timezone": "browser",
        "title": title,
        "uid": uid,
        "version": 1,
        "weekStart": "",
    }


# ---------------------------------------------------------------- platform ---
# Answers the question every other dashboard structurally cannot: is the
# observability stack itself working? Everything else here is built from data
# that arrives through this pipeline, so when the pipeline breaks the other
# dashboards go quiet and look healthy.
#
# The alerts in platform-rules.yaml fire on exactly these series. Until now they
# fired with nowhere to look.
platform_panels = [
    text(
        "",
        "## Platform health\n"
        "Is the observability stack itself working? Every other dashboard is built from "
        "data that arrives through this pipeline, so when it breaks they go **quiet, not red**.\n\n"
        "- **Components down** — whichever signal that backend stores is being dropped right now.\n"
        "- **Export failing / queue filling** — the collector cannot deliver. Nothing downstream "
        "can report this, because nothing downstream is receiving anything.\n"
        "- **Active series near the cap** — Mimir rejects metric writes for **every** service when "
        "it fills, not just the one that grew. Find the offender with "
        "`topk(10, count by (service) (count by (service, span_name) (traces_spanmetrics_calls_total)))`.",
        0, 0, 24, 4,
    ),
    stat(
        "Components responding",
        [target("up", "{{service_instance_id}}", instant=True)],
        0, 4, 6, 6,
        desc="Scrape success per platform component. 0 means the collector cannot reach it.",
        mappings=[{"type": "value", "options": {
            "0": {"text": "DOWN", "color": "red", "index": 0},
            "1": {"text": "UP", "color": "green", "index": 1}}}],
        thresholds=[(1, "green")],
    ),
    timeseries(
        "Mimir active series, all tenants",
        [target("sum(cortex_ingester_memory_series)", "active series")],
        6, 4, 9, 6,
        desc="The TOTAL across tenants. Since tenancy landed this is about Mimir's memory rather "
             "than any one team's quota - no per-tenant limit protects the box from the sum of "
             "the caps being raised past what 2 GiB holds. For whose quota is at risk, see the "
             "per-tenant panels below.",
        thresholds=[(105000, "orange"), (150000, "red")],
    ),
    timeseries(
        "Collector export queue utilisation",
        [target(
            "sum by (exporter) (otelcol_exporter_queue_size)\n"
            "  / clamp_min(sum by (exporter) (otelcol_exporter_queue_capacity), 1)",
            "{{exporter}}")],
        15, 4, 9, 6,
        unit="percentunit",
        desc="Backpressure before it becomes loss. When the queue fills, new data is dropped. "
             "This is the early warning for export failures.",
        thresholds=[(0.8, "orange")],
    ),
    timeseries(
        "Collector export failures",
        [target(
            'sum by (exporter, data_type) (rate({__name__=~"otelcol_exporter_send_failed_.+"}[5m]))',
            "{{exporter}} / {{data_type}}")],
        0, 10, 12, 7,
        unit="short",
        desc="Telemetry destroyed between collector and backend. Matched by regex because these "
             "counters do not exist until the first failure — naming them explicitly would leave "
             "the panel empty until the day it matters, with no way to tell that from healthy.",
    ),
    timeseries(
        "Writes discarded by a backend",
        [target(
            'sum by (user, tenant, reason) (rate({__name__=~"cortex_discarded_samples_total|'
            'loki_discarded_samples_total|tempo_discarded_spans_total"}[5m]))',
            "{{user}}{{tenant}} - {{reason}}")],
        12, 10, 12, 7,
        desc="A backend can be UP and still refusing writes. Broken out by tenant because that is "
             "now the blast radius: Mimir labels it `user`, Loki and Tempo label it `tenant`, and "
             "`reason` names the limit that was hit.",
    ),
    timeseries(
        "Ingest volume",
        [
            target("sum(rate(tempo_distributor_spans_received_total[5m]))", "spans/s (Tempo)"),
            target("sum(rate(cortex_distributor_samples_in_total[5m]))", "samples/s (Mimir)", ref="B"),
        ],
        0, 17, 12, 7,
        desc="What the platform is actually taking in. A sudden drop to zero with no alert usually "
             "means an app stopped, not that the platform broke — check alongside the panels above.",
    ),
    timeseries(
        "Backend memory",
        [target("process_resident_memory_bytes", "{{service_instance_id}}")],
        12, 17, 12, 7,
        unit="bytes",
        desc="Resident memory per component. Mimir is the one to watch: series count and memory "
             "move together, so this rising with the series panel is the same story twice.",
    ),

    # ---------------------------------------------------------- per tenant ---
    # The section that justifies tenancy existing. Before it, cardinality was a
    # single platform-wide number: it told you something was wrong but never
    # who, and by the time it moved, everyone's writes were already failing.
    text(
        "Per-tenant",
        "One team's cardinality can no longer reject another team's writes. These panels say "
        "**whose** quota is at risk, while the damage is still confined to them. Tenants and "
        "their caps live in `infra/tenants.yaml`.",
        0, 24, 24, 3,
    ),
    timeseries(
        "Series used against each tenant's own cap",
        [target('max by (user) (cortex_ingester_active_series) / on (user) group_left max by (user) (cortex_limits_overrides{limit_name="max_global_series_per_user"})', "{{user}}")],
        0, 27, 12, 7,
        unit="percentunit",
        desc="A ratio, not an absolute, because the caps differ per tenant - 30k for the catch-all, "
             "10k for platform. cortex_limits_overrides comes from Mimir's overrides-exporter, and "
             "ONLY for tenants with an explicit runtime-config entry, which is why gen-tenants.py "
             "writes one for every tenant even at the default. The alert fires at 80%.",
        thresholds=[(0.8, "orange"), (1.0, "red")],
    ),
    timeseries(
        "Active series per tenant",
        [target("cortex_ingester_active_series", "{{user}}")],
        12, 27, 12, 7,
        desc="The absolute counts behind the ratio. One tenant climbing while the others stay flat "
             "is usually a single service with an unbounded label value, not organic growth.",
    ),
    timeseries(
        "Ingest volume per tenant, measured at the collector",
        [target("sum by (exporter) (rate(otelcol_exporter_sent_metric_points_total[5m]))",
                "{{exporter}}")],
        0, 34, 12, 7,
        desc="One exporter per tenant, so this is the only direct evidence that the routing table "
             "does what it says. Until routing is enabled every tenant shares one exporter and this "
             "shows a single line.",
    ),
    timeseries(
        "Catch-all tenant",
        [target('cortex_ingester_active_series{user="unattributed"}', "unattributed")],
        12, 34, 12, 7,
        desc="A CLIMB HERE IS A BOTCHED ONBOARDING. Telemetry with no `team` attribute, or a team "
             "not in the manifest, is accepted and stored here on a shared quota - correctly, "
             "silently, with no error anywhere. A steady population is expected: browser RUM and "
             "the verify skill's own pushes live here permanently.",
    ),
]

# ------------------------------------------------------------------ browser ---
# Core Web Vitals are reported ONCE PER PAGE VIEW, not continuously, so these
# panels are sparse by nature on a low-traffic app. p75 is the convention Google
# uses for vitals and the one their thresholds are defined against.
def query_var(name, label, query):
    return {
        "name": name,
        "label": label,
        "type": "query",
        "datasource": PROM,
        "query": {"query": query, "refId": "StandardVariableQuery"},
        "refresh": 2,
        "multi": True,
        "includeAll": True,
        # ".*" not ".+". In practice every series has this label, because the
        # collector inserts deployment.environment on everything that passes
        # through it - verified: a span sent WITHOUT the attribute still came out
        # labelled. So this is belt-and-braces rather than a save. It costs
        # nothing and degrades gracefully if a series ever reaches Mimir without
        # going through that processor, whereas ".+" would silently drop it from
        # every panel at once.
        "allValue": ".*",
        "current": {"selected": True, "text": ["All"], "value": ["$__all"]},
        "options": [],
        "sort": 1,
    }


SERVICE_VAR = query_var(
    "service", "Browser service",
    "label_values(browser_web_vital_lcp_milliseconds_count, service_name)")
ENVIRONMENT_VAR = query_var(
    "environment", "Environment",
    "label_values(browser_web_vital_lcp_milliseconds_count, deployment_environment)")


def vital(title, metric, x, y, w, unit, desc, good=None):
    """p75 by route. `good` draws Google's 'good' threshold for that vital."""
    return timeseries(
        title,
        [target(
            "histogram_quantile(0.75, sum by (le, route) (rate(%s_bucket{service_name=~\"$service\", deployment_environment=~\"$environment\"}[5m])))" % metric,
            "{{route}}")],
        x, y, w, 7,
        unit=unit,
        desc=desc,
        thresholds=[(good, "orange")] if good is not None else None,
    )


browser_panels = [
    text(
        "",
        "## Browser (RUM)\n"
        "What the **user** experienced, as opposed to what the server did.\n\n"
        "- Vitals are reported **once per page view**, not continuously — expect sparse lines on a "
        "low-traffic app. Shown at **p75**, the percentile Google defines its thresholds against.\n"
        "- Broken down by **route template**, never URL. If you see a concrete path here "
        "(`/orders/42`), that app is minting one metric series per URL and needs fixing before it "
        "fills the shared metric store.\n"
        "- Dashed line marks Google's *good* threshold: LCP 2.5s, INP 200ms, CLS 0.1.\n"
        "- **No data?** The browser half fails silently — a blocked CORS preflight, an ad blocker, "
        "or an app posting to the service OTLP port instead of the browser one all look identical "
        "from here: nothing arrives.",
        0, 0, 24, 5,
    ),
    vital("LCP p75 — loading", "browser_web_vital_lcp_milliseconds", 0, 5, 8, "ms",
          "Largest Contentful Paint: when the main content became visible. Good < 2.5s.", good=2500),
    vital("INP p75 — responsiveness", "browser_web_vital_inp_milliseconds", 8, 5, 8, "ms",
          "Interaction to Next Paint: how long the page took to respond to input. Good < 200ms.", good=200),
    # CLS carries unit "1", so unlike the other four it gets NO unit suffix in
    # Prometheus. Assuming symmetry here is what makes this panel empty.
    vital("CLS p75 — visual stability", "browser_web_vital_cls", 16, 5, 8, "none",
          "Cumulative Layout Shift: how much the page moved under the reader. Unitless. Good < 0.1.",
          good=0.1),
    timeseries(
        "Vitals rating mix (LCP)",
        [target(
            'sum by (rating) (rate(browser_web_vital_lcp_milliseconds_count{service_name=~"$service", deployment_environment=~"$environment"}[5m]))',
            "{{rating}}")],
        0, 12, 8, 7,
        desc="Google's own good / needs-improvement / poor buckets, as a share of page views. "
             "Bounded at three values, which is why rating is safe as a label where a raw score "
             "would not be.",
        stack=True,
    ),
    timeseries(
        "Page load and fetch latency p95",
        [target(
            'histogram_quantile(0.95, sum by (le, span_name) '
            '(rate(traces_spanmetrics_latency_bucket{service=~"$service", deployment_environment=~"$environment"}[5m])))',
            "{{span_name}}")],
        8, 12, 8, 7,
        unit="s",
        desc="From browser spans (documentLoad, resourceFetch, HTTP GET). NOTE: Tempo's generator "
             "labels these `service`, not `service_name` — the two systems genuinely differ, and "
             "using the wrong one collapses every service into one unlabelled series.",
    ),
    timeseries(
        "JS error rate",
        [target(
            'sum(count_over_time({service_name=~"$service", deployment_environment=~"$environment"} | severity_text="ERROR" [5m]))',
            "errors", LOKI)],
        16, 12, 8, 7,
        desc="Uncaught errors and unhandled promise rejections. severity_text is STRUCTURED "
             "METADATA in Loki, not a label — a label matcher on it silently returns nothing.",
    ),
    logs(
        "Browser errors",
        '{service_name=~"$service", deployment_environment=~"$environment"} | severity_text="ERROR"',
        0, 19, 24, 10,
        desc="Expand a line for exception.type, code.filepath, and trace_id. Where a trace_id is "
             "present, the error is joined to the request that caused it.",
    ),
]

# ------------------------------------------------------------- inventory ---
# The front door. Every other dashboard here answers a question about a service
# you have already named: Overview needs the Service variable, Blast Radius
# starts from an incident, Platform Health is about the stack. Nothing answered
# "what services exist, who owns them, and are they all actually wired up" - so
# the only way to find out was to know the answer already.
#
# This became possible when `team` was added as a span-metrics dimension. Before
# that, the ownership column did not exist in the data at any price.
#
# NO Service variable, deliberately - same reasoning as Blast Radius. Filtering
# an inventory by the thing it is an inventory OF defeats it. Team and
# Environment narrow it without hiding what you came to see.
TEAM_VAR = query_var(
    "team", "Team", "label_values(traces_spanmetrics_calls_total, team)")
INV_ENV_VAR = query_var(
    "environment", "Environment",
    "label_values(traces_spanmetrics_calls_total, deployment_environment)")

_SEL = 'team=~"$team", deployment_environment=~"$environment"'
_BY = "service, team, deployment_environment"

inventory_panels = [
    text(
        "",
        "## Service inventory\n"
        "Every service the platform has heard from, who owns it, and how it is doing right now.\n\n"
        "**The two coverage lists below are the point of this page.** A service is only fully "
        "onboarded when it appears in *both*. Traces and metrics arriving while logs are absent is "
        "the common half-onboarded state, and it is invisible everywhere else: the RED panels fill "
        "in, the service graph draws, nothing errors, and the gap surfaces months later when "
        "someone opens an incident and finds no logs to read. A service in the traces list but not "
        "in the logs list is exactly that case.\n\n"
        "*An empty row is not a bug.* A service is listed only while it is sending; one that "
        "stopped drops off after the dashboard time range, which is itself the signal.",
        0, 0, 24, 6),

    # Three metrics, one row per service. `merge` rather than a join: all three
    # queries group by the same three labels against the same datasource, so the
    # label columns are identical and merge lines them up on shared values.
    # joinByField takes a single field and would collapse the team/env split.
    table(
        "Services",
        [
            target("sum by (%s) (rate(traces_spanmetrics_calls_total{%s}[$__rate_interval]))"
                   % (_BY, _SEL), None, ref="A"),
            target("sum by (%s) (rate(traces_spanmetrics_calls_total"
                   "{status_code=\"STATUS_CODE_ERROR\", %s}[$__rate_interval])) "
                   "/ sum by (%s) (rate(traces_spanmetrics_calls_total{%s}[$__rate_interval]))"
                   % (_BY, _SEL, _BY, _SEL), None, ref="B"),
            target("histogram_quantile(0.95, sum by (le, %s) "
                   "(rate(traces_spanmetrics_latency_bucket{%s}[$__rate_interval])))"
                   % (_BY, _SEL), None, ref="C"),
        ],
        0, 6, 24, 9,
        desc="Request rate, error ratio and p95 per service. Error ratio is blank rather than 0 for "
             "a service with no traffic in the window - a ratio with no denominator is not 0%.",
        # The label columns are produced by the datasource FRONTEND, not the
        # backend: /api/ds/query returns bare Time+Value frames for these exact
        # queries, while the browser adds service/team/environment as columns.
        # So an API response is not evidence about this panel either way - the
        # single-query table in blast-radius.json is, and it renames "Value".
        #
        # Multiple queries in one table panel are named "Value #<refId>", which
        # is what merge then lines up on the shared label columns. "Value" is
        # listed too as a harmless fallback: if these ever arrive as a single
        # frame, the column is still labelled instead of showing raw. An
        # unmatched renameByName key is ignored, so carrying both costs nothing.
        transformations=[
            {"id": "merge", "options": {}},
            {"id": "organize", "options": {
                "excludeByName": {"Time": True},
                "renameByName": {
                    "service": "Service", "team": "Team",
                    "deployment_environment": "Environment",
                    "Value #A": "Requests/sec", "Value #B": "Error ratio",
                    "Value #C": "p95 latency", "Value": "Requests/sec",
                },
            }},
        ],
        units={"Requests/sec": "reqps", "Error ratio": "percentunit", "p95 latency": "s"},
        sort_by="Requests/sec"),

    # Two lists side by side rather than one joined table. A cross-datasource
    # join needs the key renamed (span-metrics say `service`, Loki says
    # `service_name`), and `organize` is documented to work on a single query
    # only - so the join would rest on a transformation chain whose failure mode
    # is an empty panel with no error. Two lists cannot fail that way, and
    # comparing them is the entire task.
    table(
        "Sending traces",
        [target("sum by (service, team) (rate(traces_spanmetrics_calls_total{%s}[$__rate_interval]))"
                % _SEL, None, ref="A")],
        0, 15, 8, 9,
        desc="Derived by Tempo's metrics generator. These land in the catch-all Mimir tenant "
             "whatever the team is, because traces are deliberately not routed - the datasource "
             "federates across tenants, so the Team column is still correct.",
        transformations=[{"id": "organize", "options": {
            "excludeByName": {"Time": True},
            "renameByName": {"service": "Service", "team": "Team", "Value": "Requests/sec"}}}],
        units={"Requests/sec": "reqps"},
        sort_by="Service", descending=False),

    table(
        "Sending logs",
        [target("sum by (service_name) (count_over_time({service_name=~\".+\"}[$__range]))",
                None, datasource=LOKI, ref="A")],
        8, 15, 8, 9,
        desc="A service in the traces list but missing here emits no OTLP logs at all. In Node that "
             "is usually a worker-thread pino transport; in Go it is logger.Info instead of "
             "InfoContext, or a framework logger writing straight to stdout.",
        transformations=[{"id": "organize", "options": {
            "excludeByName": {"Time": True},
            "renameByName": {"service_name": "Service", "Value": "Lines in range"}}}],
        sort_by="Service", descending=False),

    table(
        "Top failing operations",
        # `> 0` inside the topk is load-bearing. Without it topk returns the
        # highest-ranked series regardless of value, so an operation that failed
        # once last week and is now at 0/sec still occupies a row - the panel
        # reads as "these things are failing" while listing nothing that is.
        # Verified: before this filter the query returned span_name="client" at
        # exactly 0 on an otherwise healthy stack.
        [target("topk(15, sum by (service, span_name) (rate(traces_spanmetrics_calls_total"
                "{status_code=\"STATUS_CODE_ERROR\", %s}[$__rate_interval])) > 0)" % _SEL,
                None, ref="A")],
        16, 15, 8, 9,
        desc="Grouped by operation rather than by service, so one broken endpoint does not read as "
             "a broken service. Empty is the healthy state here, and empty means genuinely zero - "
             "operations sitting at 0/sec are filtered out rather than ranked.",
        transformations=[{"id": "organize", "options": {
            "excludeByName": {"Time": True},
            "renameByName": {"service": "Service", "span_name": "Operation",
                             "Value": "Errors/sec"}}}],
        units={"Errors/sec": "reqps"},
        sort_by="Errors/sec"),
]

DASHBOARDS = [
    ("service-inventory.json", dashboard(
        "service-inventory", "Service Inventory",
        "Every service the platform has heard from, its owner, its health, and whether it is "
        "fully onboarded across all three signals.",
        ["observability", "inventory"], inventory_panels,
        [TEAM_VAR, INV_ENV_VAR], time_from="now-1h")),
    ("platform-health.json", dashboard(
        "platform-health", "Platform Health",
        "Health of the observability stack itself — ingest, export, backends, and the series cap.",
        ["observability", "platform"], platform_panels, time_from="now-6h")),
    ("browser-rum.json", dashboard(
        "browser-rum", "Browser (RUM)",
        "Real user monitoring: Core Web Vitals, page-load timings, and JS errors from the browser.",
        ["observability", "browser", "rum"], browser_panels, [SERVICE_VAR, ENVIRONMENT_VAR], time_from="now-6h")),
]

if __name__ == "__main__":
    for name, doc in DASHBOARDS:
        path = OUT / name
        path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8", newline="\n")
        print("wrote %s (%d panels)" % (path.name, len(doc["panels"])))
