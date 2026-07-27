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

USER opsshield
EXPOSE 3000
CMD ["node", "src/index.js"]
