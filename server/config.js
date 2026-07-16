'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal .env-loader (ingen dependency). Udfylder kun process.env for
 * nøgler der ikke allerede er sat — systemd's EnvironmentFile=.env
 * populerer process.env direkte, så denne loader er et no-op i produktion
 * og kun relevant til lokal udvikling (`node server/server.js`).
 */
function loadDotEnv(envPath) {
	if (!fs.existsSync(envPath)) return;

	const raw = fs.readFileSync(envPath, 'utf8');
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;

		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (!(key in process.env)) {
			process.env[key] = value;
		}
	}
}

loadDotEnv(path.join(__dirname, '..', '.env'));

function toBool(value, fallback) {
	if (value === undefined || value === null || value === '') return fallback;
	return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function toInt(value, fallback) {
	const n = parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Er $host "intern" (localhost/loopback/.local)? Sådanne hosts må bruge
 * almindelig HTTP under udvikling — alt andet skal være HTTPS. Se
 * validateWpBaseUrl() nedenfor.
 */
function isLocalHost(hostname) {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '::1' ||
		hostname.endsWith('.local')
	);
}

function validateWpBaseUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error('WP_BASE_URL er ikke en gyldig URL');
	}

	if (url.protocol !== 'https:' && !isLocalHost(url.hostname)) {
		throw new Error(
			'WP_BASE_URL skal bruge HTTPS for eksterne hosts (undtagelse: localhost/127.0.0.1/*.local til udvikling)'
		);
	}

	return url;
}

function loadConfig() {
	const apiMode = (process.env.API_MODE || 'live').toLowerCase() === 'mock' ? 'mock' : 'live';

	const config = {
		port: toInt(process.env.PORT, 3000),
		apiMode,
		wpBaseUrl: process.env.WP_BASE_URL || '',
		wpApiNamespace: process.env.WP_API_NAMESPACE || '/wp-json/wp-community/v1',
		wpUsername: process.env.WP_USERNAME || '',
		wpApplicationPassword: process.env.WP_APPLICATION_PASSWORD || '',
		timezone: process.env.TIMEZONE || 'Europe/Copenhagen',
		refreshSeconds: toInt(process.env.REFRESH_SECONDS, 30),
		completedTaskLimit: toInt(process.env.COMPLETED_TASK_LIMIT, 10),
		completedLookbackHours: toInt(process.env.COMPLETED_LOOKBACK_HOURS, 24),
		shiftLookaheadHours: toInt(process.env.SHIFT_LOOKAHEAD_HOURS, 24),
		upcomingTaskLimit: toInt(process.env.UPCOMING_TASK_LIMIT, 10),
		upcomingLookaheadHours: toInt(process.env.UPCOMING_LOOKAHEAD_HOURS, 24),
		showAssignees: toBool(process.env.SHOW_ASSIGNEES, true),
		showShiftNames: toBool(process.env.SHOW_SHIFT_NAMES, false),
		arrangementId: process.env.ARRANGEMENT_ID ? toInt(process.env.ARRANGEMENT_ID, null) : null,
		cachePath: process.env.WALLBOARD_CACHE_PATH || '/var/lib/wallboard/cache.json',
		fetchTimeoutMs: toInt(process.env.WALLBOARD_FETCH_TIMEOUT_MS, 8000),
	};

	if (apiMode === 'live') {
		validateWpBaseUrl(config.wpBaseUrl);
		if (!config.wpUsername || !config.wpApplicationPassword) {
			throw new Error('WP_USERNAME og WP_APPLICATION_PASSWORD skal være sat i live-tilstand');
		}
	}

	return config;
}

module.exports = { loadConfig, validateWpBaseUrl, isLocalHost };
