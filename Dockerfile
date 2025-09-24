FROM apify/actor-node-playwright-chrome:20

# Install as root, copy manifests first for better caching
USER root
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Copy the app
COPY . .

# Fix ownership for runtime user
RUN chown -R myuser:myuser /usr/src/app

# Drop privileges
USER myuser

# Apify wraps with xvfb-run automatically on the platform, just run node
CMD ["node", "main.js"]
