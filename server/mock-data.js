'use strict';

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

function mockInProgressTasksResponse() {
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
			started_at: '2026-07-14T11:45:00+02:00',
			completed_at: null,
			duration_seconds: null,
			created_at: '2026-07-14T09:00:00+02:00',
			assignees: [
				{ user_id: 14, display_name: 'Mikkel Rasmussen', status: 'in_progress', started_at: '2026-07-14T11:45:00+02:00' },
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
			started_at: '2026-07-14T10:20:00+02:00',
			completed_at: null,
			duration_seconds: null,
			created_at: '2026-07-14T08:15:00+02:00',
			assignees: [
				{ user_id: 22, display_name: 'Sofie Jensen', status: 'in_progress', started_at: '2026-07-14T10:20:00+02:00' },
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
			started_at: '2026-07-14T13:05:00+02:00',
			completed_at: null,
			duration_seconds: '0',
			created_at: '2026-07-14T13:00:00+02:00',
			assignees: [],
			effective_status: 'in_progress',
		},
	]);
}

function mockCompletedTasksResponse() {
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
			started_at: '2026-07-14T10:50:00+02:00',
			completed_at: '2026-07-14T11:30:00+02:00',
			duration_seconds: 2400,
			created_at: '2026-07-14T09:30:00+02:00',
			assignees: [
				{ user_id: 8, display_name: 'Thomas Lund', status: 'completed', started_at: '2026-07-14T10:50:00+02:00', stopped_at: '2026-07-14T11:30:00+02:00' },
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
			started_at: '2026-07-14T09:00:00+02:00',
			completed_at: '2026-07-14T09:55:00+02:00',
			duration_seconds: '3300',
			created_at: '2026-07-14T08:00:00+02:00',
			assignees: [
				{ user_id: 27, display_name: 'Emil Kristensen', status: 'completed', started_at: '2026-07-14T09:00:00+02:00', stopped_at: '2026-07-14T09:55:00+02:00' },
			],
			effective_status: 'completed',
		},
		{
			// Afsluttet i går — skal filtreres væk af "i dag ELLER lookback"-reglen,
			// medmindre COMPLETED_LOOKBACK_HOURS er sat højt nok til at nå den.
			id: 101,
			task_number: 'WPC-0101',
			title: 'Opsætning af skilte',
			description: '',
			task_type: 'general',
			status: 'completed',
			priority: 'low',
			assigned_to: 5,
			assigned_name: 'Nanna Vestergaard',
			started_at: '2026-07-13T15:00:00+02:00',
			completed_at: '2026-07-13T16:10:00+02:00',
			duration_seconds: 4200,
			created_at: '2026-07-13T14:00:00+02:00',
			assignees: [
				{ user_id: 5, display_name: 'Nanna Vestergaard', status: 'completed', started_at: '2026-07-13T15:00:00+02:00', stopped_at: '2026-07-13T16:10:00+02:00' },
			],
			effective_status: 'completed',
		},
	]);
}

function mockShiftsResponse() {
	return envelope([
		{
			id: 45,
			title: 'Aftenvagt',
			shift_date: '2026-07-14',
			start_time: '18:00:00',
			end_time: '22:00:00',
			location: 'Hovedindgang',
			description: 'Skal ikke vises på wallboardet.',
			arrangement_id: 3,
			signup_type: 'open',
			max_users: 4,
			user_count: 2,
			status: 'open',
			created_by: 2,
		},
		{
			id: 44,
			title: 'Dagvagt',
			shift_date: '2026-07-14',
			start_time: '08:00:00',
			end_time: '16:00:00',
			location: 'Hovedindgang',
			description: '',
			arrangement_id: 3,
			signup_type: 'open',
			max_users: 3,
			user_count: 3,
			status: 'full',
			created_by: 2,
		},
		{
			// max_users mangler (null) — "ubegrænset" plads, skal ikke fejle.
			id: 47,
			title: 'Natvagt',
			shift_date: '2026-07-15',
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
			// Gammel/aflyst vagt — skal kunne vises med en læsbar fallback-status.
			id: 40,
			title: 'Ekstravagt, aflyst',
			shift_date: '2026-07-14',
			start_time: '12:00:00',
			end_time: '14:00:00',
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
	mockShiftsResponse,
};
