FROM rust:1.95.0-bookworm AS builder
WORKDIR /app
RUN apt-get update \
  && env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential \
    libssl-dev \
    perl \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.toml
COPY Cargo.lock Cargo.lock
RUN mkdir -p src/
RUN echo "fn main() {println!(\"failed to build\")}" > src/main.rs
RUN cargo build --release --locked
RUN rm -f target/release/deps/rustypaste*
COPY . .
RUN cargo build --release --locked
RUN mkdir -p build-out/
RUN cp target/release/rustypaste build-out/

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update \
  && env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/build-out/rustypaste .
ENV SERVER__ADDRESS=0.0.0.0:8000
EXPOSE 8000
CMD ["./rustypaste"]
