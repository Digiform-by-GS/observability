import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeams, isKnownTeam } from './teams.js';

const REAL = JSON.stringify({
  _generated_by: 'scripts/gen-tenants.py',
  catchAll: 'unattributed',
  teams: [{ name: 'gudangsolusi', description: 'Costwise backend, frontend and workers.' }],
});

test('parses the generated file', () => {
  const l = parseTeams(REAL);
  assert.equal(l.available, true);
  assert.deepEqual(l.teams.map((t) => t.name), ['gudangsolusi']);
  assert.equal(l.catchAll, 'unattributed');
});

// The generator already excludes platform/unattributed, but assert the contract
// here too: offering the catch-all as a pickable team would defeat the alarm
// that a rising catch-all is supposed to raise.
test('the catch-all is named but never a selectable team', () => {
  const l = parseTeams(REAL);
  assert.equal(isKnownTeam(l, l.catchAll), false);
});

test('an unknown team is not accepted', () => {
  const l = parseTeams(REAL);
  assert.equal(isKnownTeam(l, 'gudangsolusi'), true);
  // one character wrong - the exact failure that used to be invisible
  assert.equal(isKnownTeam(l, 'gudangsolusii'), false);
  assert.equal(isKnownTeam(l, ''), false);
});

// Malformed input must degrade, never throw: the API failing to start is worse
// than a form that offers no teams, which is merely the catch-all.
test('malformed input degrades instead of throwing', () => {
  for (const bad of ['', 'not json', '[]', '{"teams":"nope"}', 'null']) {
    const l = parseTeams(bad);
    assert.deepEqual(l.teams, [], `for input ${JSON.stringify(bad)}`);
  }
  assert.equal(parseTeams('not json').available, false);
  // valid JSON with no teams key is readable, just empty
  assert.equal(parseTeams('{}').available, true);
});

test('entries without a usable name are dropped', () => {
  const l = parseTeams(JSON.stringify({ teams: [{ name: '' }, { nope: 1 }, { name: 'ok' }] }));
  assert.deepEqual(l.teams.map((t) => t.name), ['ok']);
});
