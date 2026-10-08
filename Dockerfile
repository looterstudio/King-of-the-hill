FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data STATIC_DIR=/app/dist
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY shared ./shared
COPY server ./server
VOLUME /data
EXPOSE 8787
CMD ["npx", "tsx", "server/src/index.ts"]
