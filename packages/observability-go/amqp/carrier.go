// Package amqp carries OpenTelemetry context across RabbitMQ, which is the one
// place cross-service correlation has to be built rather than configured.
//
// The design decision that shapes everything here: consumers start a NEW trace
// carrying a LINK to the producer, rather than continuing the producer's trace
// as a child. See Consume for why.
package amqp

import (
	amqp091 "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel/propagation"
)

// HeaderCarrier adapts amqp091.Table to the TextMapCarrier interface so the
// standard W3C propagator can inject and extract traceparent.
//
// This is ~25 lines and it is the load-bearing piece of cross-service
// correlation over the broker. It is written here rather than pulled from a
// dependency because AMQP headers are map[string]interface{}, not
// map[string]string: a value can be any AMQP type, so Get MUST type-assert and
// return "" for a non-string rather than panicking on a malformed or
// third-party message. A publisher outside your control setting a numeric
// header must not crash your consumer.
type HeaderCarrier amqp091.Table

var _ propagation.TextMapCarrier = HeaderCarrier{}

// Get returns the value for key, or "" if absent or not a string.
func (c HeaderCarrier) Get(key string) string {
	value, ok := c[key]
	if !ok {
		return ""
	}
	// Deliberately tolerant: anything that is not a string is treated as absent.
	switch v := value.(type) {
	case string:
		return v
	case []byte:
		// Some clients write headers as byte slices.
		return string(v)
	default:
		return ""
	}
}

// Set stores key/value in the header table.
func (c HeaderCarrier) Set(key, value string) {
	c[key] = value
}

// Keys returns the header names present.
func (c HeaderCarrier) Keys() []string {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	return keys
}
