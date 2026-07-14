(function () {
	'use strict';

	var CONFIG = window.WALLBOARD_CONFIG || {
		refreshSeconds: 30,
		completedTaskLimit: 10,
		pageIntervalSeconds: 10,
	};

	var FETCH_TIMEOUT_MS = 8000;
	var MAX_BACKOFF_MULTIPLIER = 10;

	var PAGE_SIZE = {
		inProgress: 6,
		completed: 5,
		shifts: 4,
	};

	var statusMap = window.WallboardStatusMap || {
		translateStatus: function (s) {
			return s || 'Ukendt';
		},
	};

	// ---- Generiske DOM-hjælpere ------------------------------------------

	function el(tag, className, text) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined && text !== null) node.textContent = text;
		return node;
	}

	function badgeClassFor(status) {
		var safe = String(status || '').replace(/[^a-z0-9_-]/gi, '-');
		return 'badge badge-status-' + safe;
	}

	function formatClock(date) {
		return date.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', hour12: false });
	}

	function formatClockSeconds(date) {
		return date.toLocaleTimeString('da-DK', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
		});
	}

	function formatDate(date) {
		var weekday = date.toLocaleDateString('da-DK', { weekday: 'long' });
		weekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
		var month = date.toLocaleDateString('da-DK', { month: 'long' });
		return weekday + ' ' + date.getDate() + '. ' + month;
	}

	function formatAge(seconds) {
		seconds = Math.max(0, Math.round(seconds || 0));
		if (seconds < 60) return seconds + ' sek.';
		var minutes = Math.floor(seconds / 60);
		if (minutes < 60) return minutes + ' min.';
		var hours = Math.floor(minutes / 60);
		return hours + ' t. ' + (minutes % 60) + ' min.';
	}

	function safeDate(iso) {
		if (!iso) return null;
		var d = new Date(iso);
		return isNaN(d.getTime()) ? null : d;
	}

	/** Blød opdatering: kort opacity-fade i stedet for et hårdt indholds-skift. */
	function fadeSwap(container, renderFn) {
		container.style.opacity = '0';
		window.requestAnimationFrame(function () {
			renderFn();
			window.requestAnimationFrame(function () {
				container.style.opacity = '1';
			});
		});
	}

	// ---- Paginering --------------------------------------------------------

	function createPaginator(listEl, emptyEl, indicatorEl, renderRow) {
		var items = [];
		var pageSize = 1;
		var pageIndex = 0;
		var timer = null;

		function totalPages() {
			return Math.max(1, Math.ceil(items.length / pageSize));
		}

		function renderCurrentPage() {
			listEl.innerHTML = '';

			if (items.length === 0) {
				listEl.hidden = true;
				emptyEl.hidden = false;
				indicatorEl.hidden = true;
				return;
			}

			listEl.hidden = false;
			emptyEl.hidden = true;

			var start = pageIndex * pageSize;
			var pageItems = items.slice(start, start + pageSize);
			pageItems.forEach(function (item) {
				listEl.appendChild(renderRow(item));
			});

			var pages = totalPages();
			if (pages > 1) {
				indicatorEl.hidden = false;
				indicatorEl.textContent = pageIndex + 1 + ' / ' + pages;
			} else {
				indicatorEl.hidden = true;
			}
		}

		function setItems(newItems, newPageSize) {
			items = newItems || [];
			pageSize = newPageSize;
			pageIndex = 0;
			fadeSwap(listEl, renderCurrentPage);
		}

		function tick() {
			var pages = totalPages();
			if (pages <= 1) return;
			pageIndex = (pageIndex + 1) % pages;
			fadeSwap(listEl, renderCurrentPage);
		}

		function start(intervalMs) {
			stop();
			timer = setInterval(tick, intervalMs);
		}

		function stop() {
			if (timer) clearInterval(timer);
			timer = null;
		}

		return { setItems: setItems, start: start, stop: stop };
	}

	// ---- Rækkebygning ---------------------------------------------------------

	function buildTaskRow(task, timeLabel, timeValueIso) {
		var row = el('div', 'row');

		var main = el('div', 'row-main');
		main.appendChild(el('span', 'row-number', task.taskNumber || ''));
		main.appendChild(el('span', 'row-title', task.title || 'Uden titel'));
		row.appendChild(main);

		var meta = el('div', 'row-meta');
		if (Array.isArray(task.assignedNames) && task.assignedNames.length > 0) {
			meta.appendChild(el('span', 'row-assignee', task.assignedNames.join(', ')));
		}
		var timeText = timeValueIso ? timeLabel + ' ' + formatClock(new Date(timeValueIso)) : timeLabel + ' –';
		meta.appendChild(el('span', 'row-time', timeText));
		row.appendChild(meta);

		row.appendChild(el('span', badgeClassFor(task.status), statusMap.translateStatus(task.status)));

		return row;
	}

	function renderInProgressRow(task) {
		return buildTaskRow(task, 'Startet', task.startedAt);
	}

	function renderCompletedRow(task) {
		return buildTaskRow(task, 'Afsluttet', task.completedAt);
	}

	function renderShiftRow(shift) {
		var row = el('div', 'row');

		var main = el('div', 'row-main');
		main.appendChild(el('span', 'row-title', shift.title || 'Vagt'));
		row.appendChild(main);

		var start = safeDate(shift.startTime);
		var end = safeDate(shift.endTime);
		var timeText = start && end ? formatClock(start) + '–' + formatClock(end) : '–';

		var meta = el('div', 'row-meta');
		meta.appendChild(el('span', 'row-time', timeText));
		row.appendChild(meta);

		row.appendChild(el('span', badgeClassFor(shift.status), statusMap.translateStatus(shift.status)));

		return row;
	}

	// ---- Opsætning af de tre paneler ---------------------------------------

	var inProgressPaginator = createPaginator(
		document.getElementById('inprogress-list'),
		document.getElementById('inprogress-empty'),
		document.getElementById('inprogress-page-indicator'),
		renderInProgressRow
	);

	var completedPaginator = createPaginator(
		document.getElementById('completed-list'),
		document.getElementById('completed-empty'),
		document.getElementById('completed-page-indicator'),
		renderCompletedRow
	);

	var shiftsPaginator = createPaginator(
		document.getElementById('shifts-list'),
		document.getElementById('shifts-empty'),
		document.getElementById('shifts-page-indicator'),
		renderShiftRow
	);

	// ---- Topbjælke/offline-banner ------------------------------------------

	var sourceStatusDot = document.getElementById('source-status-dot');
	var sourceStatusText = document.getElementById('source-status-text');
	var lastUpdatedTime = document.getElementById('last-updated-time');
	var updatingDot = document.getElementById('updating-dot');
	var offlineBanner = document.getElementById('offline-banner');
	var cacheAgeEl = document.getElementById('cache-age');

	function updateMeta(json) {
		var online = json.sourceStatus === 'online' && !json.stale;
		sourceStatusDot.className = 'status-dot ' + (online ? 'status-dot-online' : 'status-dot-offline');
		sourceStatusText.textContent = online ? 'Online' : 'Offline';

		var generated = safeDate(json.generatedAt);
		lastUpdatedTime.textContent = generated ? formatClockSeconds(generated) : '–';
	}

	function updateOfflineBanner(json) {
		if (json.stale) {
			offlineBanner.hidden = false;
			cacheAgeEl.textContent = formatAge(json.cacheAgeSeconds);
		} else {
			offlineBanner.hidden = true;
		}
	}

	function setUpdating(isUpdating) {
		updatingDot.hidden = !isUpdating;
	}

	// ---- Data-polling med eksponentiel backoff ved fejl -----------------------

	var lastRenderedJson = { inProgress: null, completed: null, shifts: null };
	var fetchFailures = 0;
	var fetchTimer = null;

	function applyData(json) {
		updateMeta(json);
		updateOfflineBanner(json);

		var tasks = json.tasks || {};
		var inProgress = Array.isArray(tasks.inProgress) ? tasks.inProgress : [];
		var completed = Array.isArray(tasks.completed) ? tasks.completed : [];
		var shifts = Array.isArray(json.shifts) ? json.shifts : [];

		var ipKey = JSON.stringify(inProgress);
		if (ipKey !== lastRenderedJson.inProgress) {
			lastRenderedJson.inProgress = ipKey;
			inProgressPaginator.setItems(inProgress, PAGE_SIZE.inProgress);
		}

		var cpKey = JSON.stringify(completed);
		if (cpKey !== lastRenderedJson.completed) {
			lastRenderedJson.completed = cpKey;
			completedPaginator.setItems(completed, PAGE_SIZE.completed);
		}

		var shKey = JSON.stringify(shifts);
		if (shKey !== lastRenderedJson.shifts) {
			lastRenderedJson.shifts = shKey;
			shiftsPaginator.setItems(shifts, PAGE_SIZE.shifts);
		}
	}

	function scheduleFetch(delayMs) {
		if (fetchTimer) clearTimeout(fetchTimer);
		fetchTimer = setTimeout(fetchData, delayMs);
	}

	function fetchData() {
		setUpdating(true);

		var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
		var timeoutId = controller
			? setTimeout(function () {
					controller.abort();
				}, FETCH_TIMEOUT_MS)
			: null;

		fetch('/api/wallboard', {
			cache: 'no-store',
			signal: controller ? controller.signal : undefined,
		})
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				fetchFailures = 0;
				applyData(json);
				scheduleFetch(CONFIG.refreshSeconds * 1000);
			})
			.catch(function () {
				// Eksisterende data forbliver på skærmen uændret — kun retry-
				// kadencen ændres. Serverens EGEN stale/offline-status (næste
				// gang et kald lykkes) styrer offline-banneret, ikke denne fejl.
				fetchFailures += 1;
				var multiplier = Math.min(Math.pow(2, fetchFailures), MAX_BACKOFF_MULTIPLIER);
				scheduleFetch(CONFIG.refreshSeconds * 1000 * multiplier);
			})
			.finally(function () {
				if (timeoutId) clearTimeout(timeoutId);
				setUpdating(false);
			});
	}

	// ---- Ur ---------------------------------------------------------------

	var currentTimeEl = document.getElementById('current-time');
	var currentDateEl = document.getElementById('current-date');

	function tickClock() {
		var now = new Date();
		currentTimeEl.textContent = formatClock(now);
		currentDateEl.textContent = formatDate(now);
	}

	// ---- Init ---------------------------------------------------------------

	function init() {
		tickClock();
		setInterval(tickClock, 1000);

		var pageIntervalMs = (CONFIG.pageIntervalSeconds || 10) * 1000;
		inProgressPaginator.start(pageIntervalMs);
		completedPaginator.start(pageIntervalMs);
		shiftsPaginator.start(pageIntervalMs);

		fetchData();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
