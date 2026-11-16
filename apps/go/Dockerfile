FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum* ./
COPY main.go ./
# Résout modernc.org/sqlite si go.sum n'est pas encore commité
RUN go mod tidy && CGO_ENABLED=0 go build -o /server .

FROM alpine:3.20
COPY --from=build /server /usr/local/bin/server
ENV PORT=8080 DB_PATH=/tmp/bench.db
EXPOSE 8080
CMD ["server"]
