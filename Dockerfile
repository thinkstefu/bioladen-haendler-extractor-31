FROM apify/actor-node-playwright-chrome:20

# Workdir
WORKDIR /usr/src/app

# Install production deps as root (base image uses non-root by default)
USER root
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Copy the rest of the app
COPY . .

# Fix ownership for runtime user
RUN chown -R myuser:myuser /usr/src/app

# Drop privileges
USER myuser

# Ensure Playwright uses preinstalled browsers from the base image
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/lib/playwright
ENV APIFY_HEADLESS=1

# Start the actor (single xvfb-run)
CMD ["xvfb-run","-a","-s","-ac -screen 0 1920x1080x24+32 -nolisten tcp","node","main.js"]
