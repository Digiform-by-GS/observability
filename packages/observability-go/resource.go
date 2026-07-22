package observability

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.30.0"
)

// deploymentEnvironment is spelled to match what the OTel Collector's resource
// processor inserts and what the Grafana dashboards filter on. Keeping the Go,
// Node, and collector spellings identical is what makes one dashboard variable
// work across every service.
const deploymentEnvironmentKey = attribute.Key("deployment.environment")

func buildResource(ctx context.Context, cfg *Config) (*resource.Resource, error) {
	attrs := []attribute.KeyValue{
		semconv.ServiceName(cfg.ServiceName),
		semconv.ServiceVersion(cfg.ServiceVersion),
		deploymentEnvironmentKey.String(cfg.Environment),
	}
	for k, v := range cfg.ResourceAttributes {
		attrs = append(attrs, attribute.String(k, v))
	}

	// Note: resource detectors are deliberately NOT enabled by default. The
	// collector runs `resource_to_telemetry_conversion: enabled`, which promotes
	// every resource attribute to a metric label — so each detected attribute
	// multiplies the series count. Add detectors consciously, and check Mimir's
	// series count before and after.
	return resource.New(ctx,
		resource.WithSchemaURL(semconv.SchemaURL),
		resource.WithAttributes(attrs...),
	)
}
