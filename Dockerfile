FROM apify/actor-node-playwright-chrome:20

USER root
WORKDIR /usr/src/app

# Copy manifest files first (own to myuser) and install prod deps as myuser to avoid EACCES
COPY --chown=myuser:myuser package*.json ./
USER myuser
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Now app sources
USER root
COPY --chown=myuser:myuser . ./
USER myuser

CMD ["node","main.js"]
