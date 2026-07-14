'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Atomisk cache af senest gyldige wallboard-payload. "Skriv til .tmp, ren
 * fs.rename() til det endelige navn" garanterer at cache.json enten
 * indeholder det GAMLE eller det NYE indhold — aldrig en halvskrevet fil,
 * heller ikke ved strømsvigt midt i en skrivning (rename er atomisk på
 * samme filsystem, se POSIX rename(2)).
 */

async function writeCache(cachePath, payload) {
	const dir = path.dirname(cachePath);
	await fsp.mkdir(dir, { recursive: true });

	const tmpPath = path.join(dir, `.cache-${process.pid}.tmp`);
	const body = JSON.stringify({ fetchedAt: new Date().toISOString(), payload }, null, 2);

	await fsp.writeFile(tmpPath, body, 'utf8');
	await fsp.rename(tmpPath, cachePath);
}

/** Returnerer {fetchedAt, payload} eller null hvis filen mangler/er korrupt. Kaster aldrig. */
async function readCache(cachePath) {
	try {
		const raw = await fsp.readFile(cachePath, 'utf8');
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || !parsed.payload) return null;
		return parsed;
	} catch {
		return null;
	}
}

module.exports = { writeCache, readCache };
