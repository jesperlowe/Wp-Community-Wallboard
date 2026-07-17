(function () {
	'use strict';

	var CONFIG = window.WALLBOARD_CONFIG || {
		refreshSeconds: 30,
		completedTaskLimit: 10,
		completedLookbackHours: 24,
		upcomingTaskLimit: 10,
		upcomingLookaheadHours: 24,
		pageIntervalSeconds: 10,
	};

	var FETCH_TIMEOUT_MS = 8000;
	var MAX_BACKOFF_MULTIPLIER = 10;

	// [2026-07-16] Reduceret i takt med at layoutet gik fra "ét fuldt panel +
	// to halve" til fire lige store paneler i et 2×2-gitter — hvert panel har
	// nu ca. et kvart skærmbillede i stedet for op til et halvt.
	// [2026-07-17] Kun completed/shifts bruger stadig et fast antal pr. side
	// (createPaginator) — inProgress/upcoming autoscroller i stedet
	// (createAutoScroller) og har derfor ikke brug for en sidestørrelse.
	var PAGE_SIZE = {
		completed: 4,
		shifts: 3,
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

	function dayKey(date) {
		return date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
	}

	function addDays(date, days) {
		var copy = new Date(date);
		copy.setDate(copy.getDate() + days);
		return copy;
	}

	// [2026-07-16] "Afsluttet"/"Kommende"-panelerne dækker et rullende
	// 24-timers-vindue (ikke strengt kalenderdag), og "Igangværende" har
	// ingen øvre grænse for hvor længe siden en opgave startede — et bart
	// klokkeslæt kan derfor være reelt tvetydigt (i går kl. 23.30 vs. i dag
	// kl. 23.30). Viser kun en dags-markør når det faktisk er nødvendigt (ikke
	// i dag), for ikke at fylde hver eneste række med en dato i det langt
	// hyppigste tilfælde.
	function relativeDayPrefix(date) {
		var now = new Date();
		var key = dayKey(date);
		if (key === dayKey(now)) return '';
		if (key === dayKey(addDays(now, -1))) return 'i går ';
		if (key === dayKey(addDays(now, 1))) return 'i morgen ';
		return date.getDate() + '/' + (date.getMonth() + 1) + ' ';
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

	/**
	 * [2026-07-17] Alternativ til createPaginator() til paneler hvor et hårdt
	 * side-skift (fade til en helt ny, fast-talt rækkeblok) føles for
	 * hakkende — her glider listen i stedet roligt én skærmhøjde ned ad
	 * gangen (native scrollTo med behavior:'smooth'), og springer blødt
	 * tilbage til toppen når bunden er nået. Alle rækker renderes samlet
	 * (ingen fast antal-pr-side-antagelse), hvilket også er mere robust nu
	 * hvor rækkehøjden varierer med antal tildelte navne (se buildTaskRow).
	 */
	function createAutoScroller(listEl, emptyEl, indicatorEl, renderRow) {
		var items = [];
		var timer = null;

		function totalPages() {
			var viewHeight = listEl.clientHeight;
			if (viewHeight <= 0) return 1;
			// Samme 4px-tolerance som tick()'s maxScroll-tjek, ellers kan en
			// scrollHeight der ligger få pixels over et helt antal skærmhøjder
			// (afrunding/kantlinjer) give en ekstra, reelt ikke-eksisterende side.
			return Math.max(1, Math.ceil((listEl.scrollHeight - 4) / viewHeight));
		}

		function updateIndicator() {
			var pages = totalPages();
			if (pages > 1) {
				var viewHeight = listEl.clientHeight;
				var current = viewHeight > 0 ? Math.round(listEl.scrollTop / viewHeight) : 0;
				indicatorEl.hidden = false;
				indicatorEl.textContent = current + 1 + ' / ' + pages;
			} else {
				indicatorEl.hidden = true;
			}
		}

		function renderAll() {
			listEl.innerHTML = '';
			listEl.scrollTop = 0;

			if (items.length === 0) {
				listEl.hidden = true;
				emptyEl.hidden = false;
				indicatorEl.hidden = true;
				return;
			}

			listEl.hidden = false;
			emptyEl.hidden = true;

			items.forEach(function (item) {
				listEl.appendChild(renderRow(item));
			});

			updateIndicator();
		}

		function setItems(newItems) {
			items = newItems || [];
			fadeSwap(listEl, renderAll);
		}

		function tick() {
			if (items.length === 0) return;

			var viewHeight = listEl.clientHeight;
			var maxScroll = listEl.scrollHeight - viewHeight;
			if (maxScroll <= 4) return; // alt indhold er allerede synligt — intet at scrolle til

			var next = listEl.scrollTop + viewHeight;
			listEl.scrollTo({ top: next >= maxScroll - 4 ? 0 : next, behavior: 'smooth' });

			// Indikatoren opdateres lidt forsinket, så den matcher den nye
			// scroll-position (scrollTo animerer asynkront).
			setTimeout(updateIndicator, 400);
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
		// [2026-07-17, bugfix] Navne bor i row-main (ikke row-meta) og ombrydes,
		// så mange tildelte personer ikke presser opgavetitlen sammen — row-meta
		// har flex-shrink:0 og ville ellers tvinge titlen til at forsvinde bag
		// ellipsis ved 3+ navne.
		if (Array.isArray(task.assignedNames) && task.assignedNames.length > 0) {
			main.appendChild(el('span', 'row-assignee', task.assignedNames.join(', ')));
		}
		row.appendChild(main);

		var meta = el('div', 'row-meta');
		var timeDate = timeValueIso ? new Date(timeValueIso) : null;
		var timeText = timeDate
			? timeLabel + ' ' + relativeDayPrefix(timeDate) + formatClock(timeDate)
			: timeLabel + ' –';
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

	function renderUpcomingRow(task) {
		return buildTaskRow(task, 'Planlagt', task.scheduledAt);
	}

	function renderShiftRow(shift) {
		var row = el('div', 'row');

		var main = el('div', 'row-main');
		main.appendChild(el('span', 'row-title', shift.title || 'Vagt'));
		// [2026-07-16] Kun til stede når SHOW_SHIFT_NAMES=true (se
		// server/wordpress-adapter.js' mapShift()) — udelades ellers helt,
		// matcher den oprindelige "ingen deltagere vises"-standard.
		if (Array.isArray(shift.participantNames) && shift.participantNames.length > 0) {
			main.appendChild(el('span', 'row-participants', shift.participantNames.join(', ')));
		}
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

	// ---- Opsætning af de fire paneler ---------------------------------------

	var inProgressPaginator = createAutoScroller(
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

	var upcomingPaginator = createAutoScroller(
		document.getElementById('upcoming-list'),
		document.getElementById('upcoming-empty'),
		document.getElementById('upcoming-page-indicator'),
		renderUpcomingRow
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

	function updateMeta(json) {
		var online = json.sourceStatus === 'online' && !json.stale;
		sourceStatusDot.className = 'status-dot ' + (online ? 'status-dot-online' : 'status-dot-offline');
		sourceStatusText.textContent = online ? 'Online' : 'Offline';

		var generated = safeDate(json.generatedAt);
		lastUpdatedTime.textContent = generated ? formatClockSeconds(generated) : '–';
	}

	// [2026-07-16] cacheAgeSeconds er null (ikke 0) når der slet ingen data
	// er hentet endnu (frisk installation, ingen disk-cache, endnu intet
	// vellykket kald til WordPress) — se server.js' buildWallboardResponse().
	// Skal vises tydeligt forskelligt fra "0 sekunder siden", ellers ser det
	// modstridende ud ("Offline" + "lige hentet").
	function updateOfflineBanner(json) {
		if (!json.stale) {
			offlineBanner.hidden = true;
			return;
		}

		offlineBanner.hidden = false;
		offlineBanner.textContent =
			json.cacheAgeSeconds === null || json.cacheAgeSeconds === undefined
				? 'Offline – ingen data modtaget fra WordPress endnu'
				: 'Offline – viser senest hentede data · ' + formatAge(json.cacheAgeSeconds);
	}

	function setUpdating(isUpdating) {
		updatingDot.hidden = !isUpdating;
	}

	// ---- Logo (fra WordPress' offentlige /app-config, se README) --------------

	var topbarLogo = document.getElementById('topbar-logo');
	var currentLogoUrl = null;

	topbarLogo.addEventListener('error', function () {
		// Fx et midlertidigt utilgængeligt WP-site — skjul i stedet for et
		// ødelagt billede-ikon; næste vellykkede hentning prøver igen.
		topbarLogo.hidden = true;
	});

	function updateBranding(json) {
		var logoUrl = (json.branding && json.branding.logoUrl) || null;
		if (logoUrl === currentLogoUrl) return;
		currentLogoUrl = logoUrl;

		if (logoUrl) {
			topbarLogo.src = logoUrl;
			topbarLogo.hidden = false;
		} else {
			topbarLogo.hidden = true;
			topbarLogo.removeAttribute('src');
		}
	}

	// ---- Kiosk-exit-gestus (tredobbelt-tryk på logoet) -------------------
	// Ingen tastatur/mus på et kiosk-skærmbillede — tre tryk inden for ét
	// sekund er en gestus der aldrig sker ved uheld, men som personalet kan
	// huske. Selve afslutningen (Chromium lukkes, vender tilbage til en
	// terminal) sker i deployment/kiosk-autostart.sh, som poller
	// /api/kiosk/exit-status — denne handler sætter blot signalet.
	(function setupKioskExitGesture() {
		var TAP_WINDOW_MS = 1000;
		var TAPS_REQUIRED = 3;
		var tapTimestamps = [];
		var requestInFlight = false;

		topbarLogo.addEventListener('click', function () {
			var now = Date.now();
			tapTimestamps = tapTimestamps.filter(function (t) {
				return now - t < TAP_WINDOW_MS;
			});
			tapTimestamps.push(now);
			if (tapTimestamps.length < TAPS_REQUIRED) return;

			tapTimestamps = [];
			if (requestInFlight) return;
			requestInFlight = true;

			fetch('/api/kiosk/exit-request', { method: 'POST' })
				.catch(function () {
					// Ingen retry — personalet kan blot trykke tre gange igen.
				})
				.finally(function () {
					requestInFlight = false;
				});
		});
	})();

	// ---- Data-polling med eksponentiel backoff ved fejl -----------------------

	var lastRenderedJson = { inProgress: null, completed: null, upcoming: null, shifts: null };
	var fetchFailures = 0;
	var fetchTimer = null;

	function applyData(json) {
		updateMeta(json);
		updateOfflineBanner(json);
		updateBranding(json);

		var tasks = json.tasks || {};
		var inProgress = Array.isArray(tasks.inProgress) ? tasks.inProgress : [];
		var completed = Array.isArray(tasks.completed) ? tasks.completed : [];
		var upcoming = Array.isArray(tasks.upcoming) ? tasks.upcoming : [];
		var shifts = Array.isArray(json.shifts) ? json.shifts : [];

		var ipKey = JSON.stringify(inProgress);
		if (ipKey !== lastRenderedJson.inProgress) {
			lastRenderedJson.inProgress = ipKey;
			inProgressPaginator.setItems(inProgress);
		}

		var cpKey = JSON.stringify(completed);
		if (cpKey !== lastRenderedJson.completed) {
			lastRenderedJson.completed = cpKey;
			completedPaginator.setItems(completed, PAGE_SIZE.completed);
		}

		var upKey = JSON.stringify(upcoming);
		if (upKey !== lastRenderedJson.upcoming) {
			lastRenderedJson.upcoming = upKey;
			upcomingPaginator.setItems(upcoming);
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

	// [2026-07-16] Panelet viser "i dag ELLER inden for COMPLETED_LOOKBACK_HOURS"
	// (se server/wordpress-adapter.js' filterAndSortCompleted) — en statisk
	// "Afsluttet i dag"-overskrift er derfor misvisende når vinduet reelt er
	// bredere (fx en opgave afsluttet sent aftenen før). Overskriften afspejler
	// nu det faktisk konfigurerede vindue, så den aldrig lover mere end den holder.
	function setCompletedHeading() {
		var heading = document.getElementById('completed-heading');
		var hours = CONFIG.completedLookbackHours || 24;
		heading.textContent = 'Afsluttet seneste ' + hours + ' timer';
	}

	/** Samme begrundelse som setCompletedHeading() — se dens kommentar. */
	function setUpcomingHeading() {
		var heading = document.getElementById('upcoming-heading');
		var hours = CONFIG.upcomingLookaheadHours || 24;
		heading.textContent = 'Kommende opgaver næste ' + hours + ' timer';
	}

	function init() {
		tickClock();
		setInterval(tickClock, 1000);
		setCompletedHeading();
		setUpcomingHeading();

		var pageIntervalMs = (CONFIG.pageIntervalSeconds || 10) * 1000;
		inProgressPaginator.start(pageIntervalMs);
		completedPaginator.start(pageIntervalMs);
		upcomingPaginator.start(pageIntervalMs);
		shiftsPaginator.start(pageIntervalMs);

		fetchData();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
