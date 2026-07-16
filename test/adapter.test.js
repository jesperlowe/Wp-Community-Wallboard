'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const adapter = require('../server/wordpress-adapter');
const mockData = require('../server/mock-data');
const time = require('../server/time');

const baseConfig = {
	timezone: 'Europe/Copenhagen',
	completedTaskLimit: 10,
	completedLookbackHours: 24,
	shiftLookaheadHours: 24,
	showAssignees: true,
};

test('mapTask: mapper en normal igangværende opgave korrekt og udelader følsomme felter', () => {
	const nowMs = Date.now();
	const raw = mockData.mockInProgressTasksResponse(nowMs).data[0]; // WPC-0231
	const mapped = adapter.mapTask(raw, baseConfig, 'in_progress');

	assert.equal(mapped.id, 231);
	assert.equal(mapped.taskNumber, 'WPC-0231');
	assert.equal(mapped.title, 'Levering af telte til hovedplads');
	assert.equal(mapped.status, 'in_progress');
	assert.equal(mapped.startedAt, raw.started_at);
	assert.deepEqual(mapped.assignedNames, ['Mikkel Rasmussen']);

	const forbidden = [
		'contact_name', 'contact_phone', 'pickup_address', 'delivery_address',
		'description', 'assigned_vehicle', 'created_by', 'log', 'start_lat',
		'start_lng', 'end_lat', 'end_lng', 'assigned_to',
	];
	for (const key of forbidden) {
		assert.equal(Object.prototype.hasOwnProperty.call(mapped, key), false, `${key} må ikke være i output`);
	}
});

test('mapTask: multi-assignee opgave henter navn fra assignees[], ikke legacy-feltet alene', () => {
	const nowMs = Date.now();
	const raw = mockData.mockInProgressTasksResponse(nowMs).data[1]; // WPC-0219
	const mapped = adapter.mapTask(raw, baseConfig, 'in_progress');

	assert.deepEqual(mapped.assignedNames.sort(), ['Peter Sørensen', 'Sofie Jensen'].sort());
	// startedAt skal falde tilbage til den aktive assignees started_at, når opgavens
	// eget started_at-felt er sat forkert/mangler i multi-assignee-tilfælde.
	assert.equal(mapped.startedAt, raw.started_at);
});

test('mapTask: håndterer tal leveret som strenge uden at fejle', () => {
	const nowMs = Date.now();
	const raw = mockData.mockCompletedTasksResponse(nowMs).data[1]; // duration_seconds: '3300', id er number her men vi tester string-id separat
	const mapped = adapter.mapTask(raw, baseConfig, 'completed');
	assert.equal(mapped.id, 118);
	assert.equal(mapped.completedAt, raw.completed_at);

	const stringIdRaw = { ...raw, id: '999' };
	const mappedStringId = adapter.mapTask(stringIdRaw, baseConfig, 'completed');
	assert.equal(mappedStringId.id, 999);
	assert.equal(typeof mappedStringId.id, 'number');
});

test('mapTask: null-felter og manglende felter giver fornuftige fallbacks, ikke en fejl', () => {
	const raw = {
		id: 5,
		task_number: null,
		title: null,
		description: null,
		assigned_to: null,
		assigned_name: '',
		started_at: null,
		completed_at: null,
		assignees: [],
	};

	assert.doesNotThrow(() => {
		const inProgress = adapter.mapTask(raw, baseConfig, 'in_progress');
		assert.equal(inProgress.taskNumber, '#5');
		assert.equal(inProgress.title, 'Uden titel');
		assert.equal(inProgress.startedAt, null);
		assert.deepEqual(inProgress.assignedNames, []);
	});
});

test('mapTask: ukendt/uventet opgave-shape (fx null) giver null i stedet for at kaste', () => {
	assert.equal(adapter.mapTask(null, baseConfig, 'in_progress'), null);
	assert.equal(adapter.mapTask(undefined, baseConfig, 'in_progress'), null);
	assert.equal(adapter.mapTask({}, baseConfig, 'in_progress'), null); // intet id
});

test('mapTask: SHOW_ASSIGNEES=false udelader assignedNames-feltet helt', () => {
	const raw = mockData.mockInProgressTasksResponse().data[0];
	const config = { ...baseConfig, showAssignees: false };
	const mapped = adapter.mapTask(raw, config, 'in_progress');
	assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'assignedNames'), false);
});

test('filterAndSortCompleted: filtrerer til i dag ELLER inden for lookback-vinduet, sorterer nyest først, begrænser antal', () => {
	const nowMs = Date.now();
	const raw = mockData.mockCompletedTasksResponse(nowMs).data;
	const mapped = raw.map((r) => adapter.mapTask(r, baseConfig, 'completed'));

	// WPC-0101 er (i mock-dataene) bevidst afsluttet 30 timer før $nowMs —
	// hverken "i dag" eller inden for standard-lookback (24t), skal derfor
	// filtreres væk.
	const result = adapter.filterAndSortCompleted(mapped, baseConfig, nowMs);

	assert.deepEqual(result.map((t) => t.taskNumber), ['WPC-0122', 'WPC-0118']);
});

test('filterAndSortCompleted: en udvidet lookback-periode kan trække gårsdagens opgave med ind', () => {
	const nowMs = Date.now();
	const raw = mockData.mockCompletedTasksResponse(nowMs).data;
	const config = { ...baseConfig, completedLookbackHours: 48 };
	const mapped = raw.map((r) => adapter.mapTask(r, config, 'completed'));

	const result = adapter.filterAndSortCompleted(mapped, config, nowMs);

	assert.ok(result.some((t) => t.taskNumber === 'WPC-0101'));
});

test('filterAndSortCompleted: respekterer COMPLETED_TASK_LIMIT', () => {
	const nowMs = Date.now();
	const raw = mockData.mockCompletedTasksResponse(nowMs).data;
	const config = { ...baseConfig, completedTaskLimit: 1 };
	const mapped = raw.map((r) => adapter.mapTask(r, config, 'completed'));

	const result = adapter.filterAndSortCompleted(mapped, config, nowMs);
	assert.equal(result.length, 1);
	assert.equal(result[0].taskNumber, 'WPC-0122');
});

test('filterAndSortCompleted: tomt input giver tom liste uden fejl', () => {
	assert.deepEqual(adapter.filterAndSortCompleted([], baseConfig, Date.now()), []);
});

test('sortInProgress: ældste igangværende opgave først', () => {
	const nowMs = Date.now();
	const raw = mockData.mockInProgressTasksResponse(nowMs).data;
	const mapped = raw.map((r) => adapter.mapTask(r, baseConfig, 'in_progress'));
	const sorted = adapter.sortInProgress(mapped);

	// WPC-0219 startede for 160 min siden, WPC-0231 for 105 min siden, WPC-0240 for 25 min siden.
	assert.deepEqual(sorted.map((t) => t.taskNumber), ['WPC-0219', 'WPC-0231', 'WPC-0240']);
});

test('mapShift: kombinerer shift_date + start_time/end_time til korrekt ISO 8601 med offset, og bevarer ukendt status uændret', () => {
	const raw = mockData.mockShiftsResponse().data[0]; // Aftenvagt
	const mapped = adapter.mapShift(raw, baseConfig);

	assert.equal(mapped.title, 'Aftenvagt');
	assert.equal(mapped.startTime, time.combineDateTime(raw.shift_date, raw.start_time, baseConfig.timezone));
	assert.equal(mapped.endTime, time.combineDateTime(raw.shift_date, raw.end_time, baseConfig.timezone));
	assert.equal(mapped.status, 'open');

	const forbidden = ['description', 'location', 'created_by', 'signup_type', 'arrangement_id', 'user_count'];
	for (const key of forbidden) {
		assert.equal(Object.prototype.hasOwnProperty.call(mapped, key), false, `${key} må ikke være i output`);
	}

	const weird = adapter.mapShift({ ...raw, status: 'noget_helt_nyt' }, baseConfig);
	assert.equal(weird.status, 'noget_helt_nyt');
});

test('mapShift: overnatningsvagt (end_time < start_time) rykker sluttidspunktet til dagen efter', () => {
	const raw = mockData.mockShiftsResponse().data[2]; // Natvagt: samme shift_date, 22:00–06:00
	const mapped = adapter.mapShift(raw, baseConfig);

	assert.equal(mapped.startTime, time.combineDateTime(raw.shift_date, raw.start_time, baseConfig.timezone));
	assert.equal(mapped.endTime, time.combineDateTime(time.addDays(raw.shift_date, 1), raw.end_time, baseConfig.timezone));
	assert.ok(Date.parse(mapped.endTime) > Date.parse(mapped.startTime), 'endTime skal ligge efter startTime');
});

test('mapShift: manglende max_users/location/description fejler ikke', () => {
	const raw = mockData.mockShiftsResponse().data[2]; // Natvagt, max_users: null
	assert.doesNotThrow(() => adapter.mapShift(raw, baseConfig));
});

test('filterAndSortShifts: aktuelle vagter før kommende, afsluttede vagter (endTime i fortiden) filtreres væk', () => {
	const nowMs = Date.now();
	const raw = mockData.mockShiftsResponse(nowMs).data;
	const mapped = raw.map((r) => adapter.mapShift(r, baseConfig));

	// Aftenvagt er i gang lige nu (startede for 1t siden), Dagvagt og Natvagt
	// ligger begge ude i fremtiden (Dagvagt nærmest) — den aflyste Ekstravagt
	// er allerede overstået (endte for 8t siden) og skal filtreres væk.
	const result = adapter.filterAndSortShifts(mapped, nowMs);

	assert.deepEqual(result.map((s) => s.title), ['Aftenvagt', 'Dagvagt', 'Natvagt']);
});

test('filterAndSortShifts: tomt input giver tom liste', () => {
	assert.deepEqual(adapter.filterAndSortShifts([], Date.now()), []);
});

test('extractAssignedNames: falder tilbage til legacy assigned_name når assignees[] er tom', () => {
	const names = adapter.extractAssignedNames({ assignees: [], assigned_name: 'Legacy Navn' });
	assert.deepEqual(names, ['Legacy Navn']);
});

test('extractAssignedNames: ingen data giver tom liste, ikke en fejl', () => {
	assert.deepEqual(adapter.extractAssignedNames({}), []);
	assert.deepEqual(adapter.extractAssignedNames({ assignees: null, assigned_name: null }), []);
});

// ---- Netværkslag: timeout, HTTP-fejl, tomme/ændrede svarformater ----------

test('createAdapter (live): API-timeout kaster en fejl (så server.js kan falde tilbage til cache)', async () => {
	const originalFetch = global.fetch;
	global.fetch = (url, opts) =>
		new Promise((_resolve, reject) => {
			opts.signal.addEventListener('abort', () => {
				const err = new Error('The operation was aborted');
				err.name = 'AbortError';
				reject(err);
			});
		});

	try {
		const config = { ...baseConfig, apiMode: 'live', wpBaseUrl: 'https://example.invalid', wpApiNamespace: '/wp-json/wp-community/v1', wpUsername: 'u', wpApplicationPassword: 'p', fetchTimeoutMs: 20, arrangementId: null };
		const adapterInstance = adapter.createAdapter(config);
		await assert.rejects(() => adapterInstance.fetchInProgressTasks(), /Tidsudløb/);
	} finally {
		global.fetch = originalFetch;
	}
});

test('createAdapter (live): ikke-2xx HTTP-status kaster en fejl', async () => {
	const originalFetch = global.fetch;
	global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

	try {
		const config = { ...baseConfig, apiMode: 'live', wpBaseUrl: 'https://example.invalid', wpApiNamespace: '/wp-json/wp-community/v1', wpUsername: 'u', wpApplicationPassword: 'p', fetchTimeoutMs: 1000, arrangementId: null };
		const adapterInstance = adapter.createAdapter(config);
		await assert.rejects(() => adapterInstance.fetchShifts(), /status 503/);
	} finally {
		global.fetch = originalFetch;
	}
});

test('createAdapter (live): tomt data-array er en gyldig tilstand, ikke en fejl', async () => {
	const originalFetch = global.fetch;
	global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) });

	try {
		const config = { ...baseConfig, apiMode: 'live', wpBaseUrl: 'https://example.invalid', wpApiNamespace: '/wp-json/wp-community/v1', wpUsername: 'u', wpApplicationPassword: 'p', fetchTimeoutMs: 1000, arrangementId: null };
		const adapterInstance = adapter.createAdapter(config);
		const tasks = await adapterInstance.fetchInProgressTasks();
		assert.deepEqual(tasks, []);
	} finally {
		global.fetch = originalFetch;
	}
});

test('createAdapter (live): ændret/uventet svarformat (data er ikke en liste) kaster i stedet for at give korrupt output', async () => {
	const originalFetch = global.fetch;
	global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { unexpected: 'shape' } }) });

	try {
		const config = { ...baseConfig, apiMode: 'live', wpBaseUrl: 'https://example.invalid', wpApiNamespace: '/wp-json/wp-community/v1', wpUsername: 'u', wpApplicationPassword: 'p', fetchTimeoutMs: 1000, arrangementId: null };
		const adapterInstance = adapter.createAdapter(config);
		await assert.rejects(() => adapterInstance.fetchCompletedTasks(), /svarformat/);
	} finally {
		global.fetch = originalFetch;
	}
});

// ---- Arrangement-scoping (ARRANGEMENT_ID tomt = "alle aktive arrangementer") ----

test('filterToActiveArrangements: beholder kun elementer hvis arrangement_id er i det aktive sæt', () => {
	const items = [
		{ id: 1, arrangement_id: 3 },
		{ id: 2, arrangement_id: 5 },
		{ id: 3, arrangement_id: null },
		{ id: 4 }, // arrangement_id helt udeladt
	];
	const activeIds = new Set([3, 7]);
	const result = adapter.filterToActiveArrangements(items, activeIds);
	assert.deepEqual(result.map((i) => i.id), [1]);
});

test('filterToActiveArrangements: activeIds=null (mock-mode/eksplicit ARRANGEMENT_ID) returnerer input uændret', () => {
	const items = [{ id: 1, arrangement_id: 3 }];
	assert.deepEqual(adapter.filterToActiveArrangements(items, null), items);
});

test('createAdapter (live, intet ARRANGEMENT_ID): henter aktive arrangementer og filtrerer til dem — ét delt /arrangements-kald for alle tre lister', async () => {
	const originalFetch = global.fetch;
	let arrangementsCallCount = 0;

	global.fetch = async (url) => {
		if (url.pathname.endsWith('/arrangements')) {
			arrangementsCallCount += 1;
			return { ok: true, status: 200, json: async () => ({ success: true, data: [{ id: 3, title: 'Aktivt', status: 'active' }] }) };
		}
		if (url.pathname.endsWith('/tasks')) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					success: true,
					data: [
						{ id: 1, task_number: 'A-1', title: 'Hører til aktivt arrangement', status: 'in_progress', arrangement_id: 3, started_at: '2026-07-14T10:00:00+02:00', assignees: [] },
						{ id: 2, task_number: 'A-2', title: 'Hører til et IKKE-aktivt arrangement', status: 'in_progress', arrangement_id: 99, started_at: '2026-07-14T10:00:00+02:00', assignees: [] },
					],
				}),
			};
		}
		if (url.pathname.endsWith('/shifts')) {
			return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
		}
		throw new Error('uventet sti: ' + url.pathname);
	};

	try {
		const config = { ...baseConfig, apiMode: 'live', wpBaseUrl: 'https://example.invalid', wpApiNamespace: '/wp-json/wp-community/v1', wpUsername: 'u', wpApplicationPassword: 'p', fetchTimeoutMs: 1000, arrangementId: null };
		const adapterInstance = adapter.createAdapter(config);

		const [inProgress, completed, shifts] = await Promise.all([
			adapterInstance.fetchInProgressTasks(),
			adapterInstance.fetchCompletedTasks(),
			adapterInstance.fetchShifts(),
		]);

		assert.deepEqual(inProgress.map((t) => t.taskNumber), ['A-1']);
		assert.deepEqual(completed, []);
		assert.deepEqual(shifts, []);
		assert.equal(arrangementsCallCount, 1, '/arrangements skal kun kaldes én gang, delt mellem de tre parallelle kald');
	} finally {
		global.fetch = originalFetch;
	}
});

test('createAdapter (live, ARRANGEMENT_ID sat): kalder aldrig /arrangements, sender arrangement_id direkte som parameter', async () => {
	const originalFetch = global.fetch;
	let arrangementsCalled = false;

	global.fetch = async (url) => {
		if (url.pathname.endsWith('/arrangements')) arrangementsCalled = true;
		assert.equal(url.searchParams.get('arrangement_id'), '3');
		return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
	};

	try {
		const config = { ...baseConfig, apiMode: 'live', wpBaseUrl: 'https://example.invalid', wpApiNamespace: '/wp-json/wp-community/v1', wpUsername: 'u', wpApplicationPassword: 'p', fetchTimeoutMs: 1000, arrangementId: 3 };
		const adapterInstance = adapter.createAdapter(config);
		await adapterInstance.fetchInProgressTasks();
		assert.equal(arrangementsCalled, false);
	} finally {
		global.fetch = originalFetch;
	}
});

// ---- Kommende opgaver (status "planned", tidsvindue) -----------------------

test('mapTask ("planned"): scheduledAt hentes fra appointment_time, med fallback til due_date', () => {
	const raw = mockData.mockUpcomingTasksResponse().data[0]; // har appointment_time
	const mapped = adapter.mapTask(raw, baseConfig, 'planned');
	assert.equal(mapped.status, 'planned');
	assert.equal(mapped.scheduledAt, raw.appointment_time);
	assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'startedAt'), false);
	assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'completedAt'), false);

	const dueDateOnly = mockData.mockUpcomingTasksResponse().data[1]; // kun due_date
	const mappedDueDate = adapter.mapTask(dueDateOnly, baseConfig, 'planned');
	assert.equal(mappedDueDate.scheduledAt, dueDateOnly.due_date);
});

test('mapTask ("planned"): ingen tidspunkt sat giver scheduledAt=null, ikke en fejl', () => {
	const raw = { id: 1, task_number: 'X-1', title: 'Uden tid', appointment_time: null, due_date: null, assignees: [] };
	const mapped = adapter.mapTask(raw, baseConfig, 'planned');
	assert.equal(mapped.scheduledAt, null);
});

test('filterAndSortUpcoming: kun opgaver inden for (nu, nu+lookahead], nærmeste først, begrænset til UPCOMING_TASK_LIMIT', () => {
	// mock-dataene bygges relativt til et givet nowMs (se mock-data.js) — brug
	// samme nowMs til filtreringen, så testen er uafhængig af hvornår den køres.
	const nowMs = Date.now();
	const raw = mockData.mockUpcomingTasksResponse(nowMs).data;
	const mapped = raw.map((r) => adapter.mapTask(r, baseConfig, 'planned'));
	const config = { ...baseConfig, upcomingLookaheadHours: 24, upcomingTaskLimit: 10 };
	const result = adapter.filterAndSortUpcoming(mapped, config, nowMs);

	// WPC-0132 ligger 3 dage ude — uden for 24-timers-vinduet, skal filtreres væk.
	assert.deepEqual(result.map((t) => t.taskNumber), ['WPC-0130', 'WPC-0131']);
});

test('filterAndSortUpcoming: en opgave med et tidspunkt der allerede er passeret, filtreres væk', () => {
	const config = { ...baseConfig, upcomingLookaheadHours: 24, upcomingTaskLimit: 10 };
	const nowMs = Date.parse('2026-07-16T12:00:00+02:00');
	const tasks = [
		adapter.mapTask({ id: 1, task_number: 'A', title: 'Fortid', appointment_time: '2026-07-16T10:00:00+02:00', assignees: [] }, config, 'planned'),
		adapter.mapTask({ id: 2, task_number: 'B', title: 'Fremtid', appointment_time: '2026-07-16T14:00:00+02:00', assignees: [] }, config, 'planned'),
	];
	const result = adapter.filterAndSortUpcoming(tasks, config, nowMs);
	assert.deepEqual(result.map((t) => t.taskNumber), ['B']);
});

test('filterAndSortUpcoming: respekterer UPCOMING_TASK_LIMIT', () => {
	const config = { ...baseConfig, upcomingLookaheadHours: 24, upcomingTaskLimit: 1 };
	const nowMs = Date.parse('2026-07-16T12:00:00+02:00');
	const tasks = [
		adapter.mapTask({ id: 1, task_number: 'A', title: 'Først', appointment_time: '2026-07-16T13:00:00+02:00', assignees: [] }, config, 'planned'),
		adapter.mapTask({ id: 2, task_number: 'B', title: 'Senere', appointment_time: '2026-07-16T15:00:00+02:00', assignees: [] }, config, 'planned'),
	];
	const result = adapter.filterAndSortUpcoming(tasks, config, nowMs);
	assert.deepEqual(result.map((t) => t.taskNumber), ['A']);
});

test('filterAndSortUpcoming: tomt input giver tom liste', () => {
	assert.deepEqual(adapter.filterAndSortUpcoming([], baseConfig, Date.now()), []);
});

// ---- Vagt-deltagernavne (SHOW_SHIFT_NAMES) ---------------------------------

test('mapShift: participantNames udelades helt når SHOW_SHIFT_NAMES ikke er sat', () => {
	const raw = mockData.mockShiftsResponse().data[0]; // har users[]
	const mapped = adapter.mapShift(raw, baseConfig); // baseConfig har ikke showShiftNames
	assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'participantNames'), false);
});

test('mapShift: SHOW_SHIFT_NAMES=true giver kun fornavne, ikke fulde navne, og springer annullerede deltagere over', () => {
	const raw = mockData.mockShiftsResponse().data[0]; // Mikkel Rasmussen, Sofie Jensen, + Afmeldt Person (cancelled)
	const config = { ...baseConfig, showShiftNames: true };
	const mapped = adapter.mapShift(raw, config);
	assert.deepEqual(mapped.participantNames.sort(), ['Mikkel', 'Sofie'].sort());
});

test('extractShiftFirstNames: ingen users[] giver tom liste, ikke en fejl', () => {
	assert.deepEqual(adapter.extractShiftFirstNames({}), []);
	assert.deepEqual(adapter.extractShiftFirstNames({ users: null }), []);
});

test('extractShiftFirstNames: dedup + trimmer whitespace i navnet', () => {
	const names = adapter.extractShiftFirstNames({
		users: [
			{ name: '  Anna Andersen ', status: 'assigned' },
			{ name: 'Anna Berg', status: 'confirmed' }, // samme fornavn, anden person — skal ikke dubleres væk fejlagtigt kun hvis identisk streng
		],
	});
	assert.deepEqual(names, ['Anna']); // begge er "Anna" som fornavn — dedupliceres bevidst til én visning
});

test('createAdapter (live): getRawShifts sender include_users=1 når SHOW_SHIFT_NAMES=true, ellers 0', async () => {
	const originalFetch = global.fetch;
	const seenIncludeUsers = [];

	global.fetch = async (url) => {
		seenIncludeUsers.push(url.searchParams.get('include_users'));
		return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
	};

	try {
		const configOn = { ...baseConfig, apiMode: 'live', wpBaseUrl: 'https://example.invalid', wpApiNamespace: '/wp-json/wp-community/v1', wpUsername: 'u', wpApplicationPassword: 'p', fetchTimeoutMs: 1000, arrangementId: 3, showShiftNames: true };
		await adapter.createAdapter(configOn).fetchShifts();

		const configOff = { ...configOn, showShiftNames: false };
		await adapter.createAdapter(configOff).fetchShifts();

		assert.deepEqual(seenIncludeUsers, ['1', '0']);
	} finally {
		global.fetch = originalFetch;
	}
});
