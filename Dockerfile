FROM apify/actor-node-playwright-chrome:20

# Workdir
WORKDIR /usr/src/app

# Install deps as root to avoid EACCES, then switch to myuser
USER root

COPY package*.json ./

# No postinstall, no playwright install needed (base image has browsers)
RUN npm install --omit=dev --no-audit --no-fund

# Copy app files
COPY . ./

# Ensure runtime user owns files
RUN chown -R myuser:myuser /usr/src/app

# Drop privileges
USER myuser

# Start
CMD ["node", "main.js"]