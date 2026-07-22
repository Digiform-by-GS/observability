package observability

import (
	"testing"
	"time"
)

// The env-var contract is the only thing unifying the Go, Node, and Next.js
// stacks — there is no shared code. These tests pin it so a change here is
// deliberate rather than accidental.

func TestResolveConfigRequiresServiceName(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "")

	if _, err := resolveConfig(); err == nil {
		t.Fatal("expected an error when service name is absent, got nil")
	}
}

func TestResolveConfigDefaults(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "svc-from-env")
	t.Setenv("OTEL_SERVICE_VERSION", "")
	t.Setenv("OTEL_DEPLOYMENT_ENVIRONMENT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "")

	cfg, err := resolveConfig()
	if err != nil {
		t.Fatalf("resolveConfig: %v", err)
	}

	for _, tc := range []struct{ name, got, want string }{
		{"service name", cfg.ServiceName, "svc-from-env"},
		{"service version", cfg.ServiceVersion, defaultServiceVersion},
		{"environment", cfg.Environment, defaultEnvironment},
		{"endpoint", cfg.Endpoint, defaultEndpoint},
		{"log level", cfg.LogLevel, "info"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %q, want %q", tc.name, tc.got, tc.want)
		}
	}
	if cfg.MetricInterval != defaultMetricInterval {
		t.Errorf("metric interval = %v, want %v", cfg.MetricInterval, defaultMetricInterval)
	}
}

func TestOptionsBeatEnvironment(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "from-env")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://env:4318")

	cfg, err := resolveConfig(
		WithServiceName("from-option"),
		WithEndpoint("http://option:4318"),
		WithMetricInterval(5*time.Second),
	)
	if err != nil {
		t.Fatalf("resolveConfig: %v", err)
	}

	if cfg.ServiceName != "from-option" {
		t.Errorf("service name = %q, want the option to win", cfg.ServiceName)
	}
	if cfg.Endpoint != "http://option:4318" {
		t.Errorf("endpoint = %q, want the option to win", cfg.Endpoint)
	}
	if cfg.MetricInterval != 5*time.Second {
		t.Errorf("metric interval = %v, want 5s", cfg.MetricInterval)
	}
}

// A trailing slash would produce "http://host:4318//v1/traces". Cheap to strip,
// annoying to diagnose.
func TestEndpointTrailingSlashStripped(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "svc")

	cfg, err := resolveConfig(WithEndpoint("http://collector:4318/"))
	if err != nil {
		t.Fatalf("resolveConfig: %v", err)
	}
	if cfg.Endpoint != "http://collector:4318" {
		t.Errorf("endpoint = %q, want the trailing slash removed", cfg.Endpoint)
	}
}

func TestResourceAttributesMergePrecedence(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "svc")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "team=payments,region=eu-west-1")

	cfg, err := resolveConfig(WithResourceAttributes(map[string]string{
		"region": "us-east-1", // collides with the env value on purpose
		"tier":   "critical",
	}))
	if err != nil {
		t.Fatalf("resolveConfig: %v", err)
	}

	want := map[string]string{
		"team":   "payments",  // env only
		"region": "us-east-1", // option wins over env
		"tier":   "critical",  // option only
	}
	for k, v := range want {
		if got := cfg.ResourceAttributes[k]; got != v {
			t.Errorf("resource attribute %q = %q, want %q", k, got, v)
		}
	}
}

func TestParseResourceAttributesSkipsMalformed(t *testing.T) {
	// A typo in one attribute must not cost you every attribute.
	got := parseResourceAttributes("good=1,,malformed,=novalue,also.good = 2 ")

	if len(got) != 2 {
		t.Fatalf("parsed %d attributes (%v), want 2", len(got), got)
	}
	if got["good"] != "1" {
		t.Errorf("good = %q, want %q", got["good"], "1")
	}
	if got["also.good"] != "2" {
		t.Errorf("also.good = %q, want %q", got["also.good"], "2")
	}
}
