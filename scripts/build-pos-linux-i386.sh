#!/usr/bin/env bash
# Builds carnicerias-pos_<version>_i386.deb for Debian 12 (Bookworm) i386.
#
# Two-stage pipeline:
#   1. Frontend (React/Vite) is built HERE, on the host, with the repo's
#      normal Node/pnpm toolchain. Debian 12 i386 ships Node 18 by default,
#      which is below Vite 7's requirement (Node >=20.19/>=22.12), so the
#      frontend is never built inside the target container or on the netbook.
#   2. The Rust/Tauri binary and the .deb are built natively inside a
#      Debian 12 linux/386 Docker container (see linux/Dockerfile), so the
#      compiled binary and its dynamic links match the target OS exactly.
#
# The netbook that runs the POS only ever receives the resulting .deb file
# and installs it with apt/dpkg. It needs no Node, pnpm, Rust, Cargo, or
# source code.
#
# Requirements on the build machine: pnpm, Docker with buildx/QEMU support
# for linux/386 (Docker Desktop provides this out of the box; on plain
# Linux install the qemu-user-static + binfmt-support packages).
#
# Usage:
#   pnpm build:pos:linux:i386
#   ./scripts/build-pos-linux-i386.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POS_DIR="$ROOT_DIR/apps/pos"
TAURI_DIR="$POS_DIR/src-tauri"
DOCKERFILE="$TAURI_DIR/linux/Dockerfile"
IMAGE_TAG="carnicerias-pos-i386-builder"
RUST_TARGET="i686-unknown-linux-gnu"

echo "==> [1/3] Building the POS frontend on the host (Node/pnpm)"
pnpm --filter @carnicerias/pos build:web

echo "==> [2/3] Building the Debian 12 i386 build image (cached after first run)"
docker build \
  --platform linux/386 \
  -f "$DOCKERFILE" \
  -t "$IMAGE_TAG" \
  "$TAURI_DIR/linux"

echo "==> [3/3] Compiling the Rust/Tauri binary and packaging the .deb inside the container"
docker run --rm \
  --platform linux/386 \
  -v "$ROOT_DIR:/workspace" \
  -v "carnicerias-pos-cargo-registry:/root/.cargo/registry" \
  -v "carnicerias-pos-cargo-git:/root/.cargo/git" \
  -w /workspace/apps/pos/src-tauri \
  "$IMAGE_TAG" \
  cargo tauri build --target "$RUST_TARGET" --bundles deb

DEB_DIR="$TAURI_DIR/target/$RUST_TARGET/release/bundle/deb"
echo ""
echo "==> Done. Debian package:"
find "$DEB_DIR" -maxdepth 1 -name "*.deb" -exec echo "    {}" \; 2>/dev/null || \
  echo "    (not found under $DEB_DIR — check the build log above)"
