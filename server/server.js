'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { loadConfig } = require('./config');
const { createAdapter } = require('./wordpress-adapter');
const cache = require('./cache');
const time = require('./time');

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const MIME_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
};

const MAX_BACKOFF_MULTIPLIER = 10; // loft: højst 10x REFRESH_SECONDS mellem forsøg
const PAGE_INTERVAL_SECONDS = 10; // frontend auto-sideskift, se spec

/**
 * Bygger en selvstændig server-instans om et konfigurationsobjekt. Fabriks-
 * mønsteret (i stedet for et modul-niveau singleton) gør det muligt for
 * tests at køre flere isolerede instanser side om side, hver med sin egen
 * in-memory state og sin egen (midlertidige) cache-fil.
 */
function createServer(config) {
	const adapter = createAdapter(config);

	const state = {
		lastGoodPayload: null, // { tasks: { inProgress, completed }, shifts }
		lastFetchAt: null, // Date
		lastFetchOk: false,
		consecutiveFailures: 0,
	};

	let refreshTimer = null;
	let stopped = false;

	async function refreshOnce() {
		try {
			const [inProgress, completed, shifts] = await Promise.all([
				adapter.fetchInProgressTasks(),
				adapter.fetchCompletedTasks(),
				adapter.fetchShifts(),
			]);

			state.lastGoodPayload = { tasks: { inProgress, completed }, shifts };
			state.lastFetchAt = new Date();
			state.lastFetchOk = true;
			state.consecutiveFailures = 0;

			// Disk-cache skrives i baggrunden — fejler den, er in-memory data stadig gyldige.
			cache.writeCache(config.cachePath, state.lastGoodPayload).catch((err) => {
				console.error('[wallboard] kunne ikke skrive cache:', err.message);
			});
		} catch (err) {
			state.lastFetchOk = false;
			state.consecutiveFailures += 1;
			console.error(`[wallboard] datahentning fejlede (forsøg ${state.consecutiveFailures}):`, err.message);

			if (!state.lastGoodPayload) {
				const cached = await cache.readCache(config.cachePath);
				if (cached) {
					state.lastGoodPayload = cached.payload;
					state.lastFetchAt = new Date(cached.fetchedAt);
				}
			}
		}

		if (!stopped) {
			scheduleNext();
		}
	}

	function scheduleNext() {
		const base = config.refreshSeconds * 1000;
		const multiplier = state.consecutiveFailures > 0
			? Math.min(2 ** state.consecutiveFailures, MAX_BACKOFF_MULTIPLIER)
			: 1;
		refreshTimer = setTimeout(refreshOnce, base * multiplier);
		if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
	}

	// [2026-07-16, bugfix] Da fetchedMs faldt tilbage til "nu" når der slet
	// ingen vellykket hentning (og ingen disk-cache) fandtes endnu, viste
	// frontenden det modstridende "Offline · 0 sekunder siden" — som om der
	// var friske data, når der reelt ingen var. state.lastFetchAt er null i
	// netop det tilfælde (se refreshOnce()), så generatedAt/cacheAgeSeconds
	// er nu eksplicit null i stedet for at foregive en tidsstempel der ikke
	// findes — frontenden viser i stedet "ingen data endnu".
	function buildWallboardResponse() {
		const nowMs = Date.now();
		const payload = state.lastGoodPayload || { tasks: { inProgress: [], completed: [] }, shifts: [] };
		const fetchedMs = state.lastFetchAt ? state.lastFetchAt.getTime() : null;

		return {
			generatedAt: fetchedMs !== null ? time.formatInstantIso(fetchedMs, config.timezone) : null,
			stale: !state.lastFetchOk,
			sourceStatus: state.lastFetchOk ? 'online' : 'offline',
			cacheAgeSeconds: fetchedMs !== null ? Math.max(0, Math.round((nowMs - fetchedMs) / 1000)) : null,
			tasks: payload.tasks,
			shifts: payload.shifts,
		};
	}

	function buildHealthResponse() {
		return {
			status: 'ok',
			mode: config.apiMode,
			lastFetchOk: state.lastFetchOk,
			lastFetchAt: state.lastFetchAt ? state.lastFetchAt.toISOString() : null,
			uptimeSeconds: Math.round(process.uptime()),
		};
	}

	function injectConfig(html) {
		const publicConfig = {
			refreshSeconds: config.refreshSeconds,
			completedTaskLimit: config.completedTaskLimit,
			completedLookbackHours: config.completedLookbackHours,
			pageIntervalSeconds: PAGE_INTERVAL_SECONDS,
		};
		const script = `<script>window.WALLBOARD_CONFIG = ${JSON.stringify(publicConfig)};</script>`;
		return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`;
	}

	async function serveStatic(res, pathname) {
		const relPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
		const filePath = path.normalize(path.join(FRONTEND_DIR, relPath));

		const withinFrontend = filePath === FRONTEND_DIR || filePath.startsWith(FRONTEND_DIR + path.sep);
		if (!withinFrontend) {
			res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('Forbudt');
			return;
		}

		try {
			const ext = path.extname(filePath);
			if (filePath === path.join(FRONTEND_DIR, 'index.html')) {
				const html = await fsp.readFile(filePath, 'utf8');
				res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-cache' });
				res.end(injectConfig(html));
				return;
			}

			const body = await fsp.readFile(filePath);
			res.writeHead(200, {
				'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
				'Cache-Control': 'public, max-age=300',
			});
			res.end(body);
		} catch {
			res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('Ikke fundet');
		}
	}

	const httpServer = http.createServer((req, res) => {
		Promise.resolve()
			.then(async () => {
				if (req.method !== 'GET' && req.method !== 'HEAD') {
					res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: 'method_not_allowed' }));
					return;
				}

				const url = new URL(req.url, 'http://localhost');

				if (url.pathname === '/api/wallboard') {
					const body = JSON.stringify(buildWallboardResponse());
					res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
					res.end(body);
					return;
				}

				if (url.pathname === '/health') {
					const body = JSON.stringify(buildHealthResponse());
					res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
					res.end(body);
					return;
				}

				await serveStatic(res, url.pathname);
			})
			.catch((err) => {
				// Aldrig stack trace til klienten — kun en generisk fejlbesked.
				console.error('[wallboard] uventet fejl i request handler:', err.message);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: 'internal_error' }));
				}
			});
	});

	function start() {
		return new Promise((resolve) => {
			httpServer.listen(config.port, '127.0.0.1', () => {
				console.log(`[wallboard] server kører på http://127.0.0.1:${config.port} (mode: ${config.apiMode})`);
				resolve();
			});
		});
	}

	function stop() {
		stopped = true;
		if (refreshTimer) clearTimeout(refreshTimer);
		return new Promise((resolve) => httpServer.close(() => resolve()));
	}

	return { httpServer, start, stop, refreshOnce, buildWallboardResponse, buildHealthResponse, state };
}

if (require.main === module) {
	const config = loadConfig();
	const instance = createServer(config);

	instance
		.start()
		.then(() => instance.refreshOnce());

	const shutdown = () => {
		console.log('[wallboard] lukker ned...');
		instance.stop().then(() => process.exit(0));
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

module.exports = { createServer };
