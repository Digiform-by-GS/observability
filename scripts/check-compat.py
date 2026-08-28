#!/usr/bin/env python3
"""Assert that plugin/skills/onboard/references/compat.json still describes reality.

compat.json is the only version source the onboarding agent can see: the runner mounts
plugin/ and nothing else. If it drifts from the packages in this repo, the agent installs
versions that do not exist or do not work, and nothing catches it until a client's build
fails. Both onboarding defects shipped so far were a wrong version chosen where nothing
authoritative said otherwise, so this check is the mechanism that keeps the manifest
worth reading.

Deliberately checks only INTERNAL consistency - never whether an upstream release is
newer. An upstream release must not break unrelated PRs; staleness is a scheduled job
that opens an issue instead.

Run: python3 scripts/check-compat.py
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []


def check(ok, message):
    if not ok:
        FAILURES.append(message)


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


COMPAT_PATH = "plugin/skills/onboard/references/compat.json"
compat = json.loads(read(COMPAT_PATH))

# --- Node wrapper -----------------------------------------------------------
pkg = json.loads(read("packages/observability/package.json"))
node = compat["node"]

check(
    node["version"] == pkg["version"],
    f"{COMPAT_PATH} node.version is {node['version']!r} but "
    f"packages/observability/package.json version is {pkg['version']!r}",
)
check(
    node["engines"] == pkg["engines"]["node"],
    f"{COMPAT_PATH} node.engines is {node['engines']!r} but "
    f"package.json engines.node is {pkg['engines']['node']!r}",
)
check(
    node["package"] == pkg["name"],
    f"{COMPAT_PATH} node.package is {node['package']!r} but package.json name is {pkg['name']!r}",
)
check(
    node["version"] in node["install"],
    f"{COMPAT_PATH} node.install does not pin node.version - the agent copies this string verbatim",
)

# --- Go module --------------------------------------------------------------
go_mod = read("packages/observability-go/go.mod")
go = compat["go"]

go_directive = re.search(r"^go (\d+\.\d+)", go_mod, re.M).group(1)
check(
    go["toolchain"] == f">={go_directive}",
    f"{COMPAT_PATH} go.toolchain is {go['toolchain']!r} but "
    f"packages/observability-go/go.mod declares go {go_directive}",
)

otel_version = re.search(r"^\tgo\.opentelemetry\.io/otel (v[\d.]+)$", go_mod, re.M).group(1)
check(
    go["raisesOtelTo"] == otel_version,
    f"{COMPAT_PATH} go.raisesOtelTo is {go['raisesOtelTo']!r} but "
    f"go.mod requires go.opentelemetry.io/otel {otel_version}",
)

module_path = re.search(r"^module (\S+)", go_mod, re.M).group(1)
check(
    go["module"] == module_path,
    f"{COMPAT_PATH} go.module is {go['module']!r} but go.mod declares {module_path!r}",
)
check(
    go["version"] in go["install"],
    f"{COMPAT_PATH} go.install does not pin go.version - the agent copies this string verbatim",
)

# --- READMEs are what a client sees after npm install / go get ---------------
# They are the whole reason this work exists: the tables used to live only in
# developer_guide.md, which no client can read.
node_readme = read("packages/observability/README.md")
check(
    "## Compatibility" in node_readme,
    "packages/observability/README.md has no '## Compatibility' section",
)
check(
    pkg["engines"]["node"].replace("|", chr(92) + "|") in node_readme,
    f"packages/observability/README.md does not state the engines floor {pkg['engines']['node']!r}",
)
check(
    "@opentelemetry/api" in node_readme and "singleton" in node_readme.lower(),
    "packages/observability/README.md must warn about the @opentelemetry/api singleton hazard",
)

go_readme = read("packages/observability-go/README.md")
check(
    "## Compatibility" in go_readme,
    "packages/observability-go/README.md has no '## Compatibility' section",
)
check(
    otel_version in go_readme,
    f"packages/observability-go/README.md does not state the OTel version {otel_version}",
)
check(
    "maximum" in go_readme,
    "packages/observability-go/README.md must explain that installing it raises OTel graph-wide",
)

# --- Go router helpers (httpx) ----------------------------------------------
# Pinned separately from the parent module and easy to drift: contrib releases
# every instrumentation together, so a routine `go get -u` in httpx would pull
# otel past v1.44 and, via Go's max-version selection, silently raise it for any
# service that also uses observability-go.
httpx_mod = read("packages/observability-go/httpx/go.mod")
routers = compat["goRouters"]

httpx_module_path = re.search(r"^module (\S+)", httpx_mod, re.M).group(1)
check(
    routers["module"] == httpx_module_path,
    f"{COMPAT_PATH} goRouters.module is {routers['module']!r} but "
    f"httpx/go.mod declares {httpx_module_path!r}",
)

for name, pinned in routers["wraps"].items():
    found = re.search(rf"^	\S*{re.escape(name)} (v[\d.]+)$", httpx_mod, re.M)
    check(found is not None, f"httpx/go.mod does not require {name} at all")
    if found:
        check(
            found.group(1) == pinned,
            f"{COMPAT_PATH} goRouters.wraps[{name!r}] is {pinned!r} but "
            f"httpx/go.mod requires {found.group(1)}",
        )

# The pin exists to hold OTel at the parent module's version. Assert the outcome,
# not just the inputs - this is the check that actually catches a bad bump.
httpx_sdk = re.search(r"go\.opentelemetry\.io/otel/sdk (v[\d.]+)", httpx_mod)
check(
    httpx_sdk is not None and httpx_sdk.group(1) == otel_version,
    f"httpx resolves go.opentelemetry.io/otel/sdk to "
    f"{httpx_sdk.group(1) if httpx_sdk else 'nothing'}, but observability-go pins otel "
    f"to {otel_version}. A service using both gets the maximum of the two.",
)

check(
    (ROOT / "packages/observability-go/httpx/go.sum").exists(),
    "packages/observability-go/httpx/go.sum is missing - Go refuses to build without it",
)

httpx_readme = read("packages/observability-go/httpx/README.md")
for router in ("chix", "ginx", "echox", "muxx"):
    check(
        router in httpx_readme,
        f"httpx/README.md does not document the {router} package",
    )
    check(
        (ROOT / f"packages/observability-go/httpx/{router}/{router}_test.go").exists(),
        f"httpx/{router} has no span-name test - the naming guarantee is the whole product",
    )

# --- Next.js pin ------------------------------------------------------------
# No package of ours to diff against, so assert the facts that made the frontend
# onboarding wrong: the 2.x floor, and that the logs gap is stated rather than implied.
nextjs = compat["nextjs"]
check(
    nextjs["version"].lstrip("^~").startswith("2."),
    f"{COMPAT_PATH} nextjs.version is {nextjs['version']!r}; the 1.x line peers against "
    "OpenTelemetry SDK 1.x and does not work with this stack",
)
check(
    nextjs["version"] in nextjs["install"],
    f"{COMPAT_PATH} nextjs.install does not pin nextjs.version",
)
check(
    "NO logs" in nextjs["signals"],
    f"{COMPAT_PATH} nextjs.signals must state the logs gap explicitly",
)
check(
    "@vercel/otel" in node_readme and "^2." in node_readme,
    "packages/observability/README.md must point Next.js users at @vercel/otel 2.x",
)

# --- Report -----------------------------------------------------------------
if FAILURES:
    print("compat drift detected:\n", file=sys.stderr)
    for f in FAILURES:
        print(f"  - {f}", file=sys.stderr)
    print(
        f"\n{len(FAILURES)} problem(s). Update {COMPAT_PATH} and the packages together.",
        file=sys.stderr,
    )
    sys.exit(1)

print("compat.json agrees with the packages and READMEs")
