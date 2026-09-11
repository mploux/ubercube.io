FROM oven/bun:1.3.11
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun src/server ./src/server
COPY --chown=bun:bun src/shared ./src/shared
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER bun
EXPOSE 3000
CMD ["bun", "src/server/index.ts"]
