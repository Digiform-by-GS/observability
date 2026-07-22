package observability

import (
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	defaultEndpoint       = "http://localhost:4318"
	defaultServiceVersion = "0.0.0"
	defaultEnvironment    = "development"
	defaultMetricInterval = 60 * time.Second
)

// Config is the resolved configuration. Field-for-field this mirrors
// ResolvedConfig in packages/observability/src/types.ts so that a service
// author moving between the Go and Node stacks configures them identically.
type Config struct {
	ServiceName        string
	ServiceVersion     string
	Environment        string
	Endpoint           string
	ResourceAttributes map[string]string
	MetricInterval     time.Duration
	LogLevel           string

	// DisableRuntimeMetrics turns off Go runtime instrumentation (GC pauses,
	// goroutine count, heap). Left on by default: those series are the single
	// best predictor of a p99 that is about to get worse.
	DisableRuntimeMetrics bool

	// DisableStdoutLogs stops mirroring log records to stdout. The mirror
	// exists so logs remain visible when the collector is unreachable.
	DisableStdoutLogs bool
}

// Option mutates configuration before defaults are resolved. Options take
// precedence over environment variables, which take precedence over defaults —
// the same order as the Node package's resolveConfig.
type Option func(*Config)

func WithServiceName(v string) Option    { return func(c *Config) { c.ServiceName = v } }
func WithServiceVersion(v string) Option { return func(c *Config) { c.ServiceVersion = v } }
func WithEnvironment(v string) Option    { return func(c *Config) { c.Environment = v } }
func WithEndpoint(v string) Option       { return func(c *Config) { c.Endpoint = v } }
func WithLogLevel(v string) Option       { return func(c *Config) { c.LogLevel = v } }

func WithMetricInterval(d time.Duration) Option {
	return func(c *Config) { c.MetricInterval = d }
}

// WithResourceAttributes merges additional resource attributes. Values here win
// over anything parsed from OTEL_RESOURCE_ATTRIBUTES.
func WithResourceAttributes(attrs map[string]string) Option {
	return func(c *Config) {
		if c.ResourceAttributes == nil {
			c.ResourceAttributes = map[string]string{}
		}
		for k, v := range attrs {
			c.ResourceAttributes[k] = v
		}
	}
}

func WithoutRuntimeMetrics() Option { return func(c *Config) { c.DisableRuntimeMetrics = true } }
func WithoutStdoutLogs() Option     { return func(c *Config) { c.DisableStdoutLogs = true } }

// resolveConfig applies options, then fills gaps from the environment, then
// from defaults. Returns an error rather than panicking: the caller decides
// whether missing telemetry config is fatal.
func resolveConfig(opts ...Option) (*Config, error) {
	c := &Config{ResourceAttributes: map[string]string{}}
	for _, opt := range opts {
		opt(c)
	}

	if c.ServiceName == "" {
		c.ServiceName = os.Getenv("OTEL_SERVICE_NAME")
	}
	if c.ServiceName == "" {
		return nil, fmt.Errorf(
			"observability: service name is required — pass WithServiceName() or set OTEL_SERVICE_NAME")
	}

	if c.ServiceVersion == "" {
		c.ServiceVersion = firstNonEmpty(os.Getenv("OTEL_SERVICE_VERSION"), defaultServiceVersion)
	}
	if c.Environment == "" {
		c.Environment = firstNonEmpty(os.Getenv("OTEL_DEPLOYMENT_ENVIRONMENT"), defaultEnvironment)
	}
	if c.Endpoint == "" {
		c.Endpoint = firstNonEmpty(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"), defaultEndpoint)
	}
	c.Endpoint = strings.TrimSuffix(c.Endpoint, "/")

	// Env-provided attributes are the base layer; option-provided ones already
	// in the map must win, so only fill keys that are not already set.
	for k, v := range parseResourceAttributes(os.Getenv("OTEL_RESOURCE_ATTRIBUTES")) {
		if _, exists := c.ResourceAttributes[k]; !exists {
			c.ResourceAttributes[k] = v
		}
	}

	if c.MetricInterval <= 0 {
		c.MetricInterval = defaultMetricInterval
	}
	if c.LogLevel == "" {
		c.LogLevel = firstNonEmpty(os.Getenv("OTEL_LOG_LEVEL"), "info")
	}

	return c, nil
}

// parseResourceAttributes reads the W3C Baggage-style "k=v,k2=v2" format used
// by OTEL_RESOURCE_ATTRIBUTES. Malformed pairs are skipped rather than failing
// startup — a typo in one attribute should not cost you all telemetry.
func parseResourceAttributes(raw string) map[string]string {
	out := map[string]string{}
	if raw == "" {
		return out
	}
	for _, pair := range strings.Split(raw, ",") {
		key, value, found := strings.Cut(pair, "=")
		key = strings.TrimSpace(key)
		if !found || key == "" {
			continue
		}
		out[key] = strings.TrimSpace(value)
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
