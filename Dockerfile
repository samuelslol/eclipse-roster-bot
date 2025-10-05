# Multi-stage build (smaller final image)
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies separately for better caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Environment variables (do NOT bake secrets here)
# Discord token will be provided via Fly secrets.
ENV NODE_ENV=production

# Start the bot
CMD ["node", "index.js"]
