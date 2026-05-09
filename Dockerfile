# Multi-stage build for Jellybean.
#
# Stage 1 builds both Vite web apps. Stage 2 builds the Go binary with the
# web dist embedded. Stage 3 is the runtime; distroless static is the
# default but RUNTIME_BASE can be swapped (e.g. to alpine) for debugging.

ARG RUNTIME_BASE=gcr.io/distroless/static-debian12:nonroot
ARG GO_VERSION=1.25
ARG NODE_VERSION=20

# -- Stage 1: web ----------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS web

WORKDIR /web
# Workspace install: root package.json + lockfile + each workspace's package.json,
# then a single npm ci. Hoisted node_modules sits at the repo root.
COPY package.json package-lock.json ./
COPY web/admin/package.json web/admin/package.json
COPY web/kids/package.json web/kids/package.json
RUN npm ci --no-audit --no-fund

COPY web/admin/ web/admin/
COPY web/kids/ web/kids/
RUN npm run build --workspaces

# -- Stage 2: go -----------------------------------------------------------
FROM golang:${GO_VERSION}-alpine AS gobuild

WORKDIR /src
COPY go.mod go.sum ./
RUN GOWORK=off go mod download

COPY . .
COPY --from=web /web/web/admin/dist ./web/admin/dist
COPY --from=web /web/web/kids/dist ./web/kids/dist

ARG TARGETOS=linux
ARG TARGETARCH
RUN GOWORK=off CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/jellybean ./cmd/jellybean

# -- Stage 3: runtime ------------------------------------------------------
FROM ${RUNTIME_BASE}

COPY --from=gobuild /out/jellybean /jellybean

ENV JELLYBEAN_PORT=8080 \
    JELLYBEAN_DB_PATH=/var/lib/jellybean/jellybean.db
EXPOSE 8080
VOLUME ["/var/lib/jellybean"]

# distroless ships a nonroot user (uid 65532); the binary listens on a
# non-privileged port so this is fine.
USER 65532:65532

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/jellybean", "healthcheck"]

ENTRYPOINT ["/jellybean"]
