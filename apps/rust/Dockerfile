FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml ./
COPY Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/rust /usr/local/bin/server
ENV PORT=8080 DB_PATH=/tmp/bench.db
EXPOSE 8080
CMD ["server"]
