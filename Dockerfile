FROM apify/actor-node-playwright-chrome:20

# Arbeitsverzeichnis & Rechte so setzen, dass npm ohne EACCES läuft
USER root
WORKDIR /usr/src/app

# Zuerst nur package-Dateien kopieren und als myuser besitzen lassen
COPY --chown=myuser:myuser package*.json ./

# Als nicht-root installieren, damit node_modules myuser gehören
USER myuser
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Restliche Quellen kopieren
COPY --chown=myuser:myuser . ./

# Start
CMD ["xvfb-run","-a","-s","-ac -screen 0 1920x1080x24+32 -nolisten tcp","node","main.js"]
