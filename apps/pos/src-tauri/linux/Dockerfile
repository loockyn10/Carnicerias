# Native Debian 12 (Bookworm) i386 build environment for Carnicerías POS.
#
# We build NATIVELY inside a linux/386 container instead of cross-compiling
# from x86_64. Tauri links against WebKitGTK/GTK3 via pkg-config at compile
# time, and cross-compiling those C bindings from a different architecture
# is fragile. Running the container itself as i386 (via Docker's --platform
# flag, QEMU-emulated when the host is not x86/i386) makes the container's
# native toolchain triple equal to the target triple (i686-unknown-linux-gnu),
# so this is a normal native build, not a cross build.
#
# This image only ever runs on the build machine / CI. It never runs on the
# netbook: the netbook only receives and installs the resulting .deb.
FROM --platform=linux/386 debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    wget \
    file \
    git \
    ca-certificates \
    pkg-config \
    libwebkit2gtk-4.1-dev \
    libjavascriptcoregtk-4.1-dev \
    libsoup-3.0-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libssl-dev \
    libxdo-dev \
  && rm -rf /var/lib/apt/lists/*

# Rust via rustup, not apt: Debian 12's packaged rustc is older than this
# project's toolchain requirement. Running inside an i386 container means
# rustup's default host triple is already i686-unknown-linux-gnu.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

RUN cargo install tauri-cli --locked --version "^2.0.0"

WORKDIR /workspace
