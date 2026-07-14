'use strict';

/**
 * Tidszone-hjælpefunktioner uden eksterne dependencies. Bruger Intl (indbygget
 * i Node ≥ 18 med fuld ICU) til at slå UTC-offset op for en given IANA-
 * tidszone på et givet tidspunkt — nødvendigt fordi Europe/Copenhagen skifter
 * mellem +01:00 og +02:00 (sommertid), og WordPress-vagtfelterne
 * (shift_date/start_time/end_time) leveres som "nøgne" lokale klokkeslæt uden
 * selv at oplyse offset.
 */

function getOffsetString(instantMs, timeZone) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		timeZoneName: 'longOffset',
	}).formatToParts(new Date(instantMs));

	const tzPart = parts.find((p) => p.type === 'timeZoneName');
	if (!tzPart) return '+00:00';

	const raw = tzPart.value.replace('GMT', '');
	return raw === '' ? '+00:00' : raw;
}

function offsetStringToMinutes(offset) {
	const m = offset.match(/^([+-])(\d{2}):(\d{2})$/);
	if (!m) return 0;
	const sign = m[1] === '-' ? -1 : 1;
	return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

function getZonedParts(instantMs, timeZone) {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	}).formatToParts(new Date(instantMs));

	const map = {};
	for (const p of parts) map[p.type] = p.value;
	if (map.hour === '24') map.hour = '00';
	return map;
}

function formatInstantIso(instantMs, timeZone) {
	const p = getZonedParts(instantMs, timeZone);
	const offset = getOffsetString(instantMs, timeZone);
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

function nowIso(timeZone) {
	return formatInstantIso(Date.now(), timeZone);
}

function todayInTimezone(timeZone) {
	const p = getZonedParts(Date.now(), timeZone);
	return `${p.year}-${p.month}-${p.day}`;
}

/** 'YYYY-MM-DD' for et vilkårligt tidspunkt (ms siden epoch), i $timeZone. */
function dateKeyInTimezone(instantMs, timeZone) {
	const p = getZonedParts(instantMs, timeZone);
	return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Kombinér en "nøgen" lokal dato+klokkeslæt (som WP's shift_date/start_time)
 * til en korrekt ISO 8601-streng med offset for $timeZone. To iterationer for
 * at håndtere kanttilfælde nær et sommertidsskift.
 */
function combineDateTime(dateStr, timeStr, timeZone) {
	if (!dateStr || !timeStr) return null;

	const [hh = '00', mm = '00', ss = '00'] = String(timeStr).split(':');
	const wallClock = `${dateStr}T${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}Z`;
	const guessMs = Date.parse(wallClock);
	if (Number.isNaN(guessMs)) return null;

	let offsetMinutes = offsetStringToMinutes(getOffsetString(guessMs, timeZone));
	let instantMs = guessMs - offsetMinutes * 60000;

	const refinedMinutes = offsetStringToMinutes(getOffsetString(instantMs, timeZone));
	if (refinedMinutes !== offsetMinutes) {
		instantMs = guessMs - refinedMinutes * 60000;
	}

	return formatInstantIso(instantMs, timeZone);
}

/** Lægger $days dage til en 'YYYY-MM-DD'-streng, korrekt hen over måned/år-skift. */
function addDays(dateStr, days) {
	const [y, m, d] = dateStr.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d + days));
	const pad = (n) => String(n).padStart(2, '0');
	return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

module.exports = { nowIso, todayInTimezone, dateKeyInTimezone, combineDateTime, formatInstantIso, addDays };
