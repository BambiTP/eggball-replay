// Eggball replay viewer. Plain JavaScript, no libraries.
// Replay file: first line is JSON {"eggballReplay": 3, "info": {...}}; every other line is "<ms>\t<kind>\t<json>".
// Positions are in units; one tile is 0.4 units, so the map (64 x 22 tiles) is 25.6 x 8.8 units.

const PIXELS_PER_UNIT = 50;
const PLAYER_RADIUS_UNITS = 0.19;
const EGG_RADIUS_UNITS = 0.115;
const TILE_UNITS = 0.4;
// replay positions put the centre of tile (column, row) at (column, row) * 0.4, so the map tiles sit half a tile
// up and left of the positions; everything that moves is drawn shifted by this to line up with the walls
const ENTITY_OFFSET = TILE_UNITS * PIXELS_PER_UNIT / 2;

const mapCanvas = document.getElementById('map-canvas');
const drawing = mapCanvas.getContext('2d');
const statusLine = document.getElementById('status-line');
const scoreLine = document.getElementById('score-line');
const playPauseButton = document.getElementById('play-pause-button');
const timeSlider = document.getElementById('time-slider');
const timeLabel = document.getElementById('time-label');
const speedSelect = document.getElementById('speed-select');
const showNamesCheckbox = document.getElementById('show-names-checkbox');
const followSelect = document.getElementById('follow-select');
const zoomSelect = document.getElementById('zoom-select');
const showTrailsCheckbox = document.getElementById('show-trails-checkbox');

// The replays come from the owner's computer through a Cloudflare tunnel whose address changes every time it restarts.
// The tunnel writes its current address into this gist.
const GIST_ADDRESS = 'https://api.github.com/gists/62dc5b24ce4a3de9936097a4784d3672';
let serverAddress = null;

async function findServer() {
  const response = await fetch(GIST_ADDRESS, { cache: 'no-store' });
  const gist = await response.json();
  const address = JSON.parse(gist.files['eggball-replay.json'].content).url;
  if (!address) throw new Error('no address published yet');
  return address.replace(/\/$/, '');
}

let replay = null;          // the loaded game, see parseReplay
let currentMs = 0;          // playback position
let playing = false;
let view = { scale: 1, offsetX: 0, offsetY: 0 };   // current camera: screen = world * scale + offset
let lastFrameClock = null;  // performance.now() of the previous animation frame

// ---------- reading a replay ----------

function parseReplay(text) {
  const lines = text.split('\n');
  const header = JSON.parse(lines[0]);
  const game = {
    info: header.info,
    rows: null,                // map grid: array of strings/arrays of '#', '.', 'R', 'B'
    team: {}, name: {},        // player id -> team / name
    sampleTimes: {}, samples: {},   // player id -> times, [x, y, vx, vy]
    deadChanges: {},           // player id -> [[ms, isDead]]
    eggChanges: [],            // [ms, state, holder]
    bodies: [],                // [ms, x, y, vx, vy]  the egg in flight
    scores: [],                // [ms, red, blue]
    tileChanges: [],           // [ms, [{x, y, to}]]
    lastMs: 0,
  };
  for (const player of header.info.players || []) {
    if (player.id !== undefined) { game.team[player.id] = player.team; game.name[player.id] = player.name; }
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const firstTab = line.indexOf('\t');
    const secondTab = line.indexOf('\t', firstTab + 1);
    const ms = parseInt(line.slice(0, firstTab), 10);
    const kind = line.slice(firstTab + 1, secondTab);
    if (kind !== 'welcome' && kind !== 'players' && kind !== 'update' && kind !== 'eggState' &&
        kind !== 'body' && kind !== 'score' && kind !== 'tiles') {
      game.lastMs = ms;
      continue;
    }
    const data = JSON.parse(line.slice(secondTab + 1));
    game.lastMs = ms;
    if (kind === 'welcome') {
      game.rows = data.field.rows.map(row => Array.from(row));
      game.art = data.field.info && data.field.info.art;   // name of the field texture, e.g. field-6
    } else if (kind === 'players') {
      for (const p of data.list) {
        game.team[p.id] = p.team;
        game.name[p.id] = p.name;
        if (p.px !== undefined && p.px !== null) addSample(game, p.id, ms, p.px, p.py, p.vx || 0, p.vy || 0);
        (game.deadChanges[p.id] = game.deadChanges[p.id] || []).push([ms, !!p.dead]);
      }
    } else if (kind === 'update') {
      for (const m of data.moves) {
        const last = lastSample(game, m[0]);
        const sample = [1, 2, 3, 4].map(k => (m[k] !== undefined && m[k] !== null) ? m[k] : (last ? last[k - 1] : 0));
        addSample(game, m[0], ms, sample[0], sample[1], sample[2], sample[3]);
      }
      for (const c of data.changes || []) {
        if ('dead' in c) (game.deadChanges[c.id] = game.deadChanges[c.id] || []).push([ms, !!c.dead]);
      }
    } else if (kind === 'eggState') {
      game.eggChanges.push([ms, data.state, data.holder]);
    } else if (kind === 'body') {
      game.bodies.push([ms, data.px, data.py, data.vx || 0, data.vy || 0]);
    } else if (kind === 'score') {
      game.scores.push([ms, data.red, data.blue]);
    } else if (kind === 'tiles') {
      game.tileChanges.push([ms, data.list]);
    }
  }
  return game;
}

function addSample(game, id, ms, x, y, vx, vy) {
  if (!game.samples[id]) { game.samples[id] = []; game.sampleTimes[id] = []; }
  game.sampleTimes[id].push(ms);
  game.samples[id].push([x, y, vx, vy]);
}

function lastSample(game, id) {
  const list = game.samples[id];
  return list ? list[list.length - 1] : null;
}

// ---------- looking things up at a time ----------

// index of the last entry whose time (read with getTime) is <= ms, or -1
function lastIndexAtOrBefore(list, ms, getTime) {
  let low = 0, high = list.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (getTime(list[mid]) <= ms) { found = mid; low = mid + 1; } else { high = mid - 1; }
  }
  return found;
}

function playerPosition(id, ms) {
  const times = replay.sampleTimes[id];
  if (!times) return null;
  const i = lastIndexAtOrBefore(times, ms, t => t);
  if (i < 0) return null;
  const [x, y, vx, vy] = replay.samples[id][i];
  if (i + 1 < times.length && times[i + 1] - times[i] < 600) {
    const next = replay.samples[id][i + 1];
    if (Math.abs(next[0] - x) < 3 && Math.abs(next[1] - y) < 3) {   // otherwise it is a respawn jump
      const fraction = (ms - times[i]) / (times[i + 1] - times[i]);
      return [x + (next[0] - x) * fraction, y + (next[1] - y) * fraction];
    }
  }
  const seconds = Math.min(ms - times[i], 300) / 1000;
  return [x + vx * seconds, y + vy * seconds];
}

function playerIsDead(id, ms) {
  const changes = replay.deadChanges[id];
  if (!changes) return false;
  const i = lastIndexAtOrBefore(changes, ms, c => c[0]);
  return i >= 0 ? changes[i][1] : false;
}

function playerIsInGame(player, ms) {
  return ms >= player.from && (player.to === null || player.to === undefined || ms <= player.to);
}

function eggStateAt(ms) {
  const i = lastIndexAtOrBefore(replay.eggChanges, ms, c => c[0]);
  return i >= 0 ? { state: replay.eggChanges[i][1], holder: replay.eggChanges[i][2] } : { state: '', holder: null };
}

function eggFlightPosition(ms) {
  const i = lastIndexAtOrBefore(replay.bodies, ms, b => b[0]);
  if (i < 0) return null;
  const [t, x, y, vx, vy] = replay.bodies[i];
  const seconds = Math.min(ms - t, 1500) / 1000;
  return [x + vx * seconds, y + vy * seconds];
}

function scoreAt(ms) {
  const i = lastIndexAtOrBefore(replay.scores, ms, s => s[0]);
  return i >= 0 ? { red: replay.scores[i][1], blue: replay.scores[i][2] } : { red: 0, blue: 0 };
}

// the map as it is at a time: the endzone tiles change at halftime
function mapAt(ms) {
  const grid = replay.rows.map(row => row.slice());
  for (const [changeMs, list] of replay.tileChanges) {
    if (changeMs > ms) break;
    for (const tile of list) grid[tile.y][tile.x] = tile.to;
  }
  return grid;
}

// ---------- drawing ----------

// the real eggball textures, served from ~/playeggball/eggball/art
function loadImage(name) {
  const image = new Image();
  image.src = 'art/' + name;
  image.onload = () => draw();
  return image;
}
const redBallImage = loadImage('ball-red.png');
const blueBallImage = loadImage('ball-blue.png');
const eggImage = loadImage('egg.png');
const fieldImages = {};   // texture name -> image
function fieldImageFor(name) {
  if (!name) return null;
  if (!fieldImages[name]) fieldImages[name] = loadImage(name + '.png');
  return fieldImages[name];
}
function imageReady(image) { return image && image.complete && image.naturalWidth > 0; }

const TILE_COLOURS = { '#': '#333333', '.': '#e6e6e6', 'R': '#f4b6b6', 'B': '#b6c8f4' };
const TEAM_COLOURS = { red: '#d62828', blue: '#1d4ed8' };

function draw() {
  sizeCanvas();
  drawing.setTransform(1, 0, 0, 1, 0, 0);
  drawing.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  if (!replay) return;
  const tilePixels = TILE_UNITS * PIXELS_PER_UNIT;
  const grid = mapAt(currentMs);
  setCamera(grid[0].length * tilePixels, grid.length * tilePixels);
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      drawing.fillStyle = TILE_COLOURS[grid[y][x]] || '#e6e6e6';
      drawing.fillRect(x * tilePixels, y * tilePixels, tilePixels, tilePixels);
    }
  }
  // the field texture covers everything inside the outer wall
  const field = fieldImageFor(replay.art);
  if (imageReady(field)) {
    const innerWidth = (grid[0].length - 2) * tilePixels, innerHeight = (grid.length - 2) * tilePixels;
    drawing.drawImage(field, tilePixels, tilePixels, innerWidth, innerHeight);
    // after halftime the endzone colours swap sides: repaint each endzone from the other end of the texture
    if (grid[1][1] === 'R') {
      const endWidth = field.naturalWidth * 3 / (grid[0].length - 2);
      const endPixels = 3 * tilePixels;
      drawing.drawImage(field, field.naturalWidth - endWidth, 0, endWidth, field.naturalHeight,
        tilePixels, tilePixels, endPixels, innerHeight);
      drawing.drawImage(field, 0, 0, endWidth, field.naturalHeight,
        tilePixels + innerWidth - endPixels, tilePixels, endPixels, innerHeight);
    }
  }
  drawing.translate(ENTITY_OFFSET, ENTITY_OFFSET);
  const egg = eggStateAt(currentMs);
  const playersHere = (replay.info.players || []).filter(p => p.id !== undefined && playerIsInGame(p, currentMs));

  if (showTrailsCheckbox.checked) {
    for (const player of playersHere) {
      drawing.strokeStyle = TEAM_COLOURS[replay.team[player.id]];
      drawing.globalAlpha = 0.4;
      drawing.beginPath();
      let started = false;
      for (let back = 2000; back >= 0; back -= 100) {
        const ms = currentMs - back;
        const at = playerPosition(player.id, ms);
        if (!at || playerIsDead(player.id, ms)) { started = false; continue; }
        if (started) drawing.lineTo(at[0] * PIXELS_PER_UNIT, at[1] * PIXELS_PER_UNIT);
        else drawing.moveTo(at[0] * PIXELS_PER_UNIT, at[1] * PIXELS_PER_UNIT);
        started = true;
      }
      drawing.stroke();
      drawing.globalAlpha = 1;
    }
  }

  for (const player of playersHere) {
    if (playerIsDead(player.id, currentMs)) continue;
    const at = playerPosition(player.id, currentMs);
    if (!at) continue;
    const px = at[0] * PIXELS_PER_UNIT, py = at[1] * PIXELS_PER_UNIT;
    const radius = PLAYER_RADIUS_UNITS * PIXELS_PER_UNIT;
    const ballImage = replay.team[player.id] === 'red' ? redBallImage : blueBallImage;
    if (imageReady(ballImage)) {
      drawing.drawImage(ballImage, px - radius - 1, py - radius - 1, radius * 2 + 2, radius * 2 + 2);
    } else {
      drawing.fillStyle = TEAM_COLOURS[replay.team[player.id]];
      drawing.beginPath();
      drawing.arc(px, py, radius, 0, Math.PI * 2);
      drawing.fill();
    }
    if (egg.holder === player.id) drawEgg(px, py);
    if (showNamesCheckbox.checked) drawName(replay.name[player.id] || String(player.id), px, py);
  }

  // the egg: on its holder it is shown by the gold ring; in flight it is drawn on its own
  if (egg.holder === null || egg.holder === undefined) {
    const at = eggFlightPosition(currentMs);
    if (at) drawEgg(at[0] * PIXELS_PER_UNIT, at[1] * PIXELS_PER_UNIT);
  }

  drawScoreboard(egg);
  const score = scoreAt(currentMs);
  const stateText = egg.state ? ' | round state: ' + egg.state : '';
  scoreLine.textContent = 'Red ' + score.red + ' - ' + score.blue + ' Blue' + stateText;
  timeLabel.textContent = formatTime(currentMs) + ' / ' + formatTime(replay.lastMs);
  timeSlider.value = currentMs;
}

// ---------- camera, scoreboard, following ----------

// make the canvas's drawing size match how big it is on screen, so it fits any window and stays sharp
function sizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(mapCanvas.clientWidth * ratio), height = Math.round(mapCanvas.clientHeight * ratio);
  if (mapCanvas.width !== width || mapCanvas.height !== height) { mapCanvas.width = width; mapCanvas.height = height; }
}

function followedPosition() {
  const choice = followSelect.value;
  if (choice === 'none') return null;
  if (choice === 'egg') {
    const egg = eggStateAt(currentMs);
    if (egg.holder !== null && egg.holder !== undefined) return playerPosition(egg.holder, currentMs);
    return eggFlightPosition(currentMs);
  }
  if (playerIsDead(parseInt(choice, 10), currentMs)) return null;
  return playerPosition(parseInt(choice, 10), currentMs);
}

// worldWidth/worldHeight are in drawing pixels (50 per unit). The whole-map view fits the window. Following uses
// the game's own watch camera (extras/watchcam.js): at zoom 1 the window height shows 20 tiles, the camera is
// centred on the target with no stopping at the map edge, and it eases toward the target (0.2 of the way per frame).
const GAME_VIEW_TILES_HIGH = 20;
let smoothedCentre = null;   // where the following camera is now, in drawing pixels
function setCamera(worldWidth, worldHeight) {
  const fit = Math.min(mapCanvas.width / worldWidth, mapCanvas.height / worldHeight);
  const following = followedPosition();
  let scale = fit, centreX = worldWidth / 2, centreY = worldHeight / 2;
  if (following) {
    const tilePixels = TILE_UNITS * PIXELS_PER_UNIT;
    scale = mapCanvas.height / (GAME_VIEW_TILES_HIGH * tilePixels) / parseFloat(zoomSelect.value);
    const targetX = following[0] * PIXELS_PER_UNIT + ENTITY_OFFSET, targetY = following[1] * PIXELS_PER_UNIT + ENTITY_OFFSET;
    // eased while playing; when paused or jumping in time the camera goes straight to the target
    if (smoothedCentre && playing) {
      smoothedCentre = [smoothedCentre[0] + (targetX - smoothedCentre[0]) * 0.2, smoothedCentre[1] + (targetY - smoothedCentre[1]) * 0.2];
    } else {
      smoothedCentre = [targetX, targetY];
    }
    centreX = smoothedCentre[0];
    centreY = smoothedCentre[1];
  } else {
    smoothedCentre = null;
  }
  view = { scale, offsetX: mapCanvas.width / 2 - centreX * scale, offsetY: mapCanvas.height / 2 - centreY * scale };
  drawing.setTransform(scale, 0, 0, scale, view.offsetX, view.offsetY);
}

// red score on the left, blue on the right, clock in the middle, drawn on top of the map
function drawScoreboard(egg) {
  const score = scoreAt(currentMs);
  const ratio = window.devicePixelRatio || 1;
  drawing.setTransform(ratio, 0, 0, ratio, 0, 0);
  const middle = mapCanvas.clientWidth / 2;
  drawing.lineJoin = 'round';
  drawing.lineWidth = 4;
  drawing.strokeStyle = '#000000';
  drawing.textBaseline = 'top';
  drawing.font = 'bold 34px Arial';
  const parts = [
    ['right', String(score.red), middle - 50, '#ff3b3b'],
    ['left', String(score.blue), middle + 50, '#4d7cff'],
    ['center', formatTime(currentMs), middle, '#ffffff'],
  ];
  drawing.globalAlpha = 0.9;
  for (const [align, text, x, colour] of parts) {
    drawing.textAlign = align;
    drawing.strokeText(text, x, 24);
    drawing.fillStyle = colour;
    drawing.fillText(text, x, 24);
  }
  drawing.font = 'bold 14px Arial';
  drawing.textAlign = 'center';
  const names = replay.info.names || {};
  const state = egg.state === 'huddle' ? 'HUDDLE UP!' : egg.state === 'waiting' ? 'Goal!' : '';
  const line = (names.red || 'Red') + '  vs  ' + (names.blue || 'Blue') + (state ? '   ' + state : '');
  drawing.strokeText(line, middle, 66);
  drawing.fillStyle = '#ffffff';
  drawing.fillText(line, middle, 66);
  drawing.globalAlpha = 1;
}

function fillFollowList() {
  followSelect.innerHTML = '';
  const add = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; followSelect.appendChild(o); };
  add('none', 'Whole map');
  add('egg', 'The egg');
  const players = (replay.info.players || []).filter(p => p.id !== undefined);
  players.sort((a, b) => (replay.team[a.id] + a.name).localeCompare(replay.team[b.id] + b.name));
  for (const p of players) add(String(p.id), p.name + ' (' + replay.team[p.id] + ')');
}

// click a player on the map to follow them; click empty ground to go back to the whole map
mapCanvas.addEventListener('click', event => {
  if (!replay) return;
  const rect = mapCanvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const worldX = ((event.clientX - rect.left) * ratio - view.offsetX) / view.scale - ENTITY_OFFSET;
  const worldY = ((event.clientY - rect.top) * ratio - view.offsetY) / view.scale - ENTITY_OFFSET;
  let best = null, bestDistance = 1.2 * PIXELS_PER_UNIT * 0.4;
  for (const p of replay.info.players || []) {
    if (p.id === undefined || !playerIsInGame(p, currentMs) || playerIsDead(p.id, currentMs)) continue;
    const at = playerPosition(p.id, currentMs);
    if (!at) continue;
    const distance = Math.hypot(at[0] * PIXELS_PER_UNIT - worldX, at[1] * PIXELS_PER_UNIT - worldY);
    if (distance < bestDistance) { best = p.id; bestDistance = distance; }
  }
  followSelect.value = best === null ? 'none' : String(best);
  draw();
});
followSelect.addEventListener('change', draw);
zoomSelect.addEventListener('change', draw);
window.addEventListener('resize', draw);

// The game's own name style (veryPrettyText in the client): bold Arial 11px, white, 2 px black outline, soft black
// shadow, left edge 16 px right of the ball's centre and its top 37 px above it. Those numbers are for the game's
// 100 pixels per unit, so they are halved here. The text is not allowed to get smaller than 8 px on screen.
function drawName(label, px, py) {
  const half = PIXELS_PER_UNIT / 100;
  const fontSize = Math.max(11 * half, 8 / view.scale);
  drawing.font = 'bold ' + fontSize + 'px Arial';
  drawing.textAlign = 'left';
  drawing.textBaseline = 'top';
  drawing.lineJoin = 'round';
  drawing.lineWidth = 2 * half * fontSize / (11 * half);
  drawing.strokeStyle = '#000000';
  drawing.fillStyle = '#ffffff';
  const x = px + 16 * half, y = py - 37 * half;
  drawing.save();
  drawing.shadowColor = 'rgba(0, 0, 0, 0.8)';
  drawing.shadowBlur = 3 * view.scale * fontSize / (11 * half);
  drawing.strokeText(label, x, y);
  drawing.restore();
  drawing.strokeText(label, x, y);
  drawing.fillText(label, x, y);
}

// the egg texture, centred on a point (carried by a player, or loose)
function drawEgg(px, py) {
  if (imageReady(eggImage)) {
    // the sprite is made for 100 pixels per unit; this viewer draws 50
    const scale = PIXELS_PER_UNIT / 100;
    const width = eggImage.naturalWidth * scale, height = eggImage.naturalHeight * scale;
    drawing.drawImage(eggImage, px - width / 2, py - height / 2, width, height);
  } else {
    drawing.fillStyle = '#ffd400';
    drawing.beginPath();
    drawing.arc(px, py, EGG_RADIUS_UNITS * PIXELS_PER_UNIT + 2, 0, Math.PI * 2);
    drawing.fill();
  }
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  return Math.floor(totalSeconds / 60) + ':' + String(totalSeconds % 60).padStart(2, '0');
}

// ---------- playback ----------

function animate(clock) {
  if (playing) {
    if (lastFrameClock !== null) {
      currentMs += (clock - lastFrameClock) * parseFloat(speedSelect.value);
      if (currentMs >= replay.lastMs) { currentMs = replay.lastMs; setPlaying(false); }
    }
    lastFrameClock = clock;
    draw();
  }
  requestAnimationFrame(animate);
}

function setPlaying(value) {
  playing = value;
  lastFrameClock = null;
  playPauseButton.textContent = playing ? 'Pause' : 'Play';
}

function seekTo(ms) {
  if (!replay) return;
  currentMs = Math.max(0, Math.min(replay.lastMs, ms));
  draw();
}

function loadReplayText(text, label) {
  replay = parseReplay(text);
  fillFollowList();
  timeSlider.max = replay.lastMs;
  const players = (replay.info.players || []).length;
  statusLine.textContent = 'Loaded ' + label + ': map ' + replay.info.map + ', length ' + formatTime(replay.lastMs) +
    ', ' + players + ' players, final score red ' + replay.info.score.red + ' blue ' + replay.info.score.blue + '.';
  setPlaying(false);
  seekTo(0);
}

async function loadArchiveGame(id) {
  statusLine.textContent = 'Loading ' + id + ' ...';
  if (!/^[0-9a-f]{24}$/.test(id)) { statusLine.textContent = 'That is not a game id.'; return; }
  let response;
  try {
    response = await fetch(serverAddress + '/replay/' + id);
  } catch (error) {
    statusLine.textContent = 'The replay server is not answering (the computer may be off). Try again later.';
    return;
  }
  if (!response.ok) { statusLine.textContent = 'No replay with id ' + id; return; }
  const text = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
  loadReplayText(text, id);
}

async function loadFile(file) {
  statusLine.textContent = 'Reading ' + file.name + ' ...';
  let stream = file.stream();
  const bytes = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) stream = stream.pipeThrough(new DecompressionStream('gzip'));
  loadReplayText(await new Response(stream).text(), file.name);
}

function parseJumpTime(text) {
  text = text.trim();
  if (text.includes(':')) {
    const [minutes, seconds] = text.split(':');
    return (parseInt(minutes, 10) * 60 + parseFloat(seconds)) * 1000;
  }
  return parseFloat(text) * 1000;
}

// ---------- page wiring ----------

playPauseButton.addEventListener('click', () => {
  if (!replay) return;
  if (!playing && currentMs >= replay.lastMs) currentMs = 0;
  setPlaying(!playing);
});
timeSlider.addEventListener('input', () => seekTo(parseFloat(timeSlider.value)));
document.getElementById('back-five-button').addEventListener('click', () => seekTo(currentMs - 5000));
document.getElementById('forward-five-button').addEventListener('click', () => seekTo(currentMs + 5000));
document.getElementById('jump-button').addEventListener('click', () => {
  const ms = parseJumpTime(document.getElementById('jump-time-input').value);
  if (!Number.isNaN(ms)) seekTo(ms);
});
showNamesCheckbox.addEventListener('change', draw);
showTrailsCheckbox.addEventListener('change', draw);
document.getElementById('load-game-button').addEventListener('click', () => {
  const id = document.getElementById('game-select').value;
  if (id) loadArchiveGame(id);
});
document.getElementById('load-id-button').addEventListener('click', () => {
  const id = document.getElementById('game-id-input').value.trim();
  if (id) loadArchiveGame(id);
});
document.getElementById('replay-file-input').addEventListener('change', event => {
  if (event.target.files.length) loadFile(event.target.files[0]);
});
document.addEventListener('keydown', event => {
  if (event.target.tagName === 'INPUT' && event.target.type === 'text') return;
  const key = event.key.toLowerCase();
  if (key === 'e') { followSelect.value = 'egg'; draw(); }
  if (key === 'f') { followSelect.value = 'none'; draw(); }
  if (key === '+' || key === '=') { zoomSelect.selectedIndex = Math.max(0, zoomSelect.selectedIndex - 1); draw(); }
  if (key === '-' || key === '_') { zoomSelect.selectedIndex = Math.min(zoomSelect.options.length - 1, zoomSelect.selectedIndex + 1); draw(); }
  if (event.key === ' ') { event.preventDefault(); playPauseButton.click(); }
  if (event.key === 'ArrowLeft') seekTo(currentMs - 5000);
  if (event.key === 'ArrowRight') seekTo(currentMs + 5000);
});

async function fillGameList() {
  statusLine.textContent = 'Finding the replay server ...';
  try {
    serverAddress = await findServer();
  } catch (error) {
    statusLine.textContent = 'Could not find the replay server (' + error.message + '). The computer may be off.';
    return;
  }
  let games;
  try {
    games = await (await fetch(serverAddress + '/api/games')).json();
  } catch (error) {
    statusLine.textContent = 'The replay server is not answering (the computer may be off). Try again later.';
    return;
  }
  const select = document.getElementById('game-select');
  for (const game of games) {
    const option = document.createElement('option');
    option.value = game.id;
    const when = new Date(game.at).toISOString().slice(0, 16).replace('T', ' ');
    option.textContent = when + ' | ' + game.map + ' | red ' + game.score.red + ' - ' + game.score.blue + ' blue | ' + game.players.slice(0, 4).join(', ') + ' ...';
    select.appendChild(option);
  }
  statusLine.textContent = games.length + ' games available.';
  applyLinkSettings(games);
}

// ---------- links to a game and a moment ----------
// ?game=<id>        which game
// &t=68.2           seconds into the replay (also 1:08.2)
// &follow=egg       egg, none (whole map), or a player's name
// &zoom=1           1 is the game's view, 2 is twice as far out, 0.5 twice as close
// &speed=1          0.25 .. 8
// &play=1           start playing instead of waiting paused

async function applyLinkSettings(games) {
  const params = new URLSearchParams(location.search);
  if (params.get('speed')) speedSelect.value = params.get('speed');
  if (params.get('zoom')) {
    const wantedZoom = parseFloat(params.get('zoom'));
    let nearest = 0;
    for (let i = 0; i < zoomSelect.options.length; i++) {
      if (Math.abs(parseFloat(zoomSelect.options[i].value) - wantedZoom) < Math.abs(parseFloat(zoomSelect.options[nearest].value) - wantedZoom)) nearest = i;
    }
    zoomSelect.selectedIndex = nearest;
  }
  const wanted = params.get('game');
  if (!wanted) return;
  document.getElementById('game-select').value = wanted;
  await loadArchiveGame(wanted);
  if (!replay) return;
  const follow = params.get('follow');
  if (follow) {
    const wantedName = follow.toLowerCase();
    for (const option of followSelect.options) {
      if (option.value === follow || option.textContent.toLowerCase().startsWith(wantedName + ' (')) followSelect.value = option.value;
    }
  }
  if (params.get('t')) {
    const ms = parseJumpTime(params.get('t'));
    if (!Number.isNaN(ms)) seekTo(ms);
  }
  if (params.get('play') === '1') setPlaying(true);
}

// builds a link that opens this game at this moment (always on the full field view, so no follow or zoom in it)
function linkToThisMoment() {
  const params = new URLSearchParams();
  params.set('game', replay.info.id);
  params.set('t', (currentMs / 1000).toFixed(1));
  return location.origin + location.pathname + '?' + params.toString();
}

document.getElementById('make-link-button').addEventListener('click', () => {
  if (!replay) return;
  const box = document.getElementById('link-text-box');
  box.value = linkToThisMoment();
  box.select();
  if (navigator.clipboard) navigator.clipboard.writeText(box.value).catch(() => {});
});

fillGameList();
requestAnimationFrame(animate);
