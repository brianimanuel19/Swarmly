FROM node:20-alpine

WORKDIR /app

# Install git (needed for repo cloning) and pnpm
RUN apk add --no-cache git && npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

EXPOSE 3001

CMD ["pnpm", "start"]
