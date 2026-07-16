/**
 * @typedef {Object} Landmark
 * @property {number} x - Normalized x coordinate in [0, 1].
 * @property {number} y - Normalized y coordinate in [0, 1].
 * @property {number} [z] - Normalized depth coordinate (unused, present for API compatibility).
 */

/**
 * @typedef {Object} LipActivityMeterOptions
 * @property {number} [windowSize=12] - Number of recent mouth-ratio samples kept per face
 *   for the rolling variance ("energy") calculation.
 * @property {number} [minFaceHeight=0.05] - Faces whose forehead-to-chin distance
 *   (normalized units) is smaller than this are treated as too small/unreliable to
 *   score, and report an energy of 0.
 */

/**
 * @typedef {Object} FaceState
 * @property {number[]} ratios - Rolling history of mouth-open ratios.
 * @property {number} mouthRatio - Most recent mouth-open ratio.
 * @property {number} energy - Rolling variance of `ratios`.
 * @property {number} lastUpdate - Timestamp (ms) of the last `update()` call for this face.
 */

const LANDMARK_UPPER_INNER_LIP = 13;
const LANDMARK_LOWER_INNER_LIP = 14;
const LANDMARK_FOREHEAD = 10;
const LANDMARK_CHIN = 152;

const REQUIRED_LANDMARK_INDICES = [
  LANDMARK_FOREHEAD,
  LANDMARK_UPPER_INNER_LIP,
  LANDMARK_LOWER_INNER_LIP,
  LANDMARK_CHIN,
];

/**
 * Consumes per-frame face landmark arrays (e.g. from a MediaPipe Face Landmarker,
 * 478-point layout) and produces a "speaking likelihood" score per face, derived
 * from the rolling variance of the mouth-open ratio over time.
 *
 * This tool performs no camera capture and no landmark detection itself — it is
 * purely a scorer over landmark arrays supplied by the caller.
 */
export class LipActivityMeter {
  /**
   * @param {LipActivityMeterOptions} [options]
   */
  constructor(options = {}) {
    const { windowSize = 12, minFaceHeight = 0.05 } = options;

    /** @type {number} */
    this._windowSize = windowSize;
    /** @type {number} */
    this._minFaceHeight = minFaceHeight;

    /** @type {Map<string|number, FaceState>} */
    this._faces = new Map();
  }

  /**
   * Records one frame of landmark data for a given face and updates its
   * rolling mouth-ratio energy. Never throws: malformed or missing landmark
   * data simply resets that face's current score to 0.
   *
   * @param {string|number} faceId - Stable identifier for the tracked face.
   * @param {Landmark[]} landmarks - Normalized landmark array, MediaPipe
   *   Face Landmarker 478-point layout. May be undefined or malformed.
   * @param {number} timestampMs - Capture timestamp of this frame, in milliseconds.
   * @returns {void}
   */
  update(faceId, landmarks, timestampMs) {
    let state = this._faces.get(faceId);
    if (!state) {
      state = { ratios: [], mouthRatio: 0, energy: 0, lastUpdate: timestampMs };
      this._faces.set(faceId, state);
    }
    state.lastUpdate = timestampMs;

    if (!this._hasRequiredLandmarks(landmarks)) {
      state.mouthRatio = 0;
      state.energy = 0;
      return;
    }

    const faceHeight = this._distance(landmarks[LANDMARK_FOREHEAD], landmarks[LANDMARK_CHIN]);
    if (faceHeight <= 0 || faceHeight < this._minFaceHeight) {
      state.mouthRatio = 0;
      state.energy = 0;
      return;
    }

    const mouthGap = this._distance(
      landmarks[LANDMARK_UPPER_INNER_LIP],
      landmarks[LANDMARK_LOWER_INNER_LIP]
    );
    const ratio = mouthGap / faceHeight;

    state.mouthRatio = ratio;
    state.ratios.push(ratio);
    if (state.ratios.length > this._windowSize) {
      state.ratios.shift();
    }
    state.energy = this._variance(state.ratios);
  }

  /**
   * @param {string|number} faceId
   * @returns {number} Rolling variance of the mouth-open ratio over the last
   *   `windowSize` samples for this face, or 0 if the face is unknown.
   */
  getEnergy(faceId) {
    const state = this._faces.get(faceId);
    return state ? state.energy : 0;
  }

  /**
   * @param {string|number} faceId
   * @returns {number} Most recent mouth-open ratio (inner-lip gap / face
   *   height) for this face, or 0 if the face is unknown.
   */
  getMouthRatio(faceId) {
    const state = this._faces.get(faceId);
    return state ? state.mouthRatio : 0;
  }

  /**
   * @returns {Map<string|number, number>} Snapshot map of faceId -> energy
   *   for every currently tracked face.
   */
  getAllEnergies() {
    const energies = new Map();
    for (const [faceId, state] of this._faces) {
      energies.set(faceId, state.energy);
    }
    return energies;
  }

  /**
   * Drops any tracked face that has not received an `update()` call since
   * the given timestamp, e.g. to forget faces that left the frame.
   *
   * @param {number} olderThanMs - Faces last updated before this timestamp are removed.
   * @returns {void}
   */
  prune(olderThanMs) {
    for (const [faceId, state] of this._faces) {
      if (state.lastUpdate < olderThanMs) {
        this._faces.delete(faceId);
      }
    }
  }

  /**
   * Forgets every tracked face, e.g. when the camera session restarts.
   * @returns {void}
   */
  reset() {
    this._faces.clear();
  }

  /**
   * @param {Landmark[]} landmarks
   * @returns {boolean}
   * @private
   */
  _hasRequiredLandmarks(landmarks) {
    if (!Array.isArray(landmarks)) {
      return false;
    }
    return REQUIRED_LANDMARK_INDICES.every((index) => {
      const point = landmarks[index];
      // Number.isFinite (not just typeof) matters: a single NaN coordinate
      // would otherwise poison the rolling window, reporting NaN energy for
      // the next windowSize frames.
      return point && Number.isFinite(point.x) && Number.isFinite(point.y);
    });
  }

  /**
   * @param {Landmark} a
   * @param {Landmark} b
   * @returns {number} Euclidean distance in the x/y plane.
   * @private
   */
  _distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /**
   * @param {number[]} values
   * @returns {number} Population variance of `values`, or 0 if empty.
   * @private
   */
  _variance(values) {
    if (values.length === 0) {
      return 0;
    }
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const squaredDiffs = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
    return squaredDiffs / values.length;
  }
}
