FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY src ./src
ENV PORT=8080 DB_PATH=/tmp/bench.db
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
