# Apify base image with Playwright + Chrome (Node 20)
FROM apify/actor-node-playwright-chrome:20

# Work directory
WORKDIR /usr/src/app

# Only copy package files first (better layer caching)
COPY package*.json ./

# Install production deps as root to avoid EACCES in CI
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Copy the rest of the code
COPY . .

# Default command (Apify will override to "node main.js" if not present, but we keep it explicit)
CMD ["node", "main.js"]
