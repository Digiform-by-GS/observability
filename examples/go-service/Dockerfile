# Build context is the repo root, because the service depends on
# packages/observability-go via a `replace` directive:
#   docker compose build go-service
FROM golang:1.26.5-alpine AS build

WORKDIR /src

# Copy manifests first so dependency download is cached independently of source
# edits. Both modules are needed: the replace directive resolves at build time.
COPY packages/observability-go/go.mod packages/observability-go/go.sum ./packages/observability-go/
COPY examples/go-service/go.mod examples/go-service/go.sum ./examples/go-service/

COPY packages/observability-go/ ./packages/observability-go/
WORKDIR /src/examples/go-service
RUN go mod download

COPY examples/go-service/ ./

# Static build so the binary runs on a distroless/scratch base.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/go-service .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/go-service /go-service
USER nonroot:nonroot
EXPOSE 8090
ENTRYPOINT ["/go-service"]
