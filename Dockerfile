# Apify Actor using Playwright + Chrome (Node 20)
FROM apify/actor-node-playwright-chrome:20

# Workdir
WORKDIR /usr/src/app

# Install deps as root to avoid EACCES on node_modules, then hand off to myuser
USER root
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Add the rest
COPY . .

# Ownership back to myuser (non-root runtime user in apify image)
RUN chown -R myuser:myuser /usr/src/app
USER myuser

# Default command
CMD ["xvfb-run","-a","-s","-ac -screen 0 1920x1080x24+32 -nolisten tcp","node","main.js"]
