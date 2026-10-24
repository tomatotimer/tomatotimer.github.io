const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate, pickMinutes, formatTime, createState, remainingTime, transition, restoreState } = require('../app.js');
const fields = (overrides = {}) => ({ ...createState().fields, ...overrides });

test('manual boundaries and invalid input', () => {
  for (const [minutes, seconds] of [['0', '1'], ['', '1'], ['  ', '30'], ['59', '59']]) assert.equal(validate('manual', fields({ minutes, seconds })).valid, true);
  for (const [minutes, seconds] of [['0', '0'], ['60', '0'], ['', '0'], ['0', ''], ['-1', '0'], ['1.5', '0'], ['abc', '0'], ['0', '60'], ['1e1', '0']]) assert.equal(validate('manual', fields({ minutes, seconds })).valid, false);
});
test('random validates inclusive bounds and equal endpoints', () => {
  for (const [minimum, maximum] of [['1', '59'], ['17', '25'], ['25', '25']]) assert.equal(validate('random', fields({ minimum, maximum })).valid, true);
  for (const [minimum, maximum] of [['25', '17'], ['0', '25'], ['1', '60'], ['', '25'], ['1.5', '25']]) assert.equal(validate('random', fields({ minimum, maximum })).valid, false);
  assert.equal(pickMinutes(17, 25, () => 0), 17);
  assert.equal(pickMinutes(17, 25, () => 0.999999), 25);
  assert.equal(pickMinutes(25, 25), 25);
});
test('format rounds up and clamps zero', () => {
  for (const [input, expected] of [[3599000, '59:59'], [60000, '01:00'], [59999, '01:00'], [1, '00:01'], [0, '00:00'], [-1, '00:00']]) assert.equal(formatTime(input), expected);
});
test('deadline survives delayed ticks; completion only transitions once', () => {
  let s = transition(createState(), 'start', 1000, 60000, null);
  assert.equal(remainingTime(s, 31000), 30000);
  assert.equal(remainingTime(s, 100000), 0);
  s = transition(s, 'tick', 100000);
  assert.equal(s.status, 'complete');
  assert.strictEqual(transition(s, 'tick', 200000), s);
  assert.equal(transition(s, 'start', 200000).deadline, 260000);
});
test('pause freezes time, resume sets deadline, duplicate actions are idempotent', () => {
  let s = transition(createState(), 'start', 1000, 60000, null);
  assert.strictEqual(transition(s, 'start', 2000, 120000, null), s);
  s = transition(s, 'pause', 11000);
  assert.equal(remainingTime(s, 999999), 50000);
  assert.strictEqual(transition(s, 'pause', 12000), s);
  s = transition(s, 'resume', 100000);
  assert.equal(s.deadline, 150000);
  assert.strictEqual(transition(s, 'resume', 110000), s);
  s = transition(s, 'reset', 120000);
  assert.equal(s.status, 'idle');
  assert.equal(s.deadline, null);
});
test('pause at deadline completes; invalid start cannot run', () => {
  assert.equal(transition(transition(createState(), 'start', 0, 1000, null), 'pause', 1000).status, 'complete');
  for (const duration of [0, -1, 3600000, NaN, 1.5]) assert.equal(transition(createState(), 'start', 0, duration).status, 'idle');
});
test('random session persists exact selection through reload, pause, resume and repeat', () => {
  let s = { ...createState(), mode: 'random' };
  s = transition(s, 'start', 1000, 21 * 60000, 21);
  s = restoreState(JSON.stringify({ version: 1, state: s }));
  assert.equal(s.picked, 21);
  s = transition(s, 'pause', 2000);
  s = restoreState(JSON.stringify({ version: 1, state: s }));
  s = transition(s, 'resume', 3000);
  assert.equal(s.picked, 21);
  s = transition(s, 'tick', 2000000);
  s = transition(s, 'start', 3000000);
  assert.equal(s.duration, 21 * 60000);
  assert.equal(s.picked, 21);
  assert.equal(transition(s, 'reset').picked, null);
});
test('restoration rejects corrupt state and allows expired sessions to finish', () => {
  for (const raw of [null, '', 'null', '{}', 'bad', '{"version":2}']) assert.equal(restoreState(raw), null);
  const s = transition({ ...createState(), fields: fields({ minutes: '25' }) }, 'start', 1000, 25 * 60000, null);
  for (const patch of [{ deadline: null }, { duration: 3600000 }, { fields: {} }, { remaining: -1 }, { mode: 'bad' }, { status: 'paused', remaining: 0, deadline: null }, { picked: 3 }]) assert.equal(restoreState(JSON.stringify({ version: 1, state: { ...s, ...patch } })), null);
  const restored = restoreState(JSON.stringify({ version: 1, state: s }));
  assert.equal(transition(restored, 'tick', 9999999).status, 'complete');
});

test('empty manual minutes default to zero and restore a seconds-only session', () => {
  assert.equal(createState().fields.minutes, '0');
  assert.equal(validate('manual', fields({ minutes: '', seconds: '30' })).values.minutes, 0);
  assert.equal(validate('manual', fields()).fieldsValid, true);
  assert.equal(validate('manual', fields()).valid, false);
  const s = transition({ ...createState(), fields: fields({ minutes: '', seconds: '30' }) }, 'start', 1000, 30000, null);
  assert.equal(restoreState(JSON.stringify({ version: 1, state: s })).duration, 30000);
});
