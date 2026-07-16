// rooms/logic/colour.js
function randomColour() {
  return [
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
  ];
}

// Single place that knows the shape of config.json's player_colours
// entries ({ rgb: [r,g,b], name } per letter) — resolves a letter's
// configured colour, falling back to a random one if the level layout
// defines a letter with no config entry (e.g. a 4-player layout used
// with only 2 joined). Used by GameLogic (assigning each Tank's real
// colour) and TankRoom (assigning the lobby-facing Player.color string
// before GameLogic even exists yet) — both need the exact same
// resolution, previously duplicated between them.
function resolvePlayerColour(config, letter) {
  const configured = config?.player_colours?.[letter];
  return Array.isArray(configured?.rgb) && configured.rgb.length === 3
    ? configured.rgb
    : randomColour();
}

// Builds an "r,g,b" -> name lookup from config.player_colours, so a
// tank's colour name can be read back out however its RGB was actually
// resolved above (configured, or the randomColour() fallback).
function buildColourNameLookup(config) {
  const lookup = {};
  for (const entry of Object.values(config?.player_colours || {})) {
    if (entry && Array.isArray(entry.rgb) && entry.rgb.length === 3 && entry.name) {
      lookup[entry.rgb.join(",")] = entry.name;
    }
  }
  return lookup;
}

module.exports = { randomColour, resolvePlayerColour, buildColourNameLookup };
