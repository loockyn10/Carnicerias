# Rust via rustup, not apt: Debian 12's packaged rustc is older than this
# project's toolchain requirement. Force the i686 host explicitly because
# a 32-bit Docker userspace may still report an x86_64 host kernel.
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
    | sh -s -- -y \
      --profile minimal \
      --default-host i686-unknown-linux-gnu \
      --default-toolchain stable

ENV PATH="/root/.cargo/bin:${PATH}"

RUN rustup show active-toolchain \
    && rustc --version \
    && cargo --version

RUN cargo install tauri-cli --locked --version "^2.0.0"

WORKDIR /workspace
