// rooms/logic/colour.js
function randomColour() {
  return [
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
  ];
}

module.exports = { randomColour };
