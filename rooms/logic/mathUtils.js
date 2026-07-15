// rooms/logic/mathUtils.js
// p5 injects radians()/degrees()/sin()/cos() as globals in the browser.
// The server has no p5 instance, so these are the plain-JS equivalents —
// identical math, just imported instead of ambient.

function radians(deg) { return (deg * Math.PI) / 180; }
function degrees(rad) { return (rad * 180) / Math.PI; }
function sin(rad) { return Math.sin(rad); }
function cos(rad) { return Math.cos(rad); }

module.exports = { radians, degrees, sin, cos };
