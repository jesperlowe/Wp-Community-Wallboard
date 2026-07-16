'use strict';

const time = require('./time');

const TZ = 'Europe/Copenhagen';

/**
 * Realistiske danske eksempeldata til API_MODE=mock. Formen efterligner
 * NØJAGTIGT det rå svar fra WordPress-pluginerne (WPC_Tasks::format_task() /
 * WPC_Shifts::format_shift(), begge pakket i {success:true, data:[...]}) —
 * så samme mapping-/saneringskode i wordpress-adapter.js bruges uanset
 * API_MODE. Et par felter er bevidst "grimme" (streng i stedet for tal, en
 * tom assignees-liste) for at ligne virkelige, ikke-fuldt-migrerede data.
 */

function envelope(data) {
	return { success: true, data };
}

/**
 * [2026-07-16, bugfix] Al mock-data er relativ til et $nowMs-tidspunkt
 * (default: det ægte Date.now()) i stedet for faste kalenderdatoer.
 * Adapteren filtrerer "afsluttet i dag"/"kommende"/"aktuelle vagter" mod det
 * RIGTIGE ur — faste datoer virkede fint da de blev skrevet, men viste sig
 * kort efter (blot et par dage senere) at give tomme lister i mock-mode,
 * fordi hverken "afsluttet i dag" eller "vagt endnu ikke overstået" længere
 * var sandt for 2026-07-14-datoerne. Tests der har brug for et deterministisk
 * resultat sender selv et fast $nowMs ind til disse funktioner.
 */
function relativeIso(nowMs, minutesFromNow) {
	return time.formatInstantIso(nowMs + minutesFromNow * 60 * 1000, TZ);
}

function relativeDateAndTime(nowMs, hoursFromNow) {
	const iso = relativeIso(nowMs, hoursFromNow * 60);
	return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

function relativeDateOnly(nowMs, daysFromNow) {
	return time.addDays(time.dateKeyInTimezone(nowMs, TZ), daysFromNow);
}

function mockInProgressTasksResponse(nowMs = Date.now()) {
	return envelope([
		{
			id: 231,
			task_number: 'WPC-0231',
			title: 'Levering af telte til hovedplads',
			description: 'Skal stå klar inden kl. 16 — se vagtplan for hjælpere.',
			task_type: 'delivery',
			status: 'in_progress',
			priority: 'high',
			pickup_address: 'Lagervej 3, 8600 Silkeborg',
			delivery_address: 'Skovpladsen 1, 8600 Silkeborg',
			contact_name: 'Anders Holm',
			contact_phone: '+45 20 30 40 50',
			assigned_to: 14,
			assigned_name: 'Mikkel Rasmussen',
			assigned_vehicle: 'Trailer 2',
			started_at: relativeIso(nowMs, -105),
			completed_at: null,
			duration_seconds: null,
			created_at: relativeIso(nowMs, -180),
			assignees: [
				{ user_id: 14, display_name: 'Mikkel Rasmussen', status: 'in_progress', started_at: relativeIso(nowMs, -105) },
			],
			effective_status: 'in_progress',
		},
		{
			// Multi-assignee opgave: task.status er stadig 'assigned', men én
			// assignee er i gang — matcher den rigtige API's OR-logik for
			// status=in_progress, se WPC_Tasks::get_tasks().
			id: 219,
			task_number: 'WPC-0219',
			title: 'Transport af scenemateriel',
			description: null,
			task_type: 'transport',
			status: 'assigned',
			priority: 'normal',
			pickup_address: '',
			delivery_address: '',
			contact_name: '',
			contact_phone: '',
			assigned_to: null,
			assigned_name: '',
			assigned_vehicle: '',
			started_at: relativeIso(nowMs, -160),
			completed_at: null,
			duration_seconds: null,
			created_at: relativeIso(nowMs, -200),
			assignees: [
				{ user_id: 22, display_name: 'Sofie Jensen', status: 'in_progress', started_at: relativeIso(nowMs, -160) },
				{ user_id: 31, display_name: 'Peter Sørensen', status: 'assigned', started_at: null },
			],
			effective_status: 'in_progress',
		},
		{
			// Bevidst "grimt" felt: duration_seconds leveret som streng.
			id: 240,
			task_number: 'WPC-0240',
			title: 'Affaldshåndtering, område B',
			description: 'Interne noter der aldrig må vises på wallboardet.',
			task_type: 'service',
			status: 'in_progress',
			priority: 'low',
			assigned_to: '19',
			assigned_name: 'Camilla Berg',
			started_at: relativeIso(nowMs, -25),
			completed_at: null,
			duration_seconds: '0',
			created_at: relativeIso(nowMs, -30),
			assignees: [],
			effective_status: 'in_progress',
		},
	]);
}

function mockCompletedTasksResponse(nowMs = Date.now()) {
	return envelope([
		{
			id: 122,
			task_number: 'WPC-0122',
			title: 'Afhentning af lydudstyr',
			description: '',
			task_type: 'pickup',
			status: 'completed',
			priority: 'normal',
			assigned_to: 8,
			assigned_name: 'Thomas Lund',
			started_at: relativeIso(nowMs, -75),
			completed_at: relativeIso(nowMs, -35),
			duration_seconds: 2400,
			created_at: relativeIso(nowMs, -100),
			assignees: [
				{ user_id: 8, display_name: 'Thomas Lund', status: 'completed', started_at: relativeIso(nowMs, -75), stopped_at: relativeIso(nowMs, -35) },
			],
			effective_status: 'completed',
		},
		{
			id: 118,
			task_number: 'WPC-0118',
			title: 'Service på generator',
			description: '',
			task_type: 'service',
			status: 'completed',
			priority: 'urgent',
			assigned_to: null,
			assigned_name: '',
			started_at: relativeIso(nowMs, -145),
			completed_at: relativeIso(nowMs, -90),
			duration_seconds: '3300',
			created_at: relativeIso(nowMs, -160),
			assignees: [
				{ user_id: 27, display_name: 'Emil Kristensen', status: 'completed', started_at: relativeIso(nowMs, -145), stopped_at: relativeIso(nowMs, -90) },
			],
			effective_status: 'completed',
		},
		{
			// 30 timer siden — solidt uden for standard-lookback (24t) og en
			// anden kalenderdag, men stadig inden for en evt. udvidet
			// 48-timers lookback; skal filtreres væk af "i dag ELLER
			// lookback"-reglen med standardkonfiguration (se
			// filterAndSortCompleted()). Bevidst IKKE sat til præcis
			// grænseværdien (fx 24t/48t) — ISO-strenge trunkeres til hele
			// sekunder, så en test på selve grænsen bliver sub-millisekund-skør.
			id: 101,
			task_number: 'WPC-0101',
			title: 'Opsætning af skilte',
			description: '',
			task_type: 'general',
			status: 'completed',
			priority: 'low',
			assigned_to: 5,
			assigned_name: 'Nanna Vestergaard',
			started_at: relativeIso(nowMs, -30 * 60 - 70),
			completed_at: relativeIso(nowMs, -30 * 60),
			duration_seconds: 4200,
			created_at: relativeIso(nowMs, -30 * 60 - 100),
			assignees: [
				{ user_id: 5, display_name: 'Nanna Vestergaard', status: 'completed', started_at: relativeIso(nowMs, -30 * 60 - 70), stopped_at: relativeIso(nowMs, -30 * 60) },
			],
			effective_status: 'completed',
		},
	]);
}

function mockUpcomingTasksResponse(nowMs = Date.now()) {
	return envelope([
		{
			id: 130,
			task_number: 'WPC-0130',
			title: 'Klargøring af scene til aftenshow',
			description: '',
			task_type: 'general',
			status: 'planned',
			priority: 'normal',
			assigned_to: null,
			assigned_name: '',
			appointment_time: relativeIso(nowMs, 3 * 60), // om 3 timer
			due_date: null,
			created_at: relativeIso(nowMs, -60),
			assignees: [],
			effective_status: 'planned',
		},
		{
			// Ingen aftaletid — falder tilbage til due_date (deadline).
			id: 131,
			task_number: 'WPC-0131',
			title: 'Bestil ekstra vand til boderne',
			description: '',
			task_type: 'general',
			status: 'planned',
			priority: 'high',
			assigned_to: 9,
			assigned_name: 'Rasmus Holm',
			appointment_time: null,
			due_date: relativeIso(nowMs, 10 * 60), // om 10 timer
			created_at: relativeIso(nowMs, -30),
			assignees: [],
			effective_status: 'planned',
		},
		{
			// Uden for standard-lookahead (24t) — viser at filtreringen reelt virker, også i mock-mode.
			id: 132,
			task_number: 'WPC-0132',
			title: 'Nedtagning efter arrangement',
			description: '',
			task_type: 'general',
			status: 'planned',
			priority: 'low',
			assigned_to: null,
			assigned_name: '',
			appointment_time: relativeIso(nowMs, 3 * 24 * 60), // om 3 dage
			due_date: null,
			created_at: relativeIso(nowMs, -10),
			assignees: [],
			effective_status: 'planned',
		},
	]);
}

function mockShiftsResponse(nowMs = Date.now()) {
	const evening = relativeDateAndTime(nowMs, -1); // startede for 1 time siden
	const eveningEnd = relativeDateAndTime(nowMs, 2); // slutter om 2 timer — "aktuel" lige nu
	const day = relativeDateAndTime(nowMs, 4); // starter om 4 timer
	const dayEnd = relativeDateAndTime(nowMs, 10); // — "kommende"
	const nightDate = relativeDateOnly(nowMs, 1); // i morgen
	const cancelledStart = relativeDateAndTime(nowMs, -10);
	const cancelledEnd = relativeDateAndTime(nowMs, -8); // allerede overstået

	return envelope([
		{
			id: 45,
			title: 'Aftenvagt',
			shift_date: evening.date,
			start_time: evening.time,
			end_time: eveningEnd.time,
			location: 'Hovedindgang',
			description: 'Skal ikke vises på wallboardet.',
			arrangement_id: 3,
			signup_type: 'open',
			max_users: 4,
			user_count: 2,
			status: 'open',
			created_by: 2,
			// Bruges kun når SHOW_SHIFT_NAMES=true (include_users-parameteren).
			users: [
				{ user_id: 14, name: 'Mikkel Rasmussen', role: '', status: 'assigned', note: '' },
				{ user_id: 22, name: 'Sofie Jensen', role: '', status: 'confirmed', note: '' },
				{ user_id: 99, name: 'Afmeldt Person', role: '', status: 'cancelled', note: '' },
			],
		},
		{
			id: 44,
			title: 'Dagvagt',
			shift_date: day.date,
			start_time: day.time,
			end_time: dayEnd.time,
			location: 'Hovedindgang',
			description: '',
			arrangement_id: 3,
			signup_type: 'open',
			max_users: 3,
			user_count: 3,
			status: 'full',
			created_by: 2,
			users: [
				{ user_id: 8, name: 'Thomas Lund', role: '', status: 'assigned', note: '' },
				{ user_id: 27, name: 'Emil Kristensen', role: '', status: 'assigned', note: '' },
				{ user_id: 5, name: 'Nanna Vestergaard', role: '', status: 'assigned', note: '' },
			],
		},
		{
			// max_users mangler (null) — "ubegrænset" plads, skal ikke fejle.
			// Overnatningsvagt (22:00–06:00, samme shift_date for begge i WP) —
			// tester dags-rul-logikken i mapShift().
			id: 47,
			title: 'Natvagt',
			shift_date: nightDate,
			start_time: '22:00:00',
			end_time: '06:00:00',
			location: '',
			description: '',
			arrangement_id: 3,
			signup_type: 'open',
			max_users: null,
			user_count: 1,
			status: 'open',
			created_by: 2,
		},
		{
			// Allerede overstået og aflyst — bruges til at teste mapShift()s
			// status-fallback direkte; forventes filtreret væk af
			// filterAndSortShifts() (endTime ligger i fortiden).
			id: 40,
			title: 'Ekstravagt, aflyst',
			shift_date: cancelledStart.date,
			start_time: cancelledStart.time,
			end_time: cancelledEnd.time,
			location: '',
			description: '',
			arrangement_id: 3,
			signup_type: 'open',
			max_users: 2,
			user_count: 0,
			status: 'cancelled',
			created_by: 2,
		},
	]);
}

module.exports = {
	mockInProgressTasksResponse,
	mockCompletedTasksResponse,
	mockUpcomingTasksResponse,
	mockShiftsResponse,
};
