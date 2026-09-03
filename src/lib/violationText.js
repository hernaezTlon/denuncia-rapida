// The violation categories, the one-letter menu we ask in the self-chat when the AI
// can't classify (no Ollama on the Air), and the specific sentence we send to Boti.
// A bare category label ("Estacionado en lugar prohibido") got a report dismissed:
// "las fotografías no muestran ... lo que imposibilita identificar la falta". The
// reviewer needs to be told what to look at.

const VIOLATION_OPTIONS = [
  'Estacionado en entrada de garage',
  'Estacionado en doble fila',
  'Estacionado sobre la vereda',
  'Estacionado en rampa de discapacitados',
  'Estacionado en parada de colectivo',
  'Estacionado en paso peatonal',
  'Estacionado en ochava',
  'Estacionado en lugar prohibido'
];
const DEFAULT_VIOLATION = 'Estacionado en lugar prohibido';

// Letter menu, most common first
const TYPE_MENU = [
  ['A', 'Estacionado en paso peatonal', 'sobre la senda peatonal'],
  ['B', 'Estacionado en rampa de discapacitados', 'en rampa de discapacitados'],
  ['C', 'Estacionado en doble fila', 'en doble fila'],
  ['D', 'Estacionado en entrada de garage', 'tapando una entrada de garage'],
  ['E', 'Estacionado sobre la vereda', 'sobre la vereda'],
  ['F', 'Estacionado en parada de colectivo', 'en parada de colectivo'],
  ['G', 'Estacionado en ochava', 'en la ochava (esquina)']
];

const SENTENCES = {
  'Estacionado en paso peatonal': 'Vehículo{plate} estacionado sobre la senda peatonal, obstruyendo el cruce de peatones. En la foto se ve el auto sobre las líneas del cruce.',
  'Estacionado en rampa de discapacitados': 'Vehículo{plate} estacionado sobre la rampa para personas con discapacidad, bloqueando el acceso a la vereda.',
  'Estacionado en doble fila': 'Vehículo{plate} estacionado en doble fila, obstruyendo la circulación del carril.',
  'Estacionado en entrada de garage': 'Vehículo{plate} estacionado tapando la entrada de un garage, impidiendo la salida de los vehículos.',
  'Estacionado sobre la vereda': 'Vehículo{plate} estacionado sobre la vereda, obstruyendo el paso de los peatones.',
  'Estacionado en parada de colectivo': 'Vehículo{plate} estacionado sobre la parada de colectivo, impidiendo que el colectivo se arrime al cordón.',
  'Estacionado en ochava': 'Vehículo{plate} estacionado sobre la ochava de la esquina, dentro de la zona prohibida y tapando la visibilidad.',
  'Estacionado en lugar prohibido': 'Vehículo{plate} estacionado en un lugar donde está prohibido estacionar (señalizado), obstruyendo la circulación.'
};

function describeViolation(category, { plate } = {}) {
  const template = SENTENCES[category];
  if (!template) return String(category || SENTENCES[DEFAULT_VIOLATION]).trim();   // free text from the user
  return template.replace('{plate}', plate ? ` patente ${plate}` : '');
}

function parseTypeAnswer(text) {
  const t = String(text || '').trim().toUpperCase().replace(/[.)]$/, '');
  const hit = TYPE_MENU.find(([letter]) => letter === t);
  return hit ? hit[1] : null;
}

function typeMenuText() {
  return TYPE_MENU.map(([l, , short]) => `${l}. ${short}`).join('\n');
}

module.exports = { VIOLATION_OPTIONS, DEFAULT_VIOLATION, describeViolation, parseTypeAnswer, typeMenuText };
