#!/usr/bin/env bash
#
# Idempotent installations-script til WP Community Wallboard på Raspberry Pi
# (Raspberry Pi OS / Debian-baseret). Trygt at køre flere gange — hvert trin
# tjekker sin egen tilstand, før det ændrer noget.
#
# Kør som root: sudo ./install.sh
set -euo pipefail

APP_DIR="/opt/wallboard"
DATA_DIR="/var/lib/wallboard"
SERVICE_USER="wallboard"
SERVICE_NAME="wallboard"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[1;33m! \033[0m%s\n' "$1"; }
err()  { printf '    \033[1;31m✗ \033[0m%s\n' "$1" >&2; }

if [ "$(id -u)" -ne 0 ]; then
	err "Scriptet skal køres som root — prøv: sudo ./install.sh"
	exit 1
fi

# ---- 1. Arkitektur ----------------------------------------------------

log "1/11 Kontrollerer arkitektur"
ARCH="$(uname -m)"
case "$ARCH" in
	armv7l|aarch64|arm64)
		ok "Understøttet ARM-arkitektur registreret: ${ARCH}"
		;;
	*)
		warn "Uventet arkitektur '${ARCH}' — scriptet er lavet til Raspberry Pi (armv7l/aarch64), men fortsætter."
		;;
esac

# ---- 2. Node.js ---------------------------------------------------------

log "2/11 Kontrollerer Node.js"
NODE_MIN_MAJOR=18
if command -v node >/dev/null 2>&1; then
	NODE_VERSION="$(node -v)"
	NODE_MAJOR="$(echo "$NODE_VERSION" | sed -E 's/^v([0-9]+).*/\1/')"
	if [ "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ]; then
		ok "Node.js ${NODE_VERSION} fundet (kræver >= v${NODE_MIN_MAJOR})"
	else
		err "Node.js ${NODE_VERSION} er for gammel — kræver >= v${NODE_MIN_MAJOR}."
		echo "    Installér en nyere version, fx:"
		echo "      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
		echo "      sudo apt-get install -y nodejs"
		echo "    Kør derefter dette script igen."
		exit 1
	fi
else
	err "Node.js blev ikke fundet."
	echo "    Installér Node.js 18 eller nyere, fx:"
	echo "      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
	echo "      sudo apt-get install -y nodejs"
	echo "    Kør derefter dette script igen."
	exit 1
fi

# ---- 3. Kopiér applikationen + produktionsafhængigheder ------------------

log "3/11 Installerer applikationsfiler i ${APP_DIR}"
mkdir -p "$APP_DIR"

RSYNC_EXCLUDES=(--exclude ".git" --exclude "node_modules" --exclude ".env")
if command -v rsync >/dev/null 2>&1; then
	rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$SCRIPT_DIR"/ "$APP_DIR"/
else
	warn "rsync ikke fundet — bruger cp (mindre præcis oprydning af fjernede filer)."
	find "$SCRIPT_DIR" -maxdepth 1 -mindepth 1 \
		! -name ".git" ! -name "node_modules" ! -name ".env" \
		-exec cp -a {} "$APP_DIR"/ \;
fi
ok "Filer kopieret til ${APP_DIR}"

log "Installerer produktionsafhængigheder (npm)"
if [ -f "$APP_DIR/package.json" ]; then
	(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --silent)
	ok "npm install gennemført (projektet har ingen eksterne runtime-dependencies)"
fi

# ---- 4. Dedikeret systembruger --------------------------------------------

log "4/11 Opretter systembruger '${SERVICE_USER}'"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
	ok "Brugeren '${SERVICE_USER}' findes allerede"
else
	useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin --no-create-home "$SERVICE_USER"
	ok "Bruger '${SERVICE_USER}' oprettet"
fi

# ---- 5. Datamappe (cache) -------------------------------------------------

log "5/11 Opretter datamappe ${DATA_DIR}"
mkdir -p "$DATA_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"
ok "${DATA_DIR} klar (ejes af ${SERVICE_USER}, 750)"

chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# ---- 6. .env med korrekte rettigheder -------------------------------------

log "6/11 Sikrer .env"
if [ ! -f "$APP_DIR/.env" ]; then
	cp "$APP_DIR/.env.example" "$APP_DIR/.env"
	warn "Ingen .env fandtes — .env.example er kopieret ind. UDFYLD WP_USERNAME/WP_APPLICATION_PASSWORD/WP_BASE_URL før servicen startes i live-tilstand."
else
	ok ".env findes allerede — rørt ikke ved indholdet"
fi
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
ok ".env rettigheder sat til 600 (kun ${SERVICE_USER} kan læse den)"

# ---- 7. systemd-service ----------------------------------------------------

log "7/11 Installerer systemd-servicen"
cp "$APP_DIR/deployment/wallboard.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
ok "Service-fil installeret i /etc/systemd/system/${SERVICE_NAME}.service"

# ---- 8. Nginx ---------------------------------------------------------------

log "8/11 Installerer/konfigurerer Nginx"
if ! command -v nginx >/dev/null 2>&1; then
	log "Nginx ikke fundet — installerer via apt"
	apt-get update -qq
	apt-get install -y -qq nginx
	ok "Nginx installeret"
else
	ok "Nginx findes allerede"
fi

cp "$APP_DIR/deployment/nginx-wallboard.conf" "/etc/nginx/sites-available/${SERVICE_NAME}"
ln -sf "/etc/nginx/sites-available/${SERVICE_NAME}" "/etc/nginx/sites-enabled/${SERVICE_NAME}"

# Standard-sitet på Debian/Raspberry Pi OS lytter også på port 80 og vil
# ellers kollidere med wallboard-sitet.
if [ -e "/etc/nginx/sites-enabled/default" ]; then
	rm -f "/etc/nginx/sites-enabled/default"
	ok "Standard-Nginx-sitet (port 80-konflikt) er deaktiveret"
fi

if nginx -t >/dev/null 2>&1; then
	ok "Nginx-konfiguration er gyldig"
else
	err "Nginx-konfigurationstest fejlede — kør 'nginx -t' manuelt for detaljer."
	exit 1
fi

# ---- 9. Aktivér ved boot ----------------------------------------------------

log "9/11 Aktiverer services ved boot og (gen)starter dem"
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"
systemctl enable nginx >/dev/null
systemctl restart nginx
ok "${SERVICE_NAME}.service og nginx er aktiveret og (gen)startet"

# ---- 10. Test /health --------------------------------------------------

log "10/11 Tester /health"
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | tail -n1 | cut -d= -f2)"
PORT="${PORT:-3000}"

health_ok=false
for _ in $(seq 1 15); do
	if curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
		health_ok=true
		break
	fi
	sleep 2
done

if [ "$health_ok" = true ]; then
	ok "Wallboard-servicen svarer på http://127.0.0.1:${PORT}/health"
else
	warn "Servicen svarede ikke på /health inden for 30 sekunder."
	warn "Tjek logs med: journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
fi

if curl --silent --fail --max-time 2 "http://127.0.0.1/health" >/dev/null 2>&1; then
	ok "Nginx-proxyen svarer på http://127.0.0.1/health"
else
	warn "Nginx-proxyen svarede ikke på http://127.0.0.1/health — tjek 'systemctl status nginx'."
fi

# ---- 11. Næste trin ---------------------------------------------------------

log "11/11 Installation færdig — næste trin"
cat <<EOF

  1. Udfyld rigtige WordPress-oplysninger i:
       ${APP_DIR}/.env
     (WP_BASE_URL, WP_USERNAME, WP_APPLICATION_PASSWORD — se .env.example)
     Genstart derefter servicen:
       sudo systemctl restart ${SERVICE_NAME}

  2. Test wallboardet i en browser på selve Pi'en:
       http://127.0.0.1/

  3. Sæt kiosk-mode op (Chromium i fuld skærm ved login) — se README.md,
     afsnittet "Kiosk mode", som bruger:
       ${APP_DIR}/deployment/kiosk-autostart.sh

  4. Følg og administrér servicen:
       sudo systemctl status ${SERVICE_NAME}
       journalctl -u ${SERVICE_NAME} -f
     (kan også gøres via Cockpit, https://<denne-pi>:9090/)

  5. LAN-adgang er slået FRA som standard. Se README.md, afsnittet
     "LAN-adgang", hvis wallboardet skal kunne ses fra andre enheder på
     netværket.

EOF
