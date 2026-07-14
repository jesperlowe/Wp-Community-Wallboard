/**
 * Delt dansk statusoversættelse — samme fil bruges direkte i browseren
 * (<script src="status-map.js">, sætter window.WallboardStatusMap) og i
 * Node-tests (require('../frontend/status-map.js')), så der kun findes ét
 * sted der definerer oversættelserne.
 */
(function (root, factory) {
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = factory();
	} else {
		root.WallboardStatusMap = factory();
	}
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	var STATUS_LABELS = {
		planned: 'Planlagt',
		assigned: 'Tildelt',
		in_progress: 'I gang',
		completed: 'Afsluttet',
		cancelled: 'Aflyst',
		open: 'Åben',
		full: 'Fyldt',
	};

	/** Ukendt status → en læsbar version af selve statusværdien (aldrig en fejl). */
	function humanize(value) {
		var text = String(value === null || value === undefined ? '' : value).trim();
		if (!text) return 'Ukendt';
		text = text.replace(/[_-]+/g, ' ').trim();
		return text.charAt(0).toUpperCase() + text.slice(1);
	}

	function translateStatus(status) {
		if (status && Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)) {
			return STATUS_LABELS[status];
		}
		return humanize(status);
	}

	return { STATUS_LABELS: STATUS_LABELS, translateStatus: translateStatus, humanize: humanize };
});
