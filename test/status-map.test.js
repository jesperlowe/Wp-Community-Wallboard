'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const statusMap = require('../frontend/status-map.js');

test('translateStatus: oversætter alle kendte statusser til dansk', () => {
	assert.equal(statusMap.translateStatus('planned'), 'Planlagt');
	assert.equal(statusMap.translateStatus('assigned'), 'Tildelt');
	assert.equal(statusMap.translateStatus('in_progress'), 'I gang');
	assert.equal(statusMap.translateStatus('completed'), 'Afsluttet');
	assert.equal(statusMap.translateStatus('cancelled'), 'Aflyst');
	assert.equal(statusMap.translateStatus('open'), 'Åben');
	assert.equal(statusMap.translateStatus('full'), 'Fyldt');
});

test('translateStatus: ukendt status giver en læsbar version af værdien, ikke en fejl', () => {
	assert.equal(statusMap.translateStatus('waiting_for_parts'), 'Waiting for parts');
	assert.equal(statusMap.translateStatus('some-legacy-status'), 'Some legacy status');
});

test('translateStatus: tom/manglende status giver "Ukendt" i stedet for at fejle', () => {
	assert.equal(statusMap.translateStatus(''), 'Ukendt');
	assert.equal(statusMap.translateStatus(null), 'Ukendt');
	assert.equal(statusMap.translateStatus(undefined), 'Ukendt');
});

test('humanize: håndterer tal og andre ikke-streng-typer uden at kaste', () => {
	assert.doesNotThrow(() => statusMap.humanize(42));
	assert.doesNotThrow(() => statusMap.humanize({}));
});
