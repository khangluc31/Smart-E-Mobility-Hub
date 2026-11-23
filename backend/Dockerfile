# ---- Build stage (build context = repo root) ----
FROM node:22-slim AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY backend/prisma ./backend/prisma/

RUN npm ci -w backend --include-workspace-root=false --ignore-scripts && \
    npx prisma generate --schema=backend/prisma/schema.prisma

COPY backend/tsconfig.json backend/tsconfig.build.json ./backend/
COPY backend/src ./backend/src/

RUN npm run build -w backend

# ---- Runtime stage ----
FROM node:22-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Create a non-root user with a writable home directory
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 --ingroup appgroup --home /home/appuser appuser

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY backend/prisma ./backend/prisma/

# prisma is in dependencies so prisma generate and runtime
# `npx prisma migrate deploy` use the installed CLI without network downloads.
RUN npm ci -w backend --include-workspace-root=false --omit=dev --ignore-scripts && \
    npx prisma generate --schema=backend/prisma/schema.prisma

COPY --from=builder /app/backend/dist ./backend/dist/

RUN chown -R appuser:appgroup /app /home/appuser

ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:/app/backend/node_modules/.bin:${PATH}"

WORKDIR /app/backend

USER appuser

EXPOSE 3000

# Apply migrations then start the server (D-02: exactly one instance)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
