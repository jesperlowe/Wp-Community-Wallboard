'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createServer } = require('../server/server');
const { writeCache } = require('../server/cache');
const { validateWpBaseUrl, isLocalHost } = require('../server/config');

function tempCachePath() {
	return path.join(os.tmpdir(), `wallboard-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'cache.json');
}

function baseTestConfig(overrides) {
	return Object.assign(
		{
			port: 0, // OS vælger en ledig port
			apiMode: 'mock',
			wpBaseUrl: '',
			wpApiNamespace: '/wp-json/wp-community/v1',
			wpUsername: '',
			wpApplicationPassword: '',
			timezone: 'Europe/Copenhagen',
			refreshSeconds: 3600, // ingen automatisk refresh under testen — vi styrer selv med refreshOnce()
			completedTaskLimit: 10,
			completedLookbackHours: 24,
			shiftLookaheadHours: 24,
			showAssignees: true,
			arrangementId: null,
			cachePath: tempCachePath(),
			fetchTimeoutMs: 2000,
		},
		overrides
	);
}

async function getJson(url) {
	const res = await fetch(url);
	return { status: res.status, body: await res.json() };
}

test('GET /api/wallboard (mock-mode): svarer med det rensede wallboard-format, intet følsomt indhold', async () => {
	const config = baseTestConfig();
	const instance = createServer(config);

	try {
		await instance.start();
		await instance.refreshOnce();

		const port = instance.httpServer.address().port;
		const { status, body } = await getJson(`http://127.0.0.1:${port}/api/wallboard`);

		assert.equal(status, 200);
		assert.equal(body.stale, false);
		assert.equal(body.sourceStatus, 'online');
		assert.ok(Array.isArray(body.tasks.inProgress));
		assert.ok(Array.isArray(body.tasks.completed));
		assert.ok(Array.isArray(body.shifts));
		assert.ok(body.tasks.inProgress.length > 0, 'mock-data bør give mindst én igangværende opgave');

		const raw = JSON.stringify(body);
		for (const forbidden of ['contact_phone', 'pickup_address', 'delivery_address', 'application_password', 'WP_APPLICATION_PASSWORD', 'description', 'assigned_vehicle']) {
			assert.equal(raw.includes(forbidden), false, `"${forbidden}" må ikke optræde i /api/wallboard-svaret`);
		}
	} finally {
		await instance.stop();
		fs.rmSync(path.dirname(config.cachePath), { recursive: true, force: true });
	}
});

test('GET /health: svarer 200 uden secrets eller stack traces', async () => {
	const config = baseTestConfig();
	const instance = createServer(config);

	try {
		await instance.start();
		const port = instance.httpServer.address().port;
		const { status, body } = await getJson(`http://127.0.0.1:${port}/health`);

		assert.equal(status, 200);
		assert.equal(body.status, 'ok');
		assert.equal(body.mode, 'mock');
		assert.equal(Object.prototype.hasOwnProperty.call(body, 'stack'), false);
	} finally {
		await instance.stop();
		fs.rmSync(path.dirname(config.cachePath), { recursive: true, force: true });
	}
});

test('Ukendt sti giver 404, ikke en serverfejl', async () => {
	const config = baseTestConfig();
	const instance = createServer(config);

	try {
		await instance.start();
		const port = instance.httpServer.address().port;
		const res = await fetch(`http://127.0.0.1:${port}/does-not-exist`);
		assert.equal(res.status, 404);
	} finally {
		await instance.stop();
		fs.rmSync(path.dirname(config.cachePath), { recursive: true, force: true });
	}
});

test('Ved netværksfejl mod WordPress falder serveren tilbage til disk-cachen og markerer svaret som stale', async () => {
	const cachePath = tempCachePath();
	const cachedPayload = {
		tasks: {
			inProgress: [{ id: 1, taskNumber: 'WPC-0001', title: 'Fra cache', status: 'in_progress', startedAt: '2026-07-14T08:00:00+02:00', assignedNames: [] }],
			completed: [],
		},
		shifts: [],
	};
	await writeCache(cachePath, cachedPayload);

	// Port 1 på localhost har (i praksis altid) ingen lytter — forbindelsen
	// afvises med det samme, uden afhængighed af DNS eller ægte netværk.
	const config = baseTestConfig({
		apiMode: 'live',
		wpBaseUrl: 'http://127.0.0.1:1',
		wpUsername: 'wallboard',
		wpApplicationPassword: 'x',
		cachePath,
		fetchTimeoutMs: 1500,
	});
	const instance = createServer(config);

	try {
		await instance.start();
		await instance.refreshOnce();

		const port = instance.httpServer.address().port;
		const { body } = await getJson(`http://127.0.0.1:${port}/api/wallboard`);

		assert.equal(body.stale, true);
		assert.equal(body.sourceStatus, 'offline');
		assert.deepEqual(body.tasks.inProgress, cachedPayload.tasks.inProgress);
	} finally {
		await instance.stop();
		fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
	}
});

test('Ved fejl på allerførste hentning (ingen disk-cache endnu) er generatedAt/cacheAgeSeconds null, ikke en vildledende "0 sekunder"', async () => {
	// Regressionstest for en bug hvor cacheAgeSeconds faldt tilbage til 0
	// (i stedet for null) når der slet ingen data var hentet endnu — det
	// fik frontenden til modstridende at vise "Offline" sammen med "0
	// sekunder siden", som om data lige var hentet friskt.
	const config = baseTestConfig({
		apiMode: 'live',
		wpBaseUrl: 'http://127.0.0.1:1',
		wpUsername: 'wallboard',
		wpApplicationPassword: 'x',
		fetchTimeoutMs: 1500,
		// cachePath peger på en mappe der aldrig er skrevet til — ingen fil at falde tilbage på.
	});
	const instance = createServer(config);

	try {
		await instance.start();
		await instance.refreshOnce();

		const port = instance.httpServer.address().port;
		const { body } = await getJson(`http://127.0.0.1:${port}/api/wallboard`);

		assert.equal(body.stale, true);
		assert.equal(body.sourceStatus, 'offline');
		assert.equal(body.generatedAt, null);
		assert.equal(body.cacheAgeSeconds, null);
		assert.deepEqual(body.tasks.inProgress, []);
		assert.deepEqual(body.tasks.completed, []);
		assert.deepEqual(body.shifts, []);
	} finally {
		await instance.stop();
		fs.rmSync(path.dirname(config.cachePath), { recursive: true, force: true });
	}
});

// ---- config.js: HTTPS-håndhævelse (rent funktionstjek, ingen server nødvendig) ----

test('validateWpBaseUrl: afviser usikret ekstern URL, accepterer HTTPS og lokale hosts', () => {
	assert.throws(() => validateWpBaseUrl('http://eksempel.dk'));
	assert.doesNotThrow(() => validateWpBaseUrl('https://eksempel.dk'));
	assert.doesNotThrow(() => validateWpBaseUrl('http://localhost:8080'));
	assert.doesNotThrow(() => validateWpBaseUrl('http://127.0.0.1:8080'));
	assert.throws(() => validateWpBaseUrl('ikke-en-url'));
});

test('isLocalHost: genkender lokale hosts korrekt', () => {
	assert.equal(isLocalHost('localhost'), true);
	assert.equal(isLocalHost('127.0.0.1'), true);
	assert.equal(isLocalHost('pi.local'), true);
	assert.equal(isLocalHost('eksempel.dk'), false);
});
