# Build: Frontend
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --prefer-offline
COPY frontend/ ./
RUN npm run build

# Build: Backend
FROM golang:1.23-alpine AS builder
WORKDIR /app/backend
# Copy Go module files first for layer caching
COPY backend/go.mod backend/go.sum ./
RUN go mod download
# Copy source and embedded assets
COPY backend/ ./
COPY --from=frontend /app/frontend/dist ./dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /server .

# Minimal runtime image
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /server /server
EXPOSE 8080
ENV PORT=8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/healthz || exit 1
CMD ["/server"]
