FROM apify/actor-node-playwright-chrome:20

WORKDIR /usr/src/app

# Install deps as root to avoid EACCES, then hand over to myuser
USER root
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Copy the rest of the project
COPY . .

# Ensure ownership for runtime
RUN chown -R myuser:myuser /usr/src/app
USER myuser

# Apify will wrap with xvfb-run automatically. Do NOT add xvfb here.
CMD ["node", "main.js"]
