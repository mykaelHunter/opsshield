FROM node:20-alpine AS base
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM base AS build
RUN npm ci
COPY . .
RUN npx prisma generate

FROM node:20-alpine AS production
RUN apk add --no-cache openssl 
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S opsshield -u 1001
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./

# The base image ships a full global npm install (with its own vendored
# deps, e.g. tar) for build-time use — this container only ever runs
# `node src/index.js`, never npm/npx, so it's dead weight that does
# nothing but widen the CVE surface Trivy scans (see CVE-2026-59873,
# a critical DoS in npm's bundled tar via crafted gzip input — not
# reachable here, but easier to remove than to justify an exception for).
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

USER opsshield
EXPOSE 3000
CMD ["node", "src/index.js"]
