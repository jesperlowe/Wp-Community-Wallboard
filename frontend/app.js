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

	// Kort dato til inline-brug i kompakte kort (fx "19. juli") — for lang
	// til formatDate() (fuldt ugedagsnavn) og for råbende til formatShortDate()
	// (forkortet/versal, brugt i topbaren).
	function formatShiftCardDate(date) {
		var month = date.toLocaleDateString('da-DK', { month: 'long' });
		return date.getDate() + '. ' + month;
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
				var maxScroll = listEl.scrollHeight - viewHeight;
				// [2026-07-18] Sidste stop er klampet til maxScroll (se tick()),
				// ikke nødvendigvis et helt multiplum af viewHeight — et rent
				// scrollTop/viewHeight-regnestykke viste derfor stadig "1/2", selv
				// når rækken reelt stod nede ved bunden (fx 98px scrollTop i en
				// 314px rude: 98/314 runder ned til 0, ikke 1).
				var current;
				if (viewHeight <= 0) {
					current = 0;
				} else if (listEl.scrollTop >= maxScroll - 4) {
					current = pages - 1;
				} else {
					current = Math.round(listEl.scrollTop / viewHeight);
				}
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

			// [2026-07-18, bugfix] scrollTop + viewHeight kunne overskyde maxScroll
			// i ét hop, når indholdet kun er lidt højere end en skærmhøjde (fx
			// 98px overflow i en 314px rude) — så ramte "er vi ved bunden?"-tjekket
			// allerede på FØRSTE tick, og hoppede direkte til "spring til toppen"
			// (top: 0), som var et no-op, da den allerede stod på 0. Resultatet var
			// at panelet aldrig rørte sig ved delvis overflow (mindre end én ekstra
			// skærmhøjde) — kun ved SÅ meget indhold at et helt skærmhøjde-hop
			// naturligt landede før bunden. Klamper nu til maxScroll i stedet for
			// at hoppe forbi den, så den delvist skjulte rest rent faktisk vises,
			// før næste tick springer tilbage til toppen.
			var atBottom = listEl.scrollTop >= maxScroll - 4;
			var next = atBottom ? 0 : Math.min(listEl.scrollTop + viewHeight, maxScroll);
			listEl.scrollTo({ top: next, behavior: 'smooth' });

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

	// ---- Layout-skift (klassisk ↔ ops) --------------------------------------
	// [2026-07-19] To komplette layouts ligger side om side i DOM'en (se
	// index.html) — kun det aktive er synligt ([hidden] på det andet). Valget
	// gemmes i localStorage, så det samme kiosk-skærmbillede bliver ved med at
	// vise det layout personalet sidst valgte, også efter en genindlæsning.
	(function setupLayoutToggle() {
		var STORAGE_KEY = 'wallboardLayout';
		var layoutClassic = document.getElementById('layout-classic');
		var layoutOps = document.getElementById('layout-ops');
		var toggleButtons = document.querySelectorAll('[data-wpc-layout-toggle]');

		function readStoredLayout() {
			try {
				return window.localStorage.getItem(STORAGE_KEY) === 'ops' ? 'ops' : 'classic';
			} catch (e) {
				// Privat browsing/deaktiveret localStorage — falder blot tilbage
				// til klassisk hver gang, ingen anden konsekvens.
				return 'classic';
			}
		}

		function applyLayout(name) {
			var showOps = name === 'ops';
			layoutClassic.hidden = showOps;
			layoutOps.hidden = !showOps;
		}

		function setLayout(name) {
			applyLayout(name);
			try {
				window.localStorage.setItem(STORAGE_KEY, name);
			} catch (e) {
				// Se readStoredLayout() ovenfor — ingen konsekvens ud over at
				// valget ikke huskes til næste indlæsning.
			}
		}

		for (var i = 0; i < toggleButtons.length; i++) {
			toggleButtons[i].addEventListener('click', function () {
				setLayout(readStoredLayout() === 'ops' ? 'classic' : 'ops');
			});
		}

		applyLayout(readStoredLayout());
	})();

	// ---- Kiosk-exit-gestus (tredobbelt-tryk på logoet) -------------------
	// Ingen tastatur/mus på et kiosk-skærmbillede — tre tryk inden for ét
	// sekund er en gestus der aldrig sker ved uheld, men som personalet kan
	// huske. Selve afslutningen (Chromium lukkes, vender tilbage til en
	// terminal) sker i deployment/kiosk-autostart.sh, som poller
	// /api/kiosk/exit-status — denne handler sætter blot signalet.
	//
	// [2026-07-19] Bundet til BÅDE det klassiske layouts logo og ops-layoutets
	// logo-badge — gestussen skal virke uanset hvilket af de to layouts der
	// aktuelt er synligt, ikke kun det først byggede.
	function setupKioskExitGesture(triggerEl) {
		if (!triggerEl) return;

		var TAP_WINDOW_MS = 1000;
		var TAPS_REQUIRED = 3;
		var tapTimestamps = [];
		var requestInFlight = false;

		triggerEl.addEventListener('click', function () {
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
	}

	setupKioskExitGesture(topbarLogo);
	setupKioskExitGesture(document.getElementById('ops-topbar-logo-badge'));
	setupKioskExitGesture(document.getElementById('ops-topbar-logo'));

	// ---- Ops-layout: rendering ------------------------------------------------
	// [2026-07-19] Bevidst kun to renderede sektioner her: "Vagtdækning" og
	// "Opgavekø" — de eneste dele af ops-layoutet der har en reel, allerede
	// tilgængelig datakilde (WPC_Shifts/WPC_Tasks via /api/wallboard). Stat-
	// kortene, teamstatus, advarsler og dækningstendensen i index.html er
	// bevidst [hidden] og har INGEN tilsvarende renderfunktion her — de kræver
	// data (SLA/hændelser/individuel tilstedeværelse/historik) der ikke findes
	// endnu. Fjern [hidden] og tilføj en renderfunktion i samme stil, DEN dag
	// en rigtig datakilde findes — undgå at gætte tal i mellemtiden.

	var opsLivePill = document.getElementById('ops-live-pill');
	var opsDemoPill = document.getElementById('ops-demo-pill');
	var opsOfflineBanner = document.getElementById('ops-offline-banner');
	var opsFooterUpdated = document.getElementById('ops-footer-updated');

	function updateOpsMeta(json) {
		var online = json.sourceStatus === 'online' && !json.stale;
		opsLivePill.textContent = online ? 'LIVE' : 'OFFLINE';
		opsLivePill.classList.toggle('ops-pill--live', online);
		opsLivePill.classList.toggle('ops-pill--offline', !online);

		// [2026-07-19] Kun sat én gang (apiMode ændrer sig ikke i løbet af en
		// session) — en ærlig markør så mock-data fra lokal udvikling aldrig
		// kan forveksles med rigtig drift på en faktisk kiosk-skærm.
		if (CONFIG.apiMode === 'mock') {
			opsDemoPill.hidden = false;
		}

		if (json.stale) {
			opsOfflineBanner.hidden = false;
			opsOfflineBanner.textContent =
				json.cacheAgeSeconds === null || json.cacheAgeSeconds === undefined
					? 'Offline – ingen data modtaget fra WordPress endnu'
					: 'Offline – viser senest hentede data · ' + formatAge(json.cacheAgeSeconds);
		} else {
			opsOfflineBanner.hidden = true;
		}

		var generated = safeDate(json.generatedAt);
		opsFooterUpdated.textContent = 'Sidst opdateret ' + (generated ? formatClockSeconds(generated) : '–');
	}

	/** "Starter om X"/"Slutter om X" — samme relative sprog som resten af wallboardet (se formatAge()). */
	function opsCoverageCountdown(startIso, endIso) {
		var now = Date.now();
		var startMs = startIso ? Date.parse(startIso) : NaN;
		var endMs = endIso ? Date.parse(endIso) : NaN;
		if (!isNaN(startMs) && startMs > now) {
			return 'Starter om ' + formatAge((startMs - now) / 1000);
		}
		if (!isNaN(endMs) && endMs > now) {
			return 'Slutter om ' + formatAge((endMs - now) / 1000);
		}
		return '';
	}

	function renderOpsCoverageCard(shift) {
		var card = el('div', 'ops-coverage-card');

		var top = el('div', 'ops-coverage-card__top');
		var left = el('div');
		left.appendChild(el('div', 'ops-coverage-card__title', shift.title || 'Vagt'));

		var start = safeDate(shift.startTime);
		var end = safeDate(shift.endTime);
		// [2026-07-19] Datoen var tidligere udeladt — kun klokkeslæt (fx
		// "19.55–22.55"), hvilket var tvetydigt for en vagt der ikke er i dag
		// (fx i morgen). formatShiftCardDate() bruger startTime, som allerede
		// har den korrekte dato indlejret (se mapShift() i wordpress-adapter.js).
		var timeText = start && end
			? formatShiftCardDate(start) + ' · ' + formatClock(start) + '–' + formatClock(end)
			: '–';
		left.appendChild(el('div', 'ops-coverage-card__time', timeText));

		// [2026-07-19] Kun til stede når SHOW_SHIFT_NAMES=true (samme
		// privatlivs-toggle som det klassiske layouts row-participants, se
		// renderShiftRow() og mapShift()) — udelades ellers helt.
		if (Array.isArray(shift.participantNames) && shift.participantNames.length > 0) {
			left.appendChild(el('div', 'ops-coverage-card__participants', shift.participantNames.join(', ')));
		}

		top.appendChild(left);

		var userCount = typeof shift.userCount === 'number' ? shift.userCount : 0;
		var hasMax = typeof shift.maxUsers === 'number' && shift.maxUsers > 0;
		var ratio = hasMax ? userCount / shift.maxUsers : (userCount > 0 ? 1 : 0);

		var labelClass = 'ops-coverage-card__label--empty';
		var labelText = 'INGEN TILMELDT';
		var fillModifier = 'ops-progress-fill--empty';
		if (hasMax && userCount >= shift.maxUsers && userCount > 0) {
			labelClass = 'ops-coverage-card__label--full';
			labelText = 'FULDT DÆKKET';
			fillModifier = '';
		} else if (hasMax && userCount > 0) {
			labelClass = 'ops-coverage-card__label--partial';
			labelText = (shift.maxUsers - userCount) + ' PLADSER ÅBNE';
			fillModifier = 'ops-progress-fill--partial';
		} else if (!hasMax && userCount > 0) {
			labelClass = 'ops-coverage-card__label--full';
			labelText = 'ÅBEN, UBEGRÆNSET';
			fillModifier = '';
		}

		var right = el('div');
		right.appendChild(el('div', 'ops-coverage-card__count', hasMax ? userCount + ' / ' + shift.maxUsers : userCount + ' tilmeldt'));
		right.appendChild(el('div', 'ops-coverage-card__label ' + labelClass, labelText));
		top.appendChild(right);
		card.appendChild(top);

		var track = el('div', 'ops-progress-track');
		var fill = el('div', 'ops-progress-fill' + (fillModifier ? ' ' + fillModifier : ''));
		fill.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
		track.appendChild(fill);
		card.appendChild(track);

		var countdown = opsCoverageCountdown(shift.startTime, shift.endTime);
		if (countdown) {
			card.appendChild(el('div', 'ops-coverage-card__countdown', countdown));
		}

		return card;
	}

	function renderOpsCoverage(shifts) {
		var list = document.getElementById('ops-coverage-list');
		var empty = document.getElementById('ops-coverage-empty');
		list.innerHTML = '';

		if (!shifts.length) {
			list.hidden = true;
			empty.hidden = false;
			return;
		}

		list.hidden = false;
		empty.hidden = true;
		shifts.forEach(function (shift) {
			list.appendChild(renderOpsCoverageCard(shift));
		});
	}

	function renderOpsQueueRow(task, timeIso) {
		var statusKey = task.status || 'default';
		var row = el('div', 'ops-queue-row ops-queue-row--' + statusKey);

		var titleCol = el('div');
		titleCol.appendChild(el('div', 'ops-queue-row__title', task.title || 'Uden titel'));
		titleCol.appendChild(el('div', 'ops-queue-row__meta', task.taskNumber || ''));
		row.appendChild(titleCol);

		var ownerText = Array.isArray(task.assignedNames) && task.assignedNames.length > 0
			? task.assignedNames.join(', ')
			: '–';
		row.appendChild(el('span', 'ops-queue-row__owner', ownerText));

		var timeDate = timeIso ? new Date(timeIso) : null;
		row.appendChild(el('span', 'ops-queue-row__time', timeDate ? formatClock(timeDate) : '–'));

		row.appendChild(el('span', 'ops-status-pill ops-status-pill--' + statusKey, statusMap.translateStatus(task.status)));

		return row;
	}

	/**
	 * Slår igangværende og kommende opgaver sammen til én prioriteret kø
	 * (igangværende først — allerede sorteret ældst-startet-først af serveren,
	 * se sortInProgress() i wordpress-adapter.js — derefter kommende, allerede
	 * sorteret snarest-først af filterAndSortUpcoming()). Ingen selvstændig
	 * gensortering nødvendig her.
	 */
	function renderOpsQueue(inProgress, upcoming) {
		var list = document.getElementById('ops-queue-list');
		var empty = document.getElementById('ops-queue-empty');
		list.innerHTML = '';

		if (inProgress.length === 0 && upcoming.length === 0) {
			list.hidden = true;
			empty.hidden = false;
			return;
		}

		list.hidden = false;
		empty.hidden = true;
		inProgress.forEach(function (task) {
			list.appendChild(renderOpsQueueRow(task, task.startedAt));
		});
		upcoming.forEach(function (task) {
			list.appendChild(renderOpsQueueRow(task, task.scheduledAt));
		});
	}

	/** Andelen af de opgaver wallboardet kender til i dag, der er afsluttet — samme tal som ville fodre en fremtidig "TASKS DONE"-stat. */
	function updateOpsCompletion(inProgress, completed, upcoming) {
		var fill = document.getElementById('ops-completion-fill');
		var value = document.getElementById('ops-completion-value');
		var total = inProgress.length + completed.length + upcoming.length;
		var pct = total > 0 ? Math.round((completed.length / total) * 100) : 0;

		fill.style.width = pct + '%';
		value.textContent = total > 0 ? pct + '% · ' + completed.length + ' af ' + total : '–';
	}

	// ---- Data-polling med eksponentiel backoff ved fejl -----------------------

	var lastRenderedJson = { inProgress: null, completed: null, upcoming: null, shifts: null };
	var fetchFailures = 0;
	var fetchTimer = null;

	function applyData(json) {
		updateMeta(json);
		updateOfflineBanner(json);
		updateBranding(json);
		updateOpsMeta(json);

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

		// [2026-07-19] Ops-layoutet opdateres hver gang, uanset om det aktuelt
		// er synligt — ikke bag samme JSON-diff-værn som ovenfor (de billige
		// render-funktioner har intet scroll-/animationstilstand at bevare,
		// modsat autoscroller-panelerne), så et layoutskift altid viser frisk
		// data med det samme i stedet for at vente på næste hentning.
		renderOpsCoverage(shifts);
		renderOpsQueue(inProgress, upcoming);
		updateOpsCompletion(inProgress, completed, upcoming);
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
	var opsCurrentTimeEl = document.getElementById('ops-current-time');
	var opsCurrentDateEl = document.getElementById('ops-current-date');

	/** Kort format til ops-topbjælken (fx "LØR. 18. JUL.") — modsat den lange, fulde dato i det klassiske layout. */
	function formatShortDate(date) {
		return date.toLocaleDateString('da-DK', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
	}

	function tickClock() {
		var now = new Date();
		currentTimeEl.textContent = formatClock(now);
		currentDateEl.textContent = formatDate(now);
		opsCurrentTimeEl.textContent = formatClock(now);
		opsCurrentDateEl.textContent = formatShortDate(now);
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
