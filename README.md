# WP Community Wallboard

En let, driftssikker wallboard-/infoskærmsløsning til Raspberry Pi 3, der viser
igangværende opgaver, dagens afsluttede opgaver og kommende vagter — uden
personfølsomme detaljer. Data hentes fra WordPress-pluginerne **WP Core** og
**WP Operations** via deres REST-API (`/wp-json/wp-community/v1`).

Løsningen består af to dele, leveret fra samme origin (ingen CORS):

1. **`frontend/`** — statisk HTML5/CSS/vanilla JS. Ingen build-proces, ingen
   frameworks, ingen CDN-afhængigheder. Optimeret til Chromium kiosk-mode på
   en Raspberry Pi 3.
2. **`server/`** — en meget let Node.js-service (ingen eksterne
   dependencies), der henter data fra WordPress, sanerer/minimerer det til ét
   enkelt endpoint (`GET /api/wallboard`), cacher senest fungerende svar, og
   **aldrig** sender WordPress-credentials til browseren.

## Relaterede repositories

| Repo | Formål |
|---|---|
| [jesperlowe/Wp-Community-Wallboard](https://github.com/jesperlowe/Wp-Community-Wallboard) | Dette repo — wallboard-frontend + lokal API-proxy. |
| [jesperlowe/Community_WPCore](https://github.com/jesperlowe/Community_WPCore) | WordPress-basisplugin: auth (Application Passwords), REST-infrastruktur (`WPC_API`), namespace `wp-community/v1`. |
| [jesperlowe/Community_WPOperations](https://github.com/jesperlowe/Community_WPOperations) | WordPress-plugin: opgaver (`/tasks`) og vagter (`/shifts`) — de faktiske endpoints wallboardet henter data fra. |

## Filstruktur

```
frontend/            Statisk frontend (index.html, styles.css, app.js, status-map.js)
server/               Node.js-service: server.js, wordpress-adapter.js, cache.js, mock-data.js, config.js, time.js
test/                 node:test-tests (npm test)
deployment/           systemd-unit, Nginx-konfiguration, kiosk-autostart.sh
.env.example          Skabelon for konfiguration
install.sh             Idempotent installations-script til Raspberry Pi
```

## Hurtig start (uden WordPress — mock-mode)

```bash
npm test                 # kør testsuiten
API_MODE=mock npm start  # start serveren med realistiske danske mock-data
```

Åbn `http://127.0.0.1:3000/` i en browser. Wallboardet fungerer fuldt ud uden
forbindelse til WordPress i denne tilstand — nyttigt til udvikling og til at
teste layoutet før første udrulning.

## Konfiguration (`.env`)

Kopiér `.env.example` til `.env` og udfyld:

| Variabel | Beskrivelse |
|---|---|
| `PORT` | Port Node-serveren lytter på (kun `127.0.0.1`, se nedenfor). |
| `WP_BASE_URL` | WordPress-sitets base-URL. Skal være HTTPS for eksterne hosts — `http://` afvises, undtagen for `localhost`/`127.0.0.1`/`*.local` til udvikling. |
| `WP_API_NAMESPACE` | REST-namespace, normalt `/wp-json/wp-community/v1`. |
| `WP_USERNAME` / `WP_APPLICATION_PASSWORD` | En dedikeret WordPress-bruger (fx `wallboard`) med et Application Password og `wpc_access_app`-rettigheden. Opret det under brugerens profil i wp-admin. |
| `TIMEZONE` | IANA-tidszone, bruges til at kombinere vagters dato+klokkeslæt til korrekt ISO 8601 og til "afsluttet i dag"-filtrering. |
| `REFRESH_SECONDS` | Hvor ofte serveren henter nye data fra WordPress, og hvor ofte frontenden poller `/api/wallboard`. |
| `COMPLETED_TASK_LIMIT` | Maks. antal opgaver i "Afsluttet i dag". |
| `COMPLETED_LOOKBACK_HOURS` | En afsluttet opgave vises hvis den er afsluttet i dag ELLER inden for dette antal timer. |
| `SHIFT_LOOKAHEAD_HOURS` | Hvor langt frem i tiden der hentes vagter. |
| `SHOW_ASSIGNEES` | `false` udelader `assignedNames` fra opgaver helt (ikke bare en tom liste). |
| `ARRANGEMENT_ID` | Valgfri — begræns til ét arrangement, hvis WP-installationen understøtter parameteren. |
| `API_MODE` | `mock` for udvikling uden WordPress, ellers `live` (default). |

**Credentials ligger udelukkende i `.env` på Raspberry Pi'en.** De sendes
aldrig til browseren, returneres aldrig fra `/api/wallboard` eller `/health`,
logges aldrig, og vises aldrig på en fejlskærm — se `server/wordpress-adapter.js`,
som udelukkende bygger sit output via allowlisting (aldrig `{...raw}`).

## API-kontrakt

### `GET /api/wallboard`

```json
{
  "generatedAt": "2026-07-14T12:30:00+02:00",
  "stale": false,
  "sourceStatus": "online",
  "cacheAgeSeconds": 0,
  "tasks": {
    "inProgress": [
      { "id": 123, "taskNumber": "WPC-0123", "title": "Levering", "status": "in_progress",
        "startedAt": "2026-07-14T11:45:00+02:00", "assignedNames": ["Navn"] }
    ],
    "completed": [
      { "id": 122, "taskNumber": "WPC-0122", "title": "Afhentning", "status": "completed",
        "completedAt": "2026-07-14T11:30:00+02:00", "assignedNames": ["Navn"] }
    ]
  },
  "shifts": [
    { "id": 45, "title": "Aftenvagt", "startTime": "2026-07-14T18:00:00+02:00",
      "endTime": "2026-07-14T22:00:00+02:00", "status": "open" }
  ]
}
```

`stale: true` betyder data kommer fra disk-cachen (`/var/lib/wallboard/cache.json`),
fordi WordPress lige nu er utilgængeligt — `cacheAgeSeconds` fortæller hvor
gammel den cachede data er. `assignedNames` udelades helt fra en opgave når
`SHOW_ASSIGNEES=false`.

### `GET /health`

```json
{ "status": "ok", "mode": "live", "lastFetchOk": true, "lastFetchAt": "2026-07-14T10:30:00.000Z", "uptimeSeconds": 3600 }
```

Bruges af `deployment/kiosk-autostart.sh` til at vente med at åbne browseren,
til servicen rent faktisk er klar.

## Installation på Raspberry Pi

Denne guide går fra en tom SD-kortimage til en kørende wallboard, inklusiv
headless-opsætning (uden skærm/tastatur tilsluttet Pi'en under selve
installationen) og Cockpit til drift/administration.

**Forudsætninger**: en Raspberry Pi 3 (eller nyere), et SD-kort, og en anden
computer (Mac/Windows/Linux) til at flashe kortet og SSH'e ind.

### 1. Flash Raspberry Pi OS og aktivér headless-adgang

1. Installér [Raspberry Pi Imager](https://www.raspberrypi.com/software/) på
   din computer.
2. Vælg OS: **Raspberry Pi OS Lite (64-bit)** — der skal ikke bruges et
   fuldt skrivebordsmiljø til selve wallboard-servicen, kun til den skærm der
   senere skal vise Chromium i kiosk-mode (se afsnittet "Kiosk mode"
   nedenfor — hvis Pi'en SKAL vise kiosk-browseren selv, vælg i stedet
   **Raspberry Pi OS (64-bit)** med skrivebord).
3. Klik på tandhjulet/"Rediger indstillinger" (Ctrl+Shift+X i nyere Imager)
   FØR du flasher, og sæt:
   - Hostname, fx `wallboard.local`
   - Aktivér SSH (med adgangskode eller din SSH-nøgle)
   - Brugernavn/adgangskode
   - Evt. WiFi-SSID/kodeord, hvis Pi'en ikke sidder på kabel
4. Flash kortet, sæt det i Pi'en, og tænd den. Efter ca. et minut kan du
   SSH'e ind fra din egen computer:

   ```bash
   ssh <dit-brugernavn>@wallboard.local
   ```

### 2. Opdatér systemet og installér Git

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git curl
```

### 3. Installér Cockpit (til drift/administration af selve Pi'en)

Cockpit giver dig et webbaseret administrationspanel til en headless Pi —
systemressourcer, service-styring og logs, uden at skulle SSH'e ind hver
gang. Den er ikke en del af selve wallboardet og skal installeres separat:

```bash
sudo apt install -y cockpit
sudo systemctl enable --now cockpit.socket
```

Cockpit lytter som standard på port 9090 på alle interfaces. Åbn den fra en
browser på en ANDEN computer på samme netværk:

```
https://wallboard.local:9090/
```

(Browseren advarer om et selvsigneret certifikat første gang — det er
forventet for en lokal Cockpit-installation; accepter undtagelsen.) Log ind
med det Linux-brugernavn/-adgangskode du satte i Raspberry Pi Imager.

Hvis du bruger `ufw` som firewall, skal porten åbnes eksplicit:

```bash
sudo ufw allow 9090/tcp
```

### 4. Installér Node.js ≥ 18

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # skal vise v20.x eller nyere
```

### 5. Hent wallboard-koden

```bash
git clone https://github.com/jesperlowe/Wp-Community-Wallboard.git wallboard
cd wallboard
```

### 6. Kør installations-scriptet

```bash
sudo ./install.sh
```

`install.sh` er idempotent — den kan køres igen efter opdateringer (fx efter
`git pull`) uden at ødelægge en eksisterende `.env` eller igangværende
service. Den:

1. Kontrollerer arkitektur og Node.js-version.
2. Kopierer koden til `/opt/wallboard` og installerer produktionsafhængigheder.
3. Opretter en dedikeret, rettighedsbegrænset systembruger `wallboard`.
4. Opretter `/var/lib/wallboard` (cache) med korrekte rettigheder.
5. Sikrer `.env` (600, kun ejet af `wallboard`-brugeren).
6. Installerer og aktiverer `wallboard.service` (systemd).
7. Installerer/konfigurerer Nginx som reverse proxy på `127.0.0.1:80`.
8. Tester `/health` og udskriver klare næste trin.

### 7. Udfyld WordPress-credentials

```bash
sudo nano /opt/wallboard/.env
```

Udfyld `WP_BASE_URL`, `WP_USERNAME` og `WP_APPLICATION_PASSWORD` (opret et
Application Password til en dedikeret `wallboard`-bruger med kun
`wpc_access_app`-rettigheden i wp-admin → Brugere → din profil). Genstart
derefter servicen:

```bash
sudo systemctl restart wallboard
curl http://127.0.0.1/health
```

### 8. Opdatering senere

```bash
cd ~/wallboard
git pull
sudo ./install.sh
```

## Kiosk mode

`deployment/kiosk-autostart.sh` venter på `/health`, finder enten `chromium`
eller `chromium-browser`, og starter den i fuld skærm (`--kiosk`) mod
`http://127.0.0.1/` — uden browsermenuer, fejl-dialoger eller
session-genoprettelses-prompts, og genstarter browseren automatisk hvis den
lukker. Skærmslukning/pauseskærm slås fra (`xset`).

Sæt den op til at køre ved login på Raspberry Pi OS' skrivebordsmiljø (LXDE),
fx via autostart-filen for din bruger:

```bash
mkdir -p ~/.config/lxsession/LXDE-pi
cat >> ~/.config/lxsession/LXDE-pi/autostart <<'EOF'
@/opt/wallboard/deployment/kiosk-autostart.sh
EOF
```

Aktivér også automatisk login til skrivebordet via `sudo raspi-config`
(System Options → Boot / Auto Login → Desktop Autologin).

Wallboardet er **ikke** afhængigt af at Cockpit er åbent — kiosk-scriptet
rører kun ved browseren, ikke wallboard-servicen (den styres af systemd
uafhængigt af enhver desktop-session).

### Kiosk mode uden skrivebordsmiljø (Raspberry Pi OS Lite)

Kører Pi'en headless (`Raspberry Pi OS Lite`, `systemctl get-default` viser
`multi-user.target`), er der intet X11/skrivebord til `LXDE-pi/autostart`
ovenfor. Et fuldt skrivebordsmiljø er unødvendigt tungt til at vise én
fastlåst browser — brug i stedet [`cage`](https://github.com/cage-kiosk/cage),
en minimal Wayland-kiosk-compositor lavet præcis til dette formål:

```bash
sudo apt update
sudo apt install -y cage chromium
sudo raspi-config   # System Options → Boot / Auto Login → Console Autologin

cat >> ~/.bash_profile <<'EOF'
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
  exec cage -- /opt/wallboard/deployment/kiosk-autostart.sh
fi
EOF

sudo reboot
```

Debians/Raspberry Pi OS' `cage`-pakke er **ikke** bygget med
Xwayland-understøttelse (der findes intet `-X`-flag — `cage -h` viser kun
`-d`/`-h`/`-m`/`-s`/`-v`), så Chromium kører nativt på Wayland i stedet.
`kiosk-autostart.sh` opdager selv, at den kører under cage (via
`$WAYLAND_DISPLAY`, som cage sætter for sit client-process) og tilføjer
automatisk `--ozone-platform=wayland` — ingen manuel flag-håndtering
nødvendig. Ved at pege cage på `kiosk-autostart.sh` (i stedet for Chromium
direkte) genbruges hele `/health`-ventelogikken,
chromium/chromium-browser-detektionen og genstarts-løkken uændret, for
begge kiosk-veje (X11/LXDE og Wayland/cage).

`xset`-kaldene i `kiosk-autostart.sh` er X11-specifikke og fejler stille
(`|| true`) under Wayland/cage — tilføj i stedet `consoleblank=0` til
`/boot/firmware/cmdline.txt` for at forhindre skærmen i at gå i sort.

For at komme tilbage til en terminal: SSH ind udefra (upåvirket af tty1's
session) — `pkill cage` stopper kiosken, og tty1 logger automatisk ind og
starter den igen (`.bash_profile`s `exec`-linje kører igen).

## LAN-adgang

Som standard er wallboardet kun tilgængeligt på selve Raspberry Pi'en
(`http://127.0.0.1/`) — Nginx binder eksplicit kun til loopback-interfacet.
For at gøre det tilgængeligt for andre enheder på det lokale netværk:

1. Rediger `/etc/nginx/sites-available/wallboard`: ændr
   `listen 127.0.0.1:80;` til `listen 80;` (alle interfaces) eller en
   specifik LAN-IP.
2. Åbn porten i firewallen: `sudo ufw allow 80/tcp` (eller den relevante
   `iptables`/`nftables`-regel, hvis `ufw` ikke bruges).
3. Genindlæs Nginx: `sudo systemctl reload nginx`.

Wallboardet forbliver read-only uanset dette — der findes ingen
administrations- eller redigeringsfunktioner at beskytte. Cockpit
(`https://<pi>:9090/`) har sin egen, adskilte URL og port og påvirkes ikke.

## Cockpit

Installation er beskrevet i "Installation på Raspberry Pi", trin 3. Cockpit
bruges udelukkende til:

- At følge systemressourcer (CPU, hukommelse, disk).
- Start/stop/genstart af `wallboard`-servicen.
- Visning af journal-logs (`journalctl -u wallboard`).
- Netværksadministration og systemopdateringer.

Wallboardet er *ikke* bygget som et Cockpit-plugin, og Cockpit er ikke en
forudsætning for at wallboardet virker.

## Tests

```bash
npm test
```

Dækker: mapping af WordPress-data, statusoversættelser (inkl. ukendte
statusser), manglende felter, tal leveret som strenge, tomme API-svar,
API-timeout, brug af cache ved netværksfejl, filtrering af følsomme felter,
dato-filtrering af afsluttede opgaver, og sortering af vagter.

## Fejlfinding

- **Logs**: `journalctl -u wallboard -f` (eller via Cockpit). Serveren logger
  udelukkende til stdout/stderr — ingen voksende logfiler i applikationsmappen.
- **Servicestatus**: `sudo systemctl status wallboard`.
- **Cache**: `/var/lib/wallboard/cache.json` — indeholder senest kendte
  gyldige data. Skrives atomisk (skriv til `.tmp`, `rename` til det endelige
  navn), så den aldrig efterlades korrupt ved strømsvigt.
- **"Offline – viser senest hentede data"** på skærmen betyder WordPress er
  utilgængeligt lige nu, og wallboardet viser i stedet den seneste cachede
  data — den fortsætter automatisk, når forbindelsen kommer tilbage
  (eksponentiel retry, både server- og frontend-side).
- **Chromium starter ikke**: tjek at `/opt/wallboard/deployment/kiosk-autostart.sh`
  er eksekverbar og korrekt refereret i autostart-filen, og at `/health`
  rent faktisk svarer (`curl http://127.0.0.1/health`).
- **Servicen crash-looper med `Fatal error ... Check failed: 12 == errno` /
  `status=5/TRAP` i `journalctl -u wallboard`**: dette var en bug i en
  tidligere version af `deployment/wallboard.service`, som satte
  `MemoryDenyWriteExecute=true`. Den seccomp-hærdning er uforenelig med
  Node.js' V8-JIT-motor (den kræver at kunne mprotect()'e kodesider fra
  skrivbare til eksekverbare — netop det denne indstilling blokerer). Hent
  den rettede `wallboard.service` (`git pull` + `sudo ./install.sh`, eller
  kopiér filen manuelt til `/etc/systemd/system/wallboard.service` og kør
  `sudo systemctl daemon-reload && sudo systemctl restart wallboard`).

## Sikkerhed

- WordPress Application Password ligger udelukkende i `.env` (600-rettigheder,
  ejet af den dedikerede `wallboard`-systembruger) og sendes aldrig til browseren.
- Al feltmapping i `server/wordpress-adapter.js` bruger allowlisting — kun
  eksplicit navngivne, ufarlige felter kommer med i `/api/wallboard`-svaret.
  Følgende sendes ALDRIG til wallboardet: telefonnummer, kontaktperson,
  adresse, GPS-koordinater, opgavebeskrivelse, interne noter, loghistorik,
  vagtbeskrivelse, vagtdeltagere, bruger-ID'er, Application Password.
- `WP_BASE_URL` skal være HTTPS for eksterne hosts (håndhævet i `server/config.js`).
- Wallboardet er read-only: ingen oprettelse/redigering af opgaver, ingen
  tilmelding til vagter, intet login, ingen visning af opgavedetaljer eller
  personprofiler.
