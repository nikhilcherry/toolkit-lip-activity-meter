// Run with: node --test
// This tool has zero DOM/network dependency -- it's a pure scorer over
// landmark arrays -- so every test drives the real public API directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LipActivityMeter } from '../lip-activity-meter.js';

const FOREHEAD = 10, UPPER_LIP = 13, LOWER_LIP = 14, CHIN = 152;

/** Sparse landmark array with only the 4 required points set -- the meter
 * never reads any other index, so the rest can be left undefined. */
function landmarks({ forehead = { x: 0.5, y: 0 }, upperLip, lowerLip, chin = { x: 0.5, y: 1 } }) {
  const arr = new Array(CHIN + 1);
  arr[FOREHEAD] = forehead;
  arr[UPPER_LIP] = upperLip;
  arr[LOWER_LIP] = lowerLip;
  arr[CHIN] = chin;
  return arr;
}

function closedMouth() {
  // face height = 1 (forehead (0.5,0) to chin (0.5,1)); lips touching -> ratio 0
  return landmarks({ upperLip: { x: 0.5, y: 0.5 }, lowerLip: { x: 0.5, y: 0.5 } });
}

function openMouth(gap) {
  return landmarks({ upperLip: { x: 0.5, y: 0.5 - gap / 2 }, lowerLip: { x: 0.5, y: 0.5 + gap / 2 } });
}

test('unknown faceId reports 0 energy and 0 mouthRatio', () => {
  const meter = new LipActivityMeter();
  assert.equal(meter.getEnergy('nobody'), 0);
  assert.equal(meter.getMouthRatio('nobody'), 0);
});

test('mouthRatio = inner-lip gap / face height, with correct closed-mouth baseline', () => {
  const meter = new LipActivityMeter();
  meter.update('A', closedMouth(), 0);
  assert.equal(meter.getMouthRatio('A'), 0);
});

test('mouthRatio scales with mouth gap relative to face height', () => {
  const meter = new LipActivityMeter();
  // face height 1, gap 0.2 -> ratio should be exactly 0.2
  meter.update('A', openMouth(0.2), 0);
  assert.ok(Math.abs(meter.getMouthRatio('A') - 0.2) < 1e-9);
});

test('update() never throws on undefined landmarks, resets to 0', () => {
  const meter = new LipActivityMeter();
  meter.update('A', openMouth(0.3), 0);
  assert.ok(meter.getMouthRatio('A') > 0);

  assert.doesNotThrow(() => meter.update('A', undefined, 33));
  assert.equal(meter.getMouthRatio('A'), 0);
  assert.equal(meter.getEnergy('A'), 0);
});

test('update() never throws on non-array landmarks', () => {
  const meter = new LipActivityMeter();
  assert.doesNotThrow(() => meter.update('A', {}, 0));
  assert.equal(meter.getEnergy('A'), 0);
});

test('update() never throws on landmarks missing a required point', () => {
  const meter = new LipActivityMeter();
  const partial = landmarks({ upperLip: { x: 0.5, y: 0.4 }, lowerLip: undefined });
  assert.doesNotThrow(() => meter.update('A', partial, 0));
  assert.equal(meter.getMouthRatio('A'), 0);
});

test('faces smaller than minFaceHeight report 0 regardless of mouth gap', () => {
  const meter = new LipActivityMeter({ minFaceHeight: 0.5 });
  // face height 0.1 (well under minFaceHeight), wide-open mouth
  const tiny = landmarks({
    forehead: { x: 0.5, y: 0 },
    chin: { x: 0.5, y: 0.1 },
    upperLip: { x: 0.5, y: 0.02 },
    lowerLip: { x: 0.5, y: 0.08 },
  });
  meter.update('A', tiny, 0);
  assert.equal(meter.getMouthRatio('A'), 0);
  assert.equal(meter.getEnergy('A'), 0);
});

test('a perfectly still (closed, unmoving) mouth has 0 energy', () => {
  const meter = new LipActivityMeter({ windowSize: 10 });
  for (let i = 0; i < 10; i++) meter.update('A', closedMouth(), i * 33);
  assert.equal(meter.getEnergy('A'), 0);
});

test('an oscillating (talking) mouth has much higher energy than a still one', () => {
  const meter = new LipActivityMeter({ windowSize: 20 });
  for (let i = 0; i < 20; i++) {
    // sine-driven gap, simulating speech
    const gap = 0.1 + 0.08 * Math.sin(i);
    meter.update('talking', openMouth(gap), i * 33);
  }
  for (let i = 0; i < 20; i++) meter.update('silent', closedMouth(), i * 33);

  const talkingEnergy = meter.getEnergy('talking');
  const silentEnergy = meter.getEnergy('silent');
  assert.ok(talkingEnergy > 0);
  assert.equal(silentEnergy, 0);
  assert.ok(talkingEnergy > silentEnergy * 10);
});

test('windowSize caps the rolling history -- energy reflects only recent samples', () => {
  const meter = new LipActivityMeter({ windowSize: 3 });
  // Feed a wildly oscillating ratio for a while, then settle into a
  // perfectly still closed mouth. Once >= windowSize still samples have
  // been fed, the noisy history should have fully rolled out.
  for (let i = 0; i < 10; i++) meter.update('A', openMouth(0.1 + 0.5 * (i % 2)), i);
  assert.ok(meter.getEnergy('A') > 0);

  for (let i = 0; i < 3; i++) meter.update('A', closedMouth(), 100 + i);
  assert.equal(meter.getEnergy('A'), 0);
});

test('getAllEnergies returns a snapshot of every tracked face', () => {
  const meter = new LipActivityMeter();
  meter.update('A', openMouth(0.2), 0);
  meter.update('B', closedMouth(), 0);

  const snapshot = meter.getAllEnergies();
  assert.deepEqual([...snapshot.keys()].sort(), ['A', 'B']);
  assert.equal(snapshot.get('B'), 0);
});

test('getAllEnergies snapshot is independent of later updates', () => {
  const meter = new LipActivityMeter();
  meter.update('A', closedMouth(), 0);
  const snapshot = meter.getAllEnergies();
  meter.update('B', closedMouth(), 0);
  assert.equal(snapshot.has('B'), false);
});

test('prune drops faces not updated since the given timestamp', () => {
  const meter = new LipActivityMeter();
  meter.update('old', closedMouth(), 0);
  meter.update('recent', closedMouth(), 1000);

  meter.prune(500);

  assert.equal(meter.getAllEnergies().has('old'), false);
  assert.equal(meter.getAllEnergies().has('recent'), true);
});

test('prune is a strict less-than comparison -- a face updated exactly at the cutoff survives', () => {
  const meter = new LipActivityMeter();
  meter.update('A', closedMouth(), 500);
  meter.prune(500);
  assert.equal(meter.getAllEnergies().has('A'), true);
});
