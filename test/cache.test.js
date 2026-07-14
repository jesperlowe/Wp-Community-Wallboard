'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeCache, readCache } = require('../server/cache');

function tempCachePath() {
	return path.join(os.tmpdir(), `wallboard-cache-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'cache.json');
}

test('writeCache + readCache: rundtur bevarer payloadet', async () => {
	const cachePath = tempCachePath();
	const payload = { tasks: { inProgress: [{ id: 1 }], completed: [] }, shifts: [] };

	await writeCache(cachePath, payload);
	const result = await readCache(cachePath);

	assert.deepEqual(result.payload, payload);
	assert.ok(typeof result.fetchedAt === 'string');

	fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
});

test('writeCache: opretter den manglende mappe (fx /var/lib/wallboard) automatisk', async () => {
	const cachePath = tempCachePath();
	assert.equal(fs.existsSync(path.dirname(cachePath)), false);

	await writeCache(cachePath, { ok: true });
	assert.equal(fs.existsSync(cachePath), true);

	fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
});

test('writeCache: skriver atomisk (ingen efterladt .tmp-fil, og cache.json er altid komplet gyldig JSON)', async () => {
	const cachePath = tempCachePath();
	await writeCache(cachePath, { a: 1 });
	await writeCache(cachePath, { a: 2 });

	const dir = path.dirname(cachePath);
	const leftoverTmp = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
	assert.deepEqual(leftoverTmp, []);

	const raw = fs.readFileSync(cachePath, 'utf8');
	assert.doesNotThrow(() => JSON.parse(raw));

	fs.rmSync(dir, { recursive: true, force: true });
});

test('readCache: manglende fil giver null i stedet for at kaste', async () => {
	const result = await readCache(tempCachePath());
	assert.equal(result, null);
});

test('readCache: korrupt JSON giver null i stedet for at kaste', async () => {
	const cachePath = tempCachePath();
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	fs.writeFileSync(cachePath, '{ dette er ikke gyldig json', 'utf8');

	const result = await readCache(cachePath);
	assert.equal(result, null);

	fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
});

test('readCache: gyldig JSON uden et payload-felt behandles som ugyldig cache (null)', async () => {
	const cachePath = tempCachePath();
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	fs.writeFileSync(cachePath, JSON.stringify({ somethingElse: true }), 'utf8');

	const result = await readCache(cachePath);
	assert.equal(result, null);

	fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
});
