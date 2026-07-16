#!/usr/bin/env bash
#
# Starter Chromium i kiosk-mode mod wallboardet, efter at have ventet på at
# /health svarer. Tænkt til at blive kaldt fra enten skrivebordsmiljøets
# autostart (X11/LXDE, se README.md's "Kiosk mode") ELLER som cage's
# APPLICATION-argument (Raspberry Pi OS Lite uden skrivebord, se README.md's
# "Kiosk mode uden skrivebordsmiljø") — IKKE fra systemd direkte, da begge
# veje kræver en rigtig display-session (X11 hhv. Wayland).
#
# Wallboardet må aldrig afhænge af at Cockpit er åbent — dette script rører
# udelukkende ved browseren, ikke wallboard-servicen selv (den styres af
# systemd, se wallboard.service).
set -euo pipefail

# [2026-07-16] Debians/Raspberry Pi OS' cage-pakke er IKKE bygget med
# Xwayland-understøttelse (ingen -X-mulighed) — Chromium skal derfor køre
# nativt på Wayland, når scriptet startes som cage's APPLICATION. cage sætter
# $WAYLAND_DISPLAY for sit client-process, så det bruges til at skelne fra
# den almindelige X11/LXDE-vej, hvor disse flag ville forhindre Chromium i at
# starte overhovedet (ingen Wayland-compositor at forbinde til der).
CHROMIUM_PLATFORM_FLAGS=()
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
	CHROMIUM_PLATFORM_FLAGS=( --ozone-platform=wayland --enable-features=UseOzonePlatform )
fi

WALLBOARD_URL="${WALLBOARD_URL:-http://127.0.0.1/}"
HEALTH_URL="${WALLBOARD_URL%/}/health"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-120}"

# Skærmslukning/pauseskærm slås fra — et wallboard skal aldrig gå i sort.
xset s off >/dev/null 2>&1 || true
xset s noblank >/dev/null 2>&1 || true
xset -dpms >/dev/null 2>&1 || true

find_browser() {
	if command -v chromium >/dev/null 2>&1; then
		echo "chromium"
	elif command -v chromium-browser >/dev/null 2>&1; then
		echo "chromium-browser"
	else
		echo "Fejl: hverken 'chromium' eller 'chromium-browser' blev fundet i PATH." >&2
		exit 1
	fi
}

BROWSER_BIN="$(find_browser)"

wait_for_health() {
	echo "Venter på at wallboard-servicen svarer på ${HEALTH_URL} ..."
	local waited=0
	while true; do
		if command -v curl >/dev/null 2>&1; then
			if curl --silent --fail --max-time 2 "${HEALTH_URL}" >/dev/null 2>&1; then
				return 0
			fi
		elif command -v wget >/dev/null 2>&1; then
			if wget --quiet --timeout=2 --tries=1 -O /dev/null "${HEALTH_URL}" >/dev/null 2>&1; then
				return 0
			fi
		else
			echo "Advarsel: hverken curl eller wget fundet — kan ikke tjekke /health, venter blot ${MAX_WAIT_SECONDS}s." >&2
			sleep "${MAX_WAIT_SECONDS}"
			return 0
		fi

		waited=$((waited + 2))
		if [ "${waited}" -ge "${MAX_WAIT_SECONDS}" ]; then
			echo "Advarsel: /health svarede ikke inden for ${MAX_WAIT_SECONDS}s — åbner browseren alligevel." >&2
			return 0
		fi
		sleep 2
	done
}

wait_for_health
echo "Starter ${BROWSER_BIN} mod ${WALLBOARD_URL}"

# Genstart browseren i en løkke, hvis den nogensinde lukker (crash, en
# uventet opdatering af Chromium selv, e.l.) — wallboardet skal blive ved
# med at køre uden manuel indgriben.
while true; do
	"${BROWSER_BIN}" \
		"${CHROMIUM_PLATFORM_FLAGS[@]}" \
		--kiosk \
		--incognito \
		--lang=da \
		--noerrdialogs \
		--disable-infobars \
		--disable-session-crashed-bubble \
		--disable-translate \
		--disable-features=Translate,TranslateUI \
		--overscroll-history-navigation=0 \
		--check-for-update-interval=31536000 \
		--no-first-run \
		--autoplay-policy=no-user-gesture-required \
		"${WALLBOARD_URL}" \
		|| true

	echo "Browseren lukkede uventet — genstarter om 3 sekunder..."
	sleep 3
done
