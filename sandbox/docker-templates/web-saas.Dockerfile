FROM node:20-alpine
RUN npm install -g pnpm tsx typescript eslint
RUN apk add --no-cache git curl bash
RUN addgroup -S app && adduser -S app -G app
WORKDIR /workspace
RUN chown -R app:app /workspace
USER app
HEALTHCHECK --interval=30s --timeout=3s CMD node --version || exit 1
