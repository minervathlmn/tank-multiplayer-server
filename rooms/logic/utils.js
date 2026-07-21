// rooms/logic/utils.js
//
// Small stateless helpers shared across the logic layer: numeric clamping,
// p5-style trig shims (radians/sin/cos), and colour helpers. No local
// requires — this sits at the bottom of the dependency graph.

// --- Bounds checks ----------------------------------------------------------

/**
 * Clamp a value to the inclusive range [min, max].
 * Shared by Tank/Projectile/Bot for terrain-array bounds checks.
 *
 * @param {number} value - The value to clamp.
 * @param {number} min - Lower bound (inclusive).
 * @param {number} max - Upper bound (inclusive).
 * @returns {number} `value`, clamped to [min, max].
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


// --- p5 shims ----------------------------------------------------------------
// p5 injects radians()/degrees()/sin()/cos() as globals in the browser.
// The server has no p5 instance, so these are the plain-JS equivalents —
// identical math, just imported instead of ambient.

/**
 * Convert degrees to radians (p5's `radians()`, as a plain function).
 * @param {number} deg - Angle in degrees.
 * @returns {number} Angle in radians.
 */
function radians(deg) { return (deg * Math.PI) / 180; }

/**
 * Convert radians to degrees (p5's `degrees()`, as a plain function).
 * @param {number} rad - Angle in radians.
 * @returns {number} Angle in degrees.
 */
function degrees(rad) { return (rad * 180) / Math.PI; }

/**
 * Sine of an angle in radians (p5's `sin()`, as a plain function).
 * @param {number} rad - Angle in radians.
 * @returns {number} Sine of `rad`.
 */
function sin(rad) { return Math.sin(rad); }

/**
 * Cosine of an angle in radians (p5's `cos()`, as a plain function).
 * @param {number} rad - Angle in radians.
 * @returns {number} Cosine of `rad`.
 */
function cos(rad) { return Math.cos(rad); }


// --- Colour resolution ---------------------------------------------------

/**
 * Generate a uniformly random RGB colour.
 * Used as the fallback when a player letter has no configured colour.
 *
 * @returns {[number, number, number]} An [r, g, b] triple, each in [0, 255].
 */
function randomColour() {
  return [
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
  ];
}

/**
 * Resolve a player letter's colour from level config, falling back to a
 * random colour if unconfigured.
 *
 * Single place that knows the shape of config.json's player_colours
 * entries ({ rgb: [r,g,b], name } per letter) — resolves a letter's
 * configured colour, falling back to a random one if the level layout
 * defines a letter with no config entry (e.g. a 4-player layout used
 * with only 2 joined). Used by GameLogic (assigning each Tank's real
 * colour) and TankRoom (assigning the lobby-facing Player.color string
 * before GameLogic even exists yet) — both need the exact same
 * resolution, previously duplicated between them.
 *
 * @param {object} config - Level config object (see levels/config.json).
 * @param {string} letter - Player spawn letter (e.g. 'A', 'B').
 * @returns {[number, number, number]} An [r, g, b] triple: the configured
 *   colour if valid, otherwise a random fallback from `randomColour()`.
 */
function resolvePlayerColour(config, letter) {
  const configured = config?.player_colours?.[letter];
  return isValidRGB(configured?.rgb) ? configured.rgb : randomColour();
}

/**
 * Check whether a value is a valid [r, g, b] colour triple.
 * @param {*} value - Value to check.
 * @returns {boolean} True if value is a 3-element array.
 */
function isValidRGB(value) {
  return Array.isArray(value) && value.length === 3;
}

/**
 * Build an "r,g,b" -> name lookup from config.player_colours, so a
 * tank's colour name can be read back out however its RGB was actually
 * resolved above (configured, or the randomColour() fallback).
 *
 * Note: a tank whose colour came from the `randomColour()` fallback in
 * `resolvePlayerColour` will not have a matching entry here — callers
 * must handle a missing/undefined name gracefully.
 *
 * @param {object} config - Level config object (see levels/config.json).
 * @returns {Object.<string, string>} Map of "r,g,b" strings to colour names,
 *   containing only the colours explicitly configured in `config`.
 */
function buildColourNameLookup(config) {
  const lookup = {};
  for (const entry of Object.values(config?.player_colours || {})) {
    if (entry && Array.isArray(entry.rgb) && entry.rgb.length === 3 && entry.name) {
      lookup[entry.rgb.join(",")] = entry.name;
    }
  }
  return lookup;
}

module.exports = { clamp, radians, degrees, sin, cos, randomColour, resolvePlayerColour, isValidRGB, buildColourNameLookup };