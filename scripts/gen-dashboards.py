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
        "Mimir active series (cap 150k)",
        [target("sum(cortex_ingester_memory_series)", "active series")],
        6, 4, 9, 6,
        desc="max_global_series_per_user is 150000 and is GLOBAL on this single-tenant "
             "deployment. Past it, Mimir rejects writes for every service on the platform. "
             "The alert fires at 105k (70%).",
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
            'sum by (__name__) (rate({__name__=~"cortex_discarded_samples_total|'
            'loki_discarded_samples_total|tempo_discarded_spans_total"}[5m]))',
            "{{__name__}}")],
        12, 10, 12, 7,
        desc="A backend can be UP and still refusing writes — over a limit, malformed data, or a "
             "tenant past its cap. Invisible from the up/down panel alone.",
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

DASHBOARDS = [
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
