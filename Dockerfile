FROM apify/actor-node-playwright-chrome:20

WORKDIR /usr/src/app

# Install only production deps (browsers already included in the base image)
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Copy source
COPY . .

# Run as non-root user provided by the base image
USER myuser

# Default command
CMD ["node", "main.js"]