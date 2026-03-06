#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "==> Building: Frontend"
cd "$ROOT/frontend"
npm run build

echo "==> Embedding: Frontend"
rm -rf "$ROOT/backend/dist"
cp -r "$ROOT/frontend/dist" "$ROOT/backend/dist"

echo "==> Building: Linux"
cd "$ROOT/backend"
go build -o server .

echo "==> Building: Windows"
GOOS=windows GOARCH=amd64 go build -o server.exe .

echo "==> Building: MacOS"
GOOS=darwin GOARCH=amd64 go build -o server-macos .

echo ""
echo "Sequence Complete"
echo "Executables are in the backend/ folder"
