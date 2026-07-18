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

async function wpFetchRaw(config, routePath, params) {
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

	return json.data;
}

/** For endpoints der returnerer en liste (tasks/shifts/arrangements). */
async function wpFetch(config, routePath, params) {
	const data = await wpFetchRaw(config, routePath, params);
	if (!Array.isArray(data)) {
		throw new Error(`Uventet svarformat (data er ikke en liste) for ${routePath}`);
	}
	return data;
}

/** For endpoints der returnerer ét objekt (fx /app-config). */
async function wpFetchObject(config, routePath, params) {
	const data = await wpFetchRaw(config, routePath, params);
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		throw new Error(`Uventet svarformat (data er ikke et objekt) for ${routePath}`);
	}
	return data;
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

/** Første "ord" af et fuldt navn — aldrig efternavn/øvrige navne. */
function firstName(fullName) {
	const trimmed = toStr(fullName);
	if (!trimmed) return '';
	return trimmed.split(/\s+/)[0];
}

/**
 * Fornavne på ikke-annullerede vagtdeltagere — kun kaldt når SHOW_SHIFT_NAMES=true
 * (se getRawShifts()' include_users-parameter). Bevidst kun fornavn, aldrig
 * fulde navne eller bruger-id'er — se README.md's sikkerhedsafsnit.
 */
function extractShiftFirstNames(raw) {
	const users = Array.isArray(raw.users) ? raw.users : [];
	const names = users
		.filter((u) => u && u.status !== 'cancelled')
		.map((u) => firstName(u && u.name));
	return uniqueNonEmpty(names);
}

// ---- Mapping: opgaver ---------------------------------------------------

/**
 * @param {'in_progress'|'completed'|'planned'} bucketStatus Statussen listen
 *   repræsenterer. Bruges i stedet for opgavens rå status-kolonne, fordi
 *   multi-assignee-opgaver kan have status='assigned' på selve opgaven, mens
 *   den reelt vises i "igangværende" fordi én assignee er i gang (se
 *   WPC_Tasks::get_tasks()' OR-logik mod assignments-tabellen i det
 *   virkelige API).
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
	} else if (bucketStatus === 'planned') {
		// "Kommende" — tidspunktet er enten en eksplicit aftaletid eller en
		// deadline; aftaletid prioriteres, da den beskriver hvornår opgaven
		// reelt skal udføres (deadline er blot en frist, ikke et tidspunkt).
		task.scheduledAt = toIsoOrNull(raw.appointment_time) || toIsoOrNull(raw.due_date);
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

/**
 * Kun opgaver med en aftaletid/deadline i intervallet ]nu, nu + UPCOMING_LOOKAHEAD_HOURS] —
 * opgaver uden noget tidspunkt sat, eller hvis tidspunkt allerede er passeret,
 * hører ikke hjemme i "kommende". Nærmeste tidspunkt først, begrænset til
 * UPCOMING_TASK_LIMIT.
 */
function filterAndSortUpcoming(mappedTasks, config, nowMs = Date.now()) {
	const lookaheadMs = config.upcomingLookaheadHours * 60 * 60 * 1000;
	const horizon = nowMs + lookaheadMs;

	const kept = mappedTasks.filter((t) => {
		if (!t.scheduledAt) return false;
		const scheduledMs = Date.parse(t.scheduledAt);
		if (!Number.isFinite(scheduledMs)) return false;
		return scheduledMs > nowMs && scheduledMs <= horizon;
	});

	kept.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));

	return kept.slice(0, config.upcomingTaskLimit);
}

// ---- Mapping: vagter ------------------------------------------------------

/**
 * [2026-07-16, bugfix] start_time/end_time viste sig — bekræftet ved at
 * hente et rå vagt-svar direkte fra WordPress — at være FULDE
 * "YYYY-MM-DD HH:MM:SS"-strenge, ikke et bart klokkeslæt som oprindeligt
 * antaget (DB-kolonnen er DATETIME, ikke TIME, på trods af feltnavnet). Den
 * gamle kode splittede en sådan streng på ':' og fik et ugyldigt
 * "shift_dateT2026-07-16 14:00:00Z"-resultat, som strtotime/Date.parse
 * afviste — startTime/endTime blev derfor stille null for enhver rigtig
 * vagt. Denne funktion håndterer begge former: en fuld dato+tid-streng
 * bruges direkte (ignorerer shift_date); et bart klokkeslæt (defensivt, i
 * tilfælde af en ældre/anden WP-version) kombineres i stedet med shift_date
 * som hidtil.
 *
 * [2026-07-19, bugfix] WordPress' /shifts-endpoint sender i dag altid
 * tidszone-løse strenge (se ovenstående kommentar), men denne funktion
 * genfortolkede FØR denne rettelse ubetinget ALT som en sådan — havde en
 * værdi allerede et eksplicit offset (fx "2026-07-16T08:00:00+02:00" fra en
 * fremtidig REST-ændring, eller en test-fixture), blev det offset stille
 * ignoreret og klokkeslættet regnet om IGEN via wallboardets konfigurerede
 * tidszone: en dobbelt konvertering. En værdi med Z/±HH:MM er allerede et
 * absolut tidspunkt og skal parses som sådan, aldrig gennem combineDateTime().
 */
function parseShiftDateTime(value, fallbackDateStr, timeZone) {
	const str = toStr(value);
	if (!str) return null;

	if (time.hasExplicitTimezone(str)) {
		const instantMs = Date.parse(str);
		return Number.isNaN(instantMs) ? null : time.formatInstantIso(instantMs, timeZone);
	}

	const withDate = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
	if (withDate) {
		return time.combineDateTime(withDate[1], withDate[2], timeZone);
	}

	return time.combineDateTime(toStr(fallbackDateStr), str, timeZone);
}

function mapShift(raw, config) {
	if (!raw || typeof raw !== 'object') return null;

	const id = toIntOrNull(raw.id);
	if (id === null) return null;

	const shiftDate = toStr(raw.shift_date);
	const startTime = parseShiftDateTime(raw.start_time, shiftDate, config.timezone);
	let endTime = parseShiftDateTime(raw.end_time, shiftDate, config.timezone);

	// Overnatningsvagter (fx 22:00–06:00): hvis det beregnede sluttidspunkt
	// stadig lander før eller på starttidspunktet, lægges der simpelthen et
	// døgn til selve instansen — format-uafhængigt, virker uanset om
	// tidspunkterne kom fra en fuld dato+tid-streng eller shift_date-fallbacket.
	// Uden dette ville en sådan vagts sluttidspunkt ligge FØR starttidspunktet,
	// og den ville fejlagtigt blive filtreret væk som "allerede overstået" kort
	// efter den startede (se filterAndSortShifts()).
	if (startTime && endTime && Date.parse(endTime) <= Date.parse(startTime)) {
		endTime = time.formatInstantIso(Date.parse(endTime) + 24 * 60 * 60 * 1000, config.timezone);
	}

	const shift = {
		id,
		title: toStr(raw.title, 'Vagt'),
		startTime,
		endTime,
		status: toStr(raw.status, 'unknown'),
		// [2026-07-19] Bruges af "Vagtdækning"-panelet i ops-layoutet til en
		// X/Y-dækningsbjælke — maxUsers er null for en ubegrænset vagt
		// (matcher WPC_Shifts::format_shift()'s samme null-for-ubegrænset).
		userCount: toIntOrNull(raw.user_count) ?? 0,
		maxUsers: toIntOrNull(raw.max_users),
	};

	if (config.showShiftNames) {
		shift.participantNames = extractShiftFirstNames(raw);
	}

	return shift;
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

// ---- Arrangement-scoping ------------------------------------------------

/**
 * [2026-07-16] En almindelig (ikke-WP-administrator) konto kan — uanset
 * hvilke wpc_*-capabilities den har — kun se opgaver/vagter for arrangementer
 * den selv er MEDLEM af (se WPC_Arrangement_Access::can_view_task()/
 * can_view_shift() i klan-rover-operations: alt falder til
 * can_view_arrangement(), som kræver medlemskab eller ægte administrator).
 * Et enkelt ARRANGEMENT_ID løser det ved at være medlem af netop det ene.
 * Uden et fast ARRANGEMENT_ID slår wallboardet i stedet selv op hvilke
 * arrangementer der aktuelt er "active" og viser data for alle af dem —
 * men wallboard-kontoen skal stadig gøres til deltager i hvert af dem i
 * wp-admin, ellers filtrerer WordPress dem fra på samme måde som ved ét
 * fast ARRANGEMENT_ID. Se README.md's "Konfiguration"-afsnit.
 */
function filterToActiveArrangements(rawItems, activeIds) {
	if (!activeIds) return rawItems; // mock-mode eller eksplicit ARRANGEMENT_ID — WP har allerede scopet resultatet korrekt
	return rawItems.filter((item) => {
		const id = toIntOrNull(item && item.arrangement_id);
		return id !== null && activeIds.has(id);
	});
}

// ---- Mapping: branding (logo) --------------------------------------------

/**
 * /app-config er et OFFENTLIGT, ikke-autentificeret endpoint i
 * klan-rover-core (samme som appens splash-skærm bruger til logoet før
 * login) — ingen risiko ved at eksponere logo-URL'en, den er per definition
 * allerede offentligt tilgængelig. Allowlister alligevel kun logo_url; de
 * øvrige app-config-felter (app_name, primary_color, support_email,
 * features) er ikke wallboardets ansvar at vise.
 */
function mapBranding(raw) {
	const logoUrl = toStr(raw && raw.logo_url);
	return { logoUrl: logoUrl || null };
}

// ---- Offentlig API ---------------------------------------------------------

function createAdapter(config) {
	const isMock = config.apiMode === 'mock';

	// Cacher IKKE på tværs af refresh-cyklusser — kun inden for én, så de tre
	// parallelle fetch*-kald (se server.js' refreshOnce()) deler ét enkelt
	// /arrangements-opslag i stedet for at hente listen tre gange. Nulstilles
	// så snart opslaget er afsluttet (success eller fejl), så næste
	// refresh-cyklus altid henter en frisk liste.
	let activeArrangementIdsPromise = null;

	async function getActiveArrangementIds() {
		if (isMock || config.arrangementId) return null; // ikke nødvendigt i disse tilstande

		if (!activeArrangementIdsPromise) {
			activeArrangementIdsPromise = wpFetch(config, '/arrangements', { status: 'active' })
				.then((raw) => new Set(raw.map((a) => toIntOrNull(a && a.id)).filter((id) => id !== null)))
				.finally(() => {
					activeArrangementIdsPromise = null;
				});
		}

		return activeArrangementIdsPromise;
	}

	async function getRawInProgressTasks() {
		if (isMock) return mockData.mockInProgressTasksResponse().data;
		const activeIds = await getActiveArrangementIds();
		const raw = await wpFetch(config, '/tasks', { scope: 'all', status: 'in_progress', arrangement_id: config.arrangementId });
		return filterToActiveArrangements(raw, activeIds);
	}

	async function getRawCompletedTasks() {
		if (isMock) return mockData.mockCompletedTasksResponse().data;
		const activeIds = await getActiveArrangementIds();
		const raw = await wpFetch(config, '/tasks', { scope: 'all', status: 'completed', arrangement_id: config.arrangementId });
		return filterToActiveArrangements(raw, activeIds);
	}

	async function getRawUpcomingTasks() {
		if (isMock) return mockData.mockUpcomingTasksResponse().data;
		const activeIds = await getActiveArrangementIds();
		const raw = await wpFetch(config, '/tasks', { scope: 'all', status: 'planned', arrangement_id: config.arrangementId });
		return filterToActiveArrangements(raw, activeIds);
	}

	async function getRawShifts() {
		const nowMs = Date.now();
		const from = time.todayInTimezone(config.timezone);
		const to = time.dateKeyInTimezone(nowMs + config.shiftLookaheadHours * 3600 * 1000, config.timezone);

		if (isMock) return mockData.mockShiftsResponse().data;
		const activeIds = await getActiveArrangementIds();
		const raw = await wpFetch(config, '/shifts', {
			from,
			to,
			include_users: config.showShiftNames ? 1 : 0,
			arrangement_id: config.arrangementId,
		});
		return filterToActiveArrangements(raw, activeIds);
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

	async function fetchUpcomingTasks() {
		const raw = await getRawUpcomingTasks();
		const mapped = raw.map((r) => mapTask(r, config, 'planned')).filter(Boolean);
		return filterAndSortUpcoming(mapped, config);
	}

	async function fetchShifts() {
		const raw = await getRawShifts();
		const mapped = raw.map((r) => mapShift(r, config)).filter(Boolean);
		return filterAndSortShifts(mapped);
	}

	async function fetchBranding() {
		if (isMock) return mapBranding({});
		const raw = await wpFetchObject(config, '/app-config', {});
		return mapBranding(raw);
	}

	return { fetchInProgressTasks, fetchCompletedTasks, fetchUpcomingTasks, fetchShifts, fetchBranding };
}

module.exports = {
	createAdapter,
	// Eksporteret for tests — ren mapping-/filtreringslogik uden netværk.
	mapTask,
	mapShift,
	parseShiftDateTime,
	filterAndSortCompleted,
	filterAndSortShifts,
	filterAndSortUpcoming,
	sortInProgress,
	extractAssignedNames,
	extractShiftFirstNames,
	filterToActiveArrangements,
	mapBranding,
};
