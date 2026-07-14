'use strict';

const time = require('./time');
const mockData = require('./mock-data');

/**
 * Al integration mod WordPress-API'et samlet ét sted. Frontend/server.js
 * kender kun det rensede wallboard-format nedenfor — ændres WP-pluginets
 * endpoints eller feltnavne, er det KUN denne fil der skal ændres.
 *
 * Sikkerhedsprincip: der bruges udelukkende allowlisting. Et mappings-kald
 * bygger altid et nyt objekt med nøjagtig de tilladte nøgler — det rå
 * WP-svar spredes ALDRIG direkte (`{...raw}`) ind i outputtet. Det er den
 * eneste garanti for at fx et fremtidigt nyt telefonnummer-felt i WP-pluginet
 * ikke automatisk lækker ud til wallboardet.
 */

// ---- Lav-niveau HTTP mod WordPress -----------------------------------

function buildUrl(config, routePath, params) {
	const base = config.wpBaseUrl.replace(/\/+$/, '');
	const ns = config.wpApiNamespace.startsWith('/') ? config.wpApiNamespace : `/${config.wpApiNamespace}`;
	const url = new URL(`${base}${ns}${routePath}`);

	for (const [key, value] of Object.entries(params || {})) {
		if (value === null || value === undefined || value === '') continue;
		url.searchParams.set(key, String(value));
	}

	return url;
}

async function wpFetch(config, routePath, params) {
	const url = buildUrl(config, routePath, params);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);

	const authHeader = 'Basic ' + Buffer.from(`${config.wpUsername}:${config.wpApplicationPassword}`).toString('base64');

	let response;
	try {
		response = await fetch(url, {
			method: 'GET',
			headers: {
				Authorization: authHeader,
				Accept: 'application/json',
				'User-Agent': 'wallboard/1.0',
			},
			signal: controller.signal,
		});
	} catch (err) {
		if (err.name === 'AbortError') {
			throw new Error(`Tidsudløb mod WordPress (${routePath})`);
		}
		throw new Error(`Kunne ikke kontakte WordPress (${routePath}): ${err.message}`);
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		throw new Error(`WordPress svarede med status ${response.status} for ${routePath}`);
	}

	let json;
	try {
		json = await response.json();
	} catch {
		throw new Error(`Uventet (ikke-JSON) svar fra WordPress for ${routePath}`);
	}

	if (!json || json.success !== true) {
		throw new Error(`WordPress-svar mangler success:true for ${routePath}`);
	}
	if (!Array.isArray(json.data)) {
		throw new Error(`Uventet svarformat (data er ikke en liste) for ${routePath}`);
	}

	return json.data;
}

// ---- Hjælpefunktioner til robust felt-udtræk --------------------------

function toStr(value, fallback = '') {
	if (value === null || value === undefined) return fallback;
	const s = String(value).trim();
	return s === '' ? fallback : s;
}

function toIntOrNull(value) {
	if (value === null || value === undefined || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Valid ISO 8601-streng, ellers null — beskytter mod korrupte/manglende datofelter. */
function toIsoOrNull(value) {
	if (!value || typeof value !== 'string') return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? value : null;
}

function uniqueNonEmpty(list) {
	return [...new Set(list.filter((v) => typeof v === 'string' && v.trim() !== ''))];
}

/** Navne på ikke-annullerede assignees, med fallback til det legacy assigned_name-felt. */
function extractAssignedNames(raw) {
	const assignees = Array.isArray(raw.assignees) ? raw.assignees : [];
	const fromAssignees = assignees
		.filter((a) => a && a.status !== 'cancelled')
		.map((a) => toStr(a && a.display_name));

	const names = uniqueNonEmpty(fromAssignees);
	if (names.length > 0) return names;

	const legacy = toStr(raw.assigned_name);
	return legacy ? [legacy] : [];
}

// ---- Mapping: opgaver ---------------------------------------------------

/**
 * @param {'in_progress'|'completed'} bucketStatus Statussen listen repræsenterer.
 *   Bruges i stedet for opgavens rå status-kolonne, fordi multi-assignee-opgaver
 *   kan have status='assigned' på selve opgaven, mens den reelt vises i
 *   "igangværende" fordi én assignee er i gang (se WPC_Tasks::get_tasks()'
 *   OR-logik mod assignments-tabellen i det virkelige API).
 */
function mapTask(raw, config, bucketStatus) {
	if (!raw || typeof raw !== 'object') return null;

	const id = toIntOrNull(raw.id);
	if (id === null) return null;

	const task = {
		id,
		taskNumber: toStr(raw.task_number, `#${id}`),
		title: toStr(raw.title, 'Uden titel'),
		status: bucketStatus,
	};

	if (bucketStatus === 'in_progress') {
		const assigneeStart = Array.isArray(raw.assignees)
			? raw.assignees.find((a) => a && a.status === 'in_progress' && a.started_at)
			: null;
		task.startedAt = toIsoOrNull(raw.started_at) || toIsoOrNull(assigneeStart && assigneeStart.started_at) || toIsoOrNull(raw.created_at);
	} else {
		const assigneeStop = Array.isArray(raw.assignees)
			? raw.assignees.filter((a) => a && a.stopped_at).sort((a, b) => Date.parse(b.stopped_at) - Date.parse(a.stopped_at))[0]
			: null;
		task.completedAt = toIsoOrNull(raw.completed_at) || toIsoOrNull(assigneeStop && assigneeStop.stopped_at);
	}

	if (config.showAssignees) {
		task.assignedNames = extractAssignedNames(raw);
	}

	return task;
}

/** Filtrerer "afsluttet i dag ELLER inden for COMPLETED_LOOKBACK_HOURS", sorterer nyest først, begrænser til COMPLETED_TASK_LIMIT. */
function filterAndSortCompleted(mappedTasks, config, nowMs = Date.now()) {
	const today = time.todayInTimezone(config.timezone);
	const lookbackMs = config.completedLookbackHours * 60 * 60 * 1000;

	const kept = mappedTasks.filter((t) => {
		if (!t.completedAt) return false;
		const completedMs = Date.parse(t.completedAt);
		if (!Number.isFinite(completedMs)) return false;

		const isToday = time.dateKeyInTimezone(completedMs, config.timezone) === today;
		const isWithinLookback = nowMs - completedMs <= lookbackMs;
		return isToday || isWithinLookback;
	});

	kept.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));

	return kept.slice(0, config.completedTaskLimit);
}

/** Ældste igangværende opgave først. */
function sortInProgress(mappedTasks) {
	return [...mappedTasks].sort((a, b) => {
		const aMs = a.startedAt ? Date.parse(a.startedAt) : Infinity;
		const bMs = b.startedAt ? Date.parse(b.startedAt) : Infinity;
		return aMs - bMs;
	});
}

// ---- Mapping: vagter ------------------------------------------------------

function mapShift(raw, config) {
	if (!raw || typeof raw !== 'object') return null;

	const id = toIntOrNull(raw.id);
	if (id === null) return null;

	const shiftDate = toStr(raw.shift_date);
	const startTime = time.combineDateTime(shiftDate, toStr(raw.start_time, '00:00:00'), config.timezone);

	// Overnatningsvagter (fx 22:00–06:00) deler ét shift_date i WP — end_time
	// hører derfor reelt til DAGEN EFTER, når klokkeslættet er tidligere end
	// start_time. Uden dette ruller vi datoen frem, ville sådan en vagts
	// beregnede sluttidspunkt ligge FØR starttidspunktet, og den ville
	// fejlagtigt blive filtreret væk som "allerede overstået" kort efter den
	// startede (se filterAndSortShifts()).
	let endTime = time.combineDateTime(shiftDate, toStr(raw.end_time, '00:00:00'), config.timezone);
	if (startTime && endTime && Date.parse(endTime) <= Date.parse(startTime)) {
		endTime = time.combineDateTime(time.addDays(shiftDate, 1), toStr(raw.end_time, '00:00:00'), config.timezone);
	}

	return {
		id,
		title: toStr(raw.title, 'Vagt'),
		startTime,
		endTime,
		status: toStr(raw.status, 'unknown'),
	};
}

/** Kun vagter der er i gang eller ligger forude; aktuelle før kommende (se planens begrundelse). */
function filterAndSortShifts(mappedShifts, nowMs = Date.now()) {
	return mappedShifts
		.filter((s) => {
			const endMs = s.endTime ? Date.parse(s.endTime) : null;
			return endMs === null || endMs > nowMs;
		})
		.sort((a, b) => {
			const aMs = a.startTime ? Date.parse(a.startTime) : Infinity;
			const bMs = b.startTime ? Date.parse(b.startTime) : Infinity;
			return aMs - bMs;
		});
}

// ---- Offentlig API ---------------------------------------------------------

function createAdapter(config) {
	const isMock = config.apiMode === 'mock';

	async function getRawInProgressTasks() {
		if (isMock) return mockData.mockInProgressTasksResponse().data;
		return wpFetch(config, '/tasks', { scope: 'all', status: 'in_progress', arrangement_id: config.arrangementId });
	}

	async function getRawCompletedTasks() {
		if (isMock) return mockData.mockCompletedTasksResponse().data;
		return wpFetch(config, '/tasks', { scope: 'all', status: 'completed', arrangement_id: config.arrangementId });
	}

	async function getRawShifts() {
		const nowMs = Date.now();
		const from = time.todayInTimezone(config.timezone);
		const to = time.dateKeyInTimezone(nowMs + config.shiftLookaheadHours * 3600 * 1000, config.timezone);

		if (isMock) return mockData.mockShiftsResponse().data;
		return wpFetch(config, '/shifts', {
			from,
			to,
			include_users: 0,
			arrangement_id: config.arrangementId,
		});
	}

	async function fetchInProgressTasks() {
		const raw = await getRawInProgressTasks();
		const mapped = raw.map((r) => mapTask(r, config, 'in_progress')).filter(Boolean);
		return sortInProgress(mapped);
	}

	async function fetchCompletedTasks() {
		const raw = await getRawCompletedTasks();
		const mapped = raw.map((r) => mapTask(r, config, 'completed')).filter(Boolean);
		return filterAndSortCompleted(mapped, config);
	}

	async function fetchShifts() {
		const raw = await getRawShifts();
		const mapped = raw.map((r) => mapShift(r, config)).filter(Boolean);
		return filterAndSortShifts(mapped);
	}

	return { fetchInProgressTasks, fetchCompletedTasks, fetchShifts };
}

module.exports = {
	createAdapter,
	// Eksporteret for tests — ren mapping-/filtreringslogik uden netværk.
	mapTask,
	mapShift,
	filterAndSortCompleted,
	filterAndSortShifts,
	sortInProgress,
	extractAssignedNames,
};
