FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
COPY webview-ui/package*.json ./webview-ui/
RUN npm ci && cd webview-ui && npm ci

COPY . .

RUN npm run build:standalone

FROM node:22-alpine
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules

EXPOSE 19100

CMD ["node", "dist/server/standalone.js"]
