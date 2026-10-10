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
    # Stable, explicit panel ids. Grafana tolerates their absence in a dashboard
    # file - it renders fine - so this looked unnecessary for a long time. It is
    # not, for one reason: /d-solo/<uid>/<slug>?panelId=N is how a panel is
    # embedded in an iframe, and that N has to identify the same panel every
    # time. Provisioned without ids, every panel came back from Grafana's API as
    # id=None, so there was nothing to embed against except observability-overview,
    # which happened to carry ids already.
    #
    # Assigned here rather than at each call site because this is the one
    # function every dashboard passes through, so no dashboard can be added
    # later that forgets. Order is deterministic - the panel lists are literals -
    # so a given panel keeps its id across regenerations, and an explicit id on
    # a panel is honoured rather than overwritten.
    for i, panel in enumerate(panels, start=1):
        panel.setdefault("id", i)
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
            # `or <total> * 0` is what makes this column exist at all. With
            # nothing failing anywhere the numerator is an EMPTY vector, and
            # empty / anything is empty - so on a healthy platform the Error
            # ratio column was blank for every service, which is also exactly
            # how it would look if the data were missing. Verified against live
            # data: 0 rows before, 4 rows of 0 after.
            #
            # The multiply-by-zero exists only to mint a zero-valued series
            # carrying the same label set. `or vector(0)` is the reflex here and
            # is wrong - it drops the labels, so the row cannot join the others.
            target("(sum by (%s) (rate(traces_spanmetrics_calls_total"
                   "{status_code=\"STATUS_CODE_ERROR\", %s}[$__rate_interval])) "
                   "or sum by (%s) (rate(traces_spanmetrics_calls_total{%s}[$__rate_interval])) * 0)"
                   " / sum by (%s) (rate(traces_spanmetrics_calls_total{%s}[$__rate_interval]))"
                   % (_BY, _SEL, _BY, _SEL, _BY, _SEL), None, ref="B"),
            target("histogram_quantile(0.95, sum by (le, %s) "
                   "(rate(traces_spanmetrics_latency_bucket{%s}[$__rate_interval])))"
                   % (_BY, _SEL), None, ref="C"),
        ],
        0, 6, 24, 9,
        desc="Request rate, error ratio and p95 per service. A service with traffic and no failures "
             "reads 0%, not blank. A service with no traffic at all in the window has no row here "
             "at all, which is the honest answer - a ratio with no denominator is not 0%.",
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

# --------------------------------------------------------- app metrics ---
# The SDK's own HTTP metrics. Fifteen of these families were arriving and no
# panel anywhere read them: every RED number on Overview, Blast Radius and the
# inventory comes from Tempo's span-metrics instead.
#
# They are not redundant with each other. Span-metrics are derived by the
# platform from spans it stored, so they stop when the generator stops and they
# carry only the dimensions tempo-config.yaml declares. These come straight
# from the instrumented process, and they carry things a span-metric does not:
# payload sizes, and `server_address` on the client side - which is the only
# per-dependency latency the platform has.
#
# MIND THE LABEL. These say `service_name`; span-metrics say `service`. Both
# are correct in their own system, and a query that mixes them silently returns
# one unlabelled series. They also land in the TEAM's Mimir tenant rather than
# the catch-all, because metrics are routed and traces are not - the Grafana
# datasource federates, so a panel does not have to care, but a curl does.
APP_TEAM_VAR = query_var(
    "team", "Team",
    "label_values(http_server_request_duration_seconds_count, team)")
APP_SERVICE_VAR = query_var(
    "service", "Service",
    'label_values(http_server_request_duration_seconds_count{team=~"$team"}, service_name)')
APP_ENV_VAR = query_var(
    "environment", "Environment",
    "label_values(http_server_request_duration_seconds_count, deployment_environment)")

_APP = 'service_name=~"$service", team=~"$team", deployment_environment=~"$environment"'

app_panels = [
    text(
        "",
        "## Application metrics\n"
        "Emitted by the service itself, not derived from its spans. The RED panels on "
        "**Observability Overview** come from Tempo's metrics generator; these come from the SDK, "
        "and they survive the generator being down.\n\n"
        "**These are the real request volumes.** Span-based panels elsewhere show only what the "
        "application sampled. Measured on this platform: one service served 962,167 requests on a "
        "single route in 24h and produced 128 spans for it, so Overview read ~12 req/s against an "
        "actual ~826 req/s. The platform does not sample — the ratio is whatever the service set — "
        "and these counters are not sampled at all, so **expect the two dashboards to disagree by "
        "orders of magnitude. Neither is broken.** The same applies to errors: at a heavy sample "
        "rate a quiet error panel on span-metrics is not evidence that there were none.\n\n"
        "Two things live here that exist nowhere else: **payload sizes**, and **outbound dependency "
        "latency** keyed by the host actually called.\n\n"
        "*Routes are templates* (`/api/customers`, not `/api/customers/42`). If you see concrete ids "
        "here, the service is minting unbounded series and needs its router middleware fixed.",
        0, 0, 24, 8),

    # topk, because this platform already has 75 distinct routes for one
    # service. All of them on one chart is a solid block of colour.
    timeseries(
        "Request rate — top 10 routes",
        [target("topk(10, sum by (http_route) (rate(http_server_request_duration_seconds_count{%s}[$__rate_interval])))" % _APP,
                "{{http_route}}")],
        0, 8, 12, 8, unit="reqps",
        desc="Server-side, by route template."),

    timeseries(
        "p95 latency — top 10 routes",
        [target("topk(10, histogram_quantile(0.95, sum by (le, http_route) "
                "(rate(http_server_request_duration_seconds_bucket{%s}[$__rate_interval]))))" % _APP,
                "{{http_route}}")],
        12, 8, 12, 8, unit="s",
        desc="A route with no traffic in the window yields NaN and simply leaves a gap - that is "
             "absence of data, not a latency of zero."),

    # Status CODE, not an error rate. A 5xx rate query returns an EMPTY vector
    # when nothing is failing, so that panel reads "No data" on a healthy
    # service - indistinguishable from the metric having gone away. Verified:
    # the 5xx query returned 0 series against this platform. The mix always has
    # data, and shows the 4xx/2xx balance shifting, which a 5xx line cannot.
    timeseries(
        "Responses by status code",
        [target("sum by (http_response_status_code) (rate(http_server_request_duration_seconds_count{%s}[$__rate_interval]))" % _APP,
                "{{http_response_status_code}}")],
        0, 16, 12, 7, unit="reqps", stack=True,
        desc="Stacked, and deliberately not an error RATE: with nothing failing, a 5xx query "
             "returns an empty vector and the panel reads 'No data', which looks identical to the "
             "metric having disappeared."),

    timeseries(
        "Payload size p95 — request and response",
        [target("histogram_quantile(0.95, sum by (le) (rate(http_server_request_body_size_bytes_bucket{%s}[$__rate_interval])))" % _APP,
                "request", ref="A"),
         target("histogram_quantile(0.95, sum by (le) (rate(http_server_response_body_size_bytes_bucket{%s}[$__rate_interval])))" % _APP,
                "response", ref="B")],
        12, 16, 12, 7, unit="bytes",
        desc="Span-metrics cannot answer this. A latency rise that tracks response size is a "
             "payload problem, not a slow handler."),

    text(
        "",
        "## Outbound dependencies\n"
        "What this service calls, keyed by `server_address` — the host actually contacted. The only "
        "per-dependency timing the platform has: the service graph pairs spans *within* a trace, so "
        "it shows services that are instrumented, never a third party that is not.\n\n"
        "Requires `otelhttp.NewTransport` on the client. An SDK that builds its own transport "
        "(`gocloak`, `resty`) reports nothing here and severs the trace too.",
        0, 23, 24, 4),

    timeseries(
        "Outbound request rate by dependency",
        [target("sum by (server_address) (rate(http_client_request_duration_seconds_count{%s}[$__rate_interval]))" % _APP,
                "{{server_address}}")],
        0, 27, 8, 8, unit="reqps"),

    timeseries(
        "Outbound p95 by dependency",
        [target("histogram_quantile(0.95, sum by (le, server_address) "
                "(rate(http_client_request_duration_seconds_bucket{%s}[$__rate_interval])))" % _APP,
                "{{server_address}}")],
        8, 27, 8, 8, unit="s",
        desc="Time your service spent waiting on someone else. Latency that appears here and not "
             "in the server panels above is not your code."),

    timeseries(
        "Outbound responses by status code",
        [target("sum by (server_address, http_response_status_code) "
                "(rate(http_client_request_duration_seconds_count{%s}[$__rate_interval]))" % _APP,
                "{{server_address}} {{http_response_status_code}}")],
        16, 27, 8, 8, unit="reqps", stack=True),
]

# ------------------------------------------------------------------ errors ---
# One screen for "something failed - show me the line, let me pivot to the
# trace". Built after measuring what this platform actually holds, which
# changed the design twice:
#
#   1. EVERY log line here is INFO. 75,786 of them, zero ERROR. A dashboard
#      filtering severity_text="ERROR" alone would have been correct, empty,
#      and indistinguishable from broken - the exact failure this repo keeps
#      hitting. Real failures are visible instead in http_response_status_code,
#      which the access logger records on every request.
#   2. Loki has only THREE stream labels here: __tenant_id__,
#      deployment_environment, service_name. `team` is structured metadata, so
#      it filters AFTER the selector. A {team="x"} matcher returns nothing,
#      silently, exactly like severity_text.
#
# Hence both arms, OR'd: severity is what will match once services log errors
# properly, status is what matches today.
ERR_SELECTOR = '{service_name=~"$service", deployment_environment=~"$environment"}'
# Both severity_text and http_response_status_code are structured metadata, so
# both live after the pipe. The numeric compare is verified against the live
# platform to parse - LogQL coerces the stored string for >= .
ERR_FILTER = ('| team=~"$team" | severity_text=~"ERROR|FATAL|CRITICAL" '
              'or http_response_status_code>=$min_status')
ERR_STREAM = ERR_SELECTOR + ' ' + ERR_FILTER


def loki_var(name, label, query):
    """A variable whose values come from LOKI rather than Mimir.

    The other dashboards source $service from span-metrics. That is wrong here:
    a service that logs but emits no spans - sampled hard, or only running jobs
    - would be absent from the dropdown on the one dashboard built to find its
    errors.
    """
    return {
        "name": name,
        "label": label,
        "type": "query",
        "datasource": LOKI,
        "query": {"query": query, "refId": "LokiVariableQueryEditor-VariableQuery"},
        "refresh": 2,
        "multi": True,
        "includeAll": True,
        # ".+" and NOT ".*", which is what the Prometheus variables use.
        # Loki rejects a stream selector whose every matcher can match empty:
        # "queries require at least one regexp or equality matcher that does
        # not have an empty-compatible value". With ".*" this dashboard fails
        # on its own default All/All selection - caught by running the
        # generated queries against the live backend rather than eyeballing them.
        "allValue": ".+",
        "current": {"selected": True, "text": ["All"], "value": ["$__all"]},
    }


ERR_SERVICE_VAR = loki_var("service", "Service", "label_values(service_name)")
ERR_ENV_VAR = loki_var("environment", "Environment", "label_values(deployment_environment)")

# team is structured metadata, so there is no label_values() for it. A textbox
# beats a query variable that would silently resolve to an empty list.
ERR_TEAM_VAR = {
    "name": "team", "label": "Team", "type": "textbox",
    "query": ".*", "current": {"text": ".*", "value": ".*"},
    "description": "Structured metadata, not a stream label, so it filters after the "
                   "selector. Leave as .* for all teams.",
}

# The threshold is a CONTROL, not a constant, because the right value is not
# obvious and the wrong one is invisible. 500 is the correct default - a 4xx is
# the caller's fault, not blast radius - but this platform currently serves
# zero 5xx against 26 4xx, so a hardcoded 500 would render an empty dashboard
# on day one and teach everyone to distrust it.
ERR_STATUS_VAR = {
    "name": "min_status", "label": "Min HTTP status", "type": "custom",
    "query": "500,400",
    "options": [
        {"text": "500", "value": "500", "selected": True},
        {"text": "400", "value": "400", "selected": False},
    ],
    "current": {"text": "500", "value": "500"},
    "description": "500 is real blast radius. Drop to 400 to include client errors - worth "
                   "doing here, because this platform currently emits no 5xx at all.",
}

error_panels = [
    text(
        "",
        "## Error logs\n"
        "Failing lines across every service, newest first, each carrying its **trace_id** - "
        "click it for the trace, or the **Blast Radius** link to see everything else that "
        "request touched.\n\n"
        "**What counts as an error:** `severity_text` of ERROR/FATAL/CRITICAL, **or** an HTTP "
        "status at or above the threshold. Both arms are needed - every log line on this "
        "platform is currently INFO, so severity alone would match nothing while real failures "
        "sat unnoticed in the status codes.\n\n"
        "**An empty panel is a real answer**, not a broken query: nothing matched. If you expect "
        "errors and see none, drop the threshold to 400 before suspecting the dashboard.",
        0, 0, 24, 5,
    ),
    stat(
        "Matching lines",
        [target("sum(count_over_time(" + ERR_STREAM + " [$__range]))", None, LOKI)],
        0, 5, 4, 4,
        desc="Lines matching the filter over the dashboard's time range.",
    ),
    stat(
        "Services affected",
        [target("count(sum by (service_name) (count_over_time(" + ERR_STREAM + " [$__range])))",
                None, LOKI)],
        4, 5, 4, 4,
        desc="Distinct services producing a matching line. More than one is the signal worth "
             "acting on - it points at a shared dependency rather than one service's bug.",
    ),
    timeseries(
        "Error rate by service",
        [target("sum by (service_name) (count_over_time(" + ERR_STREAM + " [$__interval]))",
                "{{service_name}}", LOKI)],
        8, 5, 16, 4,
        desc="Loki labels logs service_name; Tempo's span-metrics use service. Same value, "
             "different spelling - a query copied between the two returns one unlabelled series.",
    ),
    table(
        "Where the errors are",
        [target("sum by (service_name, http_route, http_response_status_code) "
                "(count_over_time(" + ERR_STREAM + " [$__range]))", None, LOKI, instant=True)],
        0, 9, 8, 13,
        desc="Grouped by route and status, so one broken endpoint stands out from a service "
             "failing everywhere. Routes are templates, so this stays bounded.",
    ),
    logs(
        "Error lines - expand one for its trace_id",
        ERR_STREAM,
        8, 9, 16, 13,
        desc="Expand a line for its structured metadata: trace_id, span_id, http_route, "
             "duration_ms. trace_id carries links to Tempo and to Blast Radius.",
    ),
]


DASHBOARDS = [
    ("app-metrics.json", dashboard(
        "app-metrics", "Application Metrics",
        "HTTP metrics emitted by the services themselves - routes, payload sizes, and outbound dependency latency.",
        ["observability", "application"], app_panels,
        [APP_TEAM_VAR, APP_SERVICE_VAR, APP_ENV_VAR], time_from="now-1h")),
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
    ("error-logs.json", dashboard(
        "error-logs", "Error Logs",
        "Failing log lines across every service, with the trace_id to pivot into the trace "
        "or into Blast Radius.",
        ["observability", "errors", "logs"], error_panels,
        [ERR_SERVICE_VAR, ERR_ENV_VAR, ERR_TEAM_VAR, ERR_STATUS_VAR], time_from="now-6h")),
]

if __name__ == "__main__":
    for name, doc in DASHBOARDS:
        path = OUT / name
        path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8", newline="\n")
        print("wrote %s (%d panels)" % (path.name, len(doc["panels"])))
