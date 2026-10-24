'use strict';

const MAX_DURATION = 3599000;
const DEFAULT_FIELDS = { minutes: '25', seconds: '0', minimum: '17', maximum: '25' };

function validate(mode, fields) {
  const errors = {};
  const keys = mode === 'manual' ? ['minutes', 'seconds'] : ['minimum', 'maximum'];
  const values = {};
  for (const key of keys) {
    const raw = String(fields[key] ?? '').trim();
    const min = mode === 'manual' ? 0 : 1;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > 59) {
      errors[key] = `Enter a whole number from ${min} to 59.`;
    }
    values[key] = Number(raw);
  }
  if (Object.keys(errors).length === 0) {
    if (mode === 'manual' && values.minutes === 0 && values.seconds === 0) errors.seconds = 'Set at least 1 second.';
    if (mode === 'random' && values.minimum > values.maximum) errors.maximum = 'Maximum must be at least the minimum.';
  }
  return { errors, values, valid: Object.keys(errors).length === 0 };
}

function pickMinutes(min, max, random = Math.random) {
  return min + Math.floor(random() * (max - min + 1));
}

function formatTime(milliseconds) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function createState() {
  return { status: 'idle', mode: 'manual', fields: { ...DEFAULT_FIELDS }, duration: 0, remaining: 0, deadline: null, picked: null, sound: false };
}

function remainingTime(state, now) {
  return state.status === 'running' ? Math.min(state.duration, Math.max(0, state.deadline - now)) : state.remaining;
}

function transition(state, action, now = Date.now(), duration = state.duration, picked = state.picked) {
  if (action === 'start' && (state.status === 'idle' || state.status === 'complete') && Number.isInteger(duration) && duration > 0 && duration <= MAX_DURATION) {
    return { ...state, status: 'running', duration, remaining: duration, deadline: now + duration, picked };
  }
  if (action === 'pause' && state.status === 'running') {
    const remaining = remainingTime(state, now);
    return { ...state, status: remaining > 0 ? 'paused' : 'complete', remaining, deadline: null };
  }
  if (action === 'resume' && state.status === 'paused') return { ...state, status: 'running', deadline: now + state.remaining };
  if (action === 'tick' && state.status === 'running' && remainingTime(state, now) === 0) return { ...state, status: 'complete', remaining: 0, deadline: null };
  if (action === 'reset') return { ...state, status: 'idle', duration: 0, remaining: 0, deadline: null, picked: null };
  return state;
}

function restoreState(raw) {
  try {
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1) return null;
    const state = saved.state;
    if (!state || !['idle', 'running', 'paused', 'complete'].includes(state.status) || !['manual', 'random'].includes(state.mode) || typeof state.sound !== 'boolean') return null;
    if (!state.fields || Object.keys(DEFAULT_FIELDS).some(key => typeof state.fields[key] !== 'string' || state.fields[key].length > 12)) return null;
    if (!Number.isInteger(state.duration) || state.duration < 0 || state.duration > MAX_DURATION || !Number.isFinite(state.remaining) || state.remaining < 0 || state.remaining > state.duration) return null;
    if (state.status !== 'idle') {
      const checked = validate(state.mode, state.fields);
      if (!checked.valid || state.duration < 1) return null;
      if (state.mode === 'random' && (!Number.isInteger(state.picked) || state.picked < checked.values.minimum || state.picked > checked.values.maximum || state.duration !== state.picked * 60000)) return null;
      if (state.mode === 'manual' && (state.picked !== null || state.duration !== (checked.values.minutes * 60 + checked.values.seconds) * 1000)) return null;
    }
    if (state.status === 'running' && (!Number.isSafeInteger(state.deadline) || state.deadline < 0)) return null;
    if (state.status !== 'running' && state.deadline !== null) return null;
    if (state.status === 'paused' && state.remaining === 0) return null;
    if ((state.status === 'idle' && (state.duration !== 0 || state.remaining !== 0 || state.picked !== null)) || (state.status === 'complete' && state.remaining !== 0)) return null;
    return { ...state, fields: { ...state.fields } };
  } catch { return null; }
}

// Keep the timing rules usable by Node's built-in test runner without a build step.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validate, pickMinutes, formatTime, createState, remainingTime, transition, restoreState };
}

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const STORAGE_KEY = 'tomatotimer.session.v1';
  let state = createState();
  try { state = restoreState(sessionStorage.getItem(STORAGE_KEY)) || state; } catch { /* Storage is optional. */ }
  let timerInterval = null;
  let audioContext = null;
  const activeChimeNotes = new Set();
  let hasSubmitted = false;
  const inputs = Object.fromEntries(Object.keys(DEFAULT_FIELDS).map(key => [key, $(key)]));
  for (const [key, input] of Object.entries(inputs)) input.value = state.fields[key];
  $('sound').checked = state.sound;
  document.querySelector(`input[name="mode"][value="${state.mode}"]`).checked = true;

  function save() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, state })); } catch { /* A timer also works without storage. */ }
  }
  function announce(message) { $('announcement').textContent = message; }
  function readFields() { for (const [key, input] of Object.entries(inputs)) state.fields[key] = input.value; }
  function showErrors(errors = {}) {
    for (const [key, input] of Object.entries(inputs)) {
      $(key + '-error').textContent = errors[key] || '';
      if (errors[key]) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }
  function prepareAudio() {
    if (!state.sound) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('Audio unavailable');
      audioContext ||= new Audio();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => { $('audio-note').hidden = false; });
      $('audio-note').hidden = audioContext.state !== 'closed';
    } catch { $('audio-note').hidden = false; }
  }
  function stopChime() {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    for (const { oscillator, gain } of activeChimeNotes) {
      const volume = gain.gain.value;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(volume, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.08);
      oscillator.stop(now + 0.1);
    }
  }
  function chime() {
    if (!state.sound) return;
    if (!audioContext || audioContext.state !== 'running') { $('audio-note').hidden = false; return; }
    try {
      stopChime();
      // A soft C-major arpeggio: three rounded attacks and overlapping tails.
      // The final note fades to silence about six seconds after completion.
      for (const [offset, frequency] of [[0, 523.25], [0.9, 659.25], [1.8, 783.99]]) {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const start = audioContext.currentTime + offset;
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.1, start + 0.09);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 4);
        gain.gain.linearRampToValueAtTime(0, start + 4.2);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + 4.25);
        const note = { oscillator, gain };
        activeChimeNotes.add(note);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
          activeChimeNotes.delete(note);
        };
      }
    } catch { $('audio-note').hidden = false; }
  }
  function renderTime() {
    const idle = state.status === 'idle';
    const checked = validate(state.mode, state.fields);
    const preview = state.mode === 'manual' && checked.valid ? (checked.values.minutes * 60 + checked.values.seconds) * 1000 : null;
    const remaining = idle ? preview : remainingTime(state, Date.now());
    const display = remaining === null ? '—:—' : formatTime(remaining);
    $('countdown').textContent = display;
    $('progress').style.strokeDashoffset = idle ? '0' : String(100 * (1 - remaining / state.duration));
    document.title = idle ? 'Tomatotimer — a little time, well spent' : `${display} · ${state.status === 'complete' ? 'Time’s up' : state.status === 'paused' ? 'Paused' : 'Tomatotimer'}`;
  }
  function render() {
    const idle = state.status === 'idle';
    document.body.dataset.state = state.status;
    $('mode-fields').disabled = !idle;
    $('duration-fields').disabled = !idle;
    $('manual-inputs').hidden = state.mode !== 'manual';
    $('random-inputs').hidden = state.mode !== 'random';
    // Hidden inputs cannot interfere with form submission or keyboard access.
    for (const [key, input] of Object.entries(inputs)) input.disabled = !idle || (state.mode === 'manual' ? ['minimum', 'maximum'].includes(key) : ['minutes', 'seconds'].includes(key));
    $('state-label').textContent = { idle: 'Ready when you are', running: 'A moment, just for you', paused: 'Paused · take your time', complete: 'Time’s up. Nicely done.' }[state.status];
    $('dial-caption').textContent = idle && state.mode === 'random' ? 'LET CHANCE DECIDE' : state.status === 'running' ? 'RUNNING · MIN / SEC' : 'MINUTES / SECONDS';
    $('session-summary').textContent = state.picked !== null ? `Picked ${state.picked} minutes from ${state.fields.minimum}–${state.fields.maximum}` : idle ? 'One thing at a time.' : `${formatTime(state.duration)} set aside for you.`;
    $('setup-hint').textContent = idle ? (state.mode === 'manual' ? 'Anything from a second to just under an hour.' : 'We’ll pick a whole minute, including either end.') : state.status === 'complete' ? 'Go again, or make room for something new.' : 'Reset to change duration.';
    $('primary-action').textContent = { idle: state.mode === 'manual' ? 'Start timer ↗' : 'Pick & start ↗', running: 'Pause', paused: 'Resume', complete: 'Start again' }[state.status];
    $('reset-action').hidden = idle;
    $('reset-action').textContent = state.status === 'complete' ? 'Change timer' : 'Reset';
    $('sound-status').textContent = state.sound ? 'Sound on' : 'Sound off';
    renderTime();
  }
  function updateTicker() {
    clearInterval(timerInterval);
    timerInterval = state.status === 'running' ? setInterval(tick, 200) : null;
  }
  function change(action, duration, picked) {
    if (action === 'start' || action === 'reset') stopChime();
    const previous = state.status;
    state = transition(state, action, Date.now(), duration, picked);
    if (state.status === 'complete' && previous !== 'complete') { announce('Time’s up. Your timer is complete.'); chime(); }
    else if (state.status === 'running' && previous !== 'running') announce(action === 'resume' ? 'Timer resumed.' : `Timer started for ${formatTime(state.duration)}.${state.picked !== null ? ` Picked ${state.picked} minutes.` : ''}`);
    else if (state.status === 'paused') announce(`Timer paused with ${formatTime(state.remaining)} remaining.`);
    else if (action === 'reset') announce('Timer reset. Choose a duration.');
    save();
    render();
    updateTicker();
  }
  function tick() {
    if (state.status === 'running' && remainingTime(state, Date.now()) === 0) change('tick');
    else renderTime();
  }
  $('timer-form').addEventListener('submit', event => {
    event.preventDefault();
    prepareAudio();
    if (state.status === 'running') { change('pause'); return; }
    if (state.status === 'paused') { change('resume'); return; }
    if (state.status === 'complete') { change('start'); return; }
    readFields();
    hasSubmitted = true;
    const checked = validate(state.mode, state.fields);
    showErrors(checked.errors);
    if (!checked.valid) { inputs[Object.keys(checked.errors)[0]].focus(); announce('Check the duration fields.'); return; }
    const picked = state.mode === 'random' ? pickMinutes(checked.values.minimum, checked.values.maximum) : null;
    const duration = picked !== null ? picked * 60000 : (checked.values.minutes * 60 + checked.values.seconds) * 1000;
    change('start', duration, picked);
    $('primary-action').focus();
  });
  $('reset-action').addEventListener('click', () => {
    hasSubmitted = false;
    showErrors();
    change('reset');
    $('primary-action').focus();
  });
  for (const input of Object.values(inputs)) input.addEventListener('input', () => {
    readFields();
    if (hasSubmitted) showErrors(validate(state.mode, state.fields).errors);
    save();
    renderTime();
  });
  document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', () => {
    state.mode = input.value;
    hasSubmitted = false;
    showErrors();
    save();
    render();
  }));
  $('sound').addEventListener('change', () => {
    state.sound = $('sound').checked;
    if (state.sound) prepareAudio();
    else { stopChime(); $('audio-note').hidden = true; }
    save();
    render();
  });
  function updateClock() {
    const now = new Date();
    $('clock').textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(now);
    $('clock').dateTime = now.toISOString();
  }
  document.addEventListener('visibilitychange', () => { tick(); updateClock(); });
  window.addEventListener('pageshow', () => { tick(); updateClock(); });
  // Restoring an expired session completes it once; audio requires a fresh user gesture.
  render();
  tick();
  updateTicker();
  updateClock();
  setInterval(updateClock, 1000);
}
