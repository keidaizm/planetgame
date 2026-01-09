import { Engine, Render, Runner, Bodies, Composite, Events, Vector } from 'matter-js';

// --- Constants & Config ---
const DEADLINE_RATIO = 0.18;
const DEADLINE_THRESHOLD_MS = 1500; // Slightly stricter
const DROP_COOLDOWN_MS = 400;
const MERGE_FLASH_DURATION = 100;
const SCORE_POP_DURATION = 600;
const BLACK_HOLE_DURATION = 900;
const BLACK_HOLE_BONUS = 5000;
const SE_GLOBAL_COOLDOWN_MS = 80;
const SE_DROP_THRESHOLD = 0.5;

// Physics Tunings
const PLANET_FRICTION = 0.8;
const PLANET_FRICTION_STATIC = 1.0;
const PLANET_FRICTION_AIR = 0.05;
const WALL_FRICTION = 0.5;

interface PlanetDef {
  level: number;
  name: string;
  radius: number;
  mass: number;
  score: number;
  color: string;
}

const PLANETS: Record<number, PlanetDef> = {
  1: { level: 1, name: '冥王星', radius: 21, mass: 1.0, score: 10, color: '#95a5a6' },
  2: { level: 2, name: '月', radius: 26, mass: 1.2, score: 20, color: '#f1c40f' },
  3: { level: 3, name: '水星', radius: 31, mass: 1.5, score: 40, color: '#e67e22' },
  4: { level: 4, name: '火星', radius: 39, mass: 1.9, score: 80, color: '#e74c3c' },
  5: { level: 5, name: '金星', radius: 48, mass: 2.4, score: 160, color: '#f39c12' },
  6: { level: 6, name: '地球', radius: 59, mass: 3.0, score: 320, color: '#3498db' },
  7: { level: 7, name: '天王星', radius: 70, mass: 3.7, score: 640, color: '#1abc9c' },
  8: { level: 8, name: '海王星', radius: 84, mass: 4.5, score: 1280, color: '#2980b9' },
  9: { level: 9, name: '土星', radius: 99, mass: 5.5, score: 2560, color: '#d35400' },
  10: { level: 10, name: '木星', radius: 118, mass: 6.8, score: 5120, color: '#c0392b' },
  11: { level: 11, name: '太陽', radius: 140, mass: 8.5, score: 10240, color: '#ff4500' },
};

const PLANET_IMAGE_URLS: Record<number, string> = {
  1: new URL('../image/1_冥王星.png', import.meta.url).href,
  2: new URL('../image/2_月.png', import.meta.url).href,
  3: new URL('../image/3_水星.png', import.meta.url).href,
  4: new URL('../image/4_火星.png', import.meta.url).href,
  5: new URL('../image/5_金星.png', import.meta.url).href,
  6: new URL('../image/6_地球.png', import.meta.url).href,
  7: new URL('../image/7_天王星.png', import.meta.url).href,
  8: new URL('../image/8_海王星.png', import.meta.url).href,
  9: new URL('../image/9_土星.png', import.meta.url).href,
  10: new URL('../image/10_木星.png', import.meta.url).href,
  11: new URL('../image/11_太陽.png', import.meta.url).href,
};

const PLANET_IMAGE_SCALES: Record<number, number> = {
  6: 1.12, // Earth
  7: 1.2, // Uranus
  9: 1.6, // Saturn
  11: 1.2, // Sun
};
const PLANET_IMAGE_OVERFLOW_LEVELS = new Set([6, 7, 9, 11]);
const PLANET_IMAGE_PRESERVE_ASPECT_LEVELS = new Set([7, 9]);

const NEXT_CANDIDATES = [1, 2, 3, 4, 5];
const NEXT_WEIGHTS: Record<number, number> = { 1: 6, 2: 6, 3: 5, 4: 4, 5: 3 };

// --- Types ---
interface Flash {
  x: number;
  y: number;
  startTime: number;
}

interface ScorePop {
  x: number;
  y: number;
  score: number;
  startTime: number;
}

interface BlackHoleEffect {
  x: number;
  y: number;
  startTime: number;
}

// --- State Variables ---
let engine: Engine;
let render: Render;
let runner: Runner;
let ground: any;
let leftWall: any;
let rightWall: any;

let score = 0;
let hiScore = parseInt(localStorage.getItem('hiScore') || '0');
// Start with no discoveries; first appeared planet gets discovered
let discoveredLevels = new Set<number>();

let currentLevel = 1;
let nextLevel = 1;
let dropX = 0;
let isCoolingDown = false;
let isGameOver = false;
let deadLineViolatedStartTime: number | null = null;

let flashes: Flash[] = [];
let scorePops: ScorePop[] = [];
let blackHoleEffects: BlackHoleEffect[] = [];
let mergeLockedBodies = new Set<number>();
let lastSeTime = 0;
let bgm: HTMLAudioElement | null = null;
const planetImages: Record<number, HTMLImageElement> = {};
let gameOverOverlay: HTMLElement | null = null;

// Bag for weighted random
class PlanetBag {
  items: number[] = [];
  lastItem: number | null = null;
  constructor() { this.refill(); }
  reset() {
    this.lastItem = null;
    this.refill();
  }
  refill() {
    this.items = [];
    for (const lv of NEXT_CANDIDATES) {
      const count = NEXT_WEIGHTS[lv];
      for (let i = 0; i < count; i++) this.items.push(lv);
    }
    this.shuffle();
  }
  shuffle() {
    for (let i = this.items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    }
  }
  pull(): number {
    if (this.items.length === 0) this.refill();
    let index = 0;
    if (this.items.length > 1 && this.items[0] === this.lastItem) index = 1;
    const val = this.items.splice(index, 1)[0];
    this.lastItem = val;
    return val;
  }
}
const planetBag = new PlanetBag();

// --- Audio ---
let audioCtx: AudioContext | null = null;
function initAudio() {
  if (audioCtx) {
    // Resume AudioContext if suspended (important for mobile/tablet)
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().then(() => console.log('[Audio] AudioContext resumed'));
    }
    return;
  }
  audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  console.log('[Audio] AudioContext created, state:', audioCtx.state);

  // Initialize and play BGM
  if (!bgm) {
    console.log('[BGM] Initializing BGM...');
    bgm = new Audio('/bgm/puzzle-game.mp3');
    bgm.loop = true;
    bgm.volume = 0.3;

    // Add event listeners for debugging
    bgm.addEventListener('canplaythrough', () => {
      console.log('[BGM] Can play through - ready to play');
    });
    bgm.addEventListener('error', (e) => {
      console.error('[BGM] Error loading BGM:', e);
      if (bgm) console.error('[BGM] Error details:', bgm.error);
    });
    bgm.addEventListener('play', () => {
      console.log('[BGM] Started playing');
    });
    bgm.addEventListener('pause', () => {
      console.log('[BGM] Paused');
    });

    bgm.addEventListener('ended', () => {
      console.log('[BGM] Ended (should loop)');
    });

    // Try to play immediately
    const playPromise = bgm.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => console.log('[BGM] Play promise resolved successfully'))
        .catch(err => {
          console.error('[BGM] Play failed:', err);
          console.error('[BGM] Error name:', err.name);
          console.error('[BGM] Error message:', err.message);
          // Retry on next user interaction
          document.addEventListener('click', () => {
            if (bgm && bgm.paused) {
              console.log('[BGM] Retrying play on user click...');
              bgm.play().catch(e => console.error('[BGM] Retry failed:', e));
            }
          }, { once: true });
        });
    }
  }
}
function playSe(freq: number, type: OscillatorType, volume: number) {
  if (!audioCtx || audioCtx.state === 'suspended') return;
  const now = performance.now();
  if (now - lastSeTime < SE_GLOBAL_COOLDOWN_MS) return;
  lastSeTime = now;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  gain.gain.setValueAtTime(volume * 0.2, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.3);
}

// --- Shared Rendering ---
function drawPlanet(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, level: number, angle: number = 0) {
  const def = PLANETS[level];
  if (!def) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  // Gradient based on level
  const grad = ctx.createRadialGradient(-r / 3, -r / 3, r / 10, 0, 0, r);
  grad.addColorStop(0, '#fff');
  grad.addColorStop(0.2, def.color);
  grad.addColorStop(1, '#000');

  // Sun special aura
  if (level === 11) {
    const aura = ctx.createRadialGradient(0, 0, r, 0, 0, r * 1.5);
    aura.addColorStop(0, 'rgba(255, 69, 0, 0.4)');
    aura.addColorStop(1, 'rgba(255, 69, 0, 0)');
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = aura;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  const img = planetImages[level];
  if (img && img.complete && img.naturalWidth > 0) {
    const scale = PLANET_IMAGE_SCALES[level] ?? 1;
    const size = r * 2 * scale;
    let drawW = size;
    let drawH = size;
    if (PLANET_IMAGE_PRESERVE_ASPECT_LEVELS.has(level)) {
      const aspect = img.naturalWidth / img.naturalHeight;
      if (aspect >= 1) {
        drawW = size;
        drawH = size / aspect;
      } else {
        drawH = size;
        drawW = size * aspect;
      }
    }
    const offsetX = -drawW / 2;
    const offsetY = -drawH / 2;
    ctx.save();
    if (!PLANET_IMAGE_OVERFLOW_LEVELS.has(level)) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.clip();
    }
    ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
    ctx.restore();
  }

  // Spots
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  for (let i = 0; i < 5; i++) {
    const spotAngle = i * (Math.PI * 2 / 5);
    const spotDist = r * 0.4;
    ctx.beginPath();
    ctx.arc(Math.cos(spotAngle) * spotDist, Math.sin(spotAngle) * spotDist, r * 0.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// --- Initialization ---
function init() {
  initPlanetImages();
  const container = document.getElementById('game-container')!;
  gameOverOverlay = document.getElementById('gameover-overlay');
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const width = container.clientWidth;
  const height = container.clientHeight;
  dropX = width / 2;

  engine = Engine.create();
  render = Render.create({
    canvas: canvas,
    engine: engine,
    options: { width, height, wireframes: false, background: 'transparent' }
  });

  rebuildBounds(width, height);

  Render.run(render);
  runner = Runner.create();
  Runner.run(runner, engine);

  nextLevel = planetBag.pull();
  currentLevel = planetBag.pull();
  updateHUD();
  initEvolutionUI();

  Events.on(engine, 'collisionStart', (event) => {
    event.pairs.forEach(pair => {
      const bodyA = pair.bodyA as any;
      const bodyB = pair.bodyB as any;
      if (bodyA.isStatic || bodyB.isStatic) {
        const planet = bodyA.plugin.planet ? bodyA : (bodyB.plugin.planet ? bodyB : null);
        if (planet && !planet.plugin.dropSePlayed) {
          const relVel = Vector.magnitude(Vector.sub(bodyA.velocity, bodyB.velocity));
          if (relVel > SE_DROP_THRESHOLD) {
            playSe(100 + planet.plugin.planet.level * 20, 'square', Math.min(relVel / 10, 1));
            planet.plugin.dropSePlayed = true;
          }
        }
      }
      if (bodyA.plugin.planet && bodyB.plugin.planet) {
        if (bodyA.plugin.planet.level === 11 && bodyB.plugin.planet.level === 11) {
          if (!mergeLockedBodies.has(bodyA.id) && !mergeLockedBodies.has(bodyB.id)) {
            mergeLockedBodies.add(bodyA.id);
            mergeLockedBodies.add(bodyB.id);
            triggerBlackHole((bodyA.position.x + bodyB.position.x) / 2, (bodyA.position.y + bodyB.position.y) / 2);
          }
        } else if (bodyA.plugin.planet.level === bodyB.plugin.planet.level && bodyA.plugin.planet.level < 11) {
          if (!mergeLockedBodies.has(bodyA.id) && !mergeLockedBodies.has(bodyB.id)) {
            mergeLockedBodies.add(bodyA.id);
            mergeLockedBodies.add(bodyB.id);
            handleMerge(bodyA, bodyB);
          }
        }
      }
    });
  });

  Events.on(engine, 'afterUpdate', () => {
    mergeLockedBodies.clear();
    checkDeadline();
  });

  Events.on(render, 'afterRender', () => {
    const ctx = render.context;
    const now = performance.now();
    const bodies = Composite.allBodies(engine.world);
    for (const body of bodies) {
      if (body.plugin.planet) {
        drawPlanet(ctx, body.position.x, body.position.y, body.circleRadius!, body.plugin.planet.level, body.angle);
      }
    }
    if (!isGameOver && !isCoolingDown) {
      ctx.beginPath(); ctx.setLineDash([5, 5]); ctx.moveTo(dropX, 0); ctx.lineTo(dropX, height);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'; ctx.stroke(); ctx.setLineDash([]);
      drawPlanet(ctx, dropX, 50, PLANETS[currentLevel].radius, currentLevel);
    }
    const deadlineY = height * DEADLINE_RATIO;
    ctx.beginPath(); ctx.moveTo(0, deadlineY); ctx.lineTo(width, deadlineY);
    ctx.strokeStyle = deadLineViolatedStartTime ? '#ff4757' : 'rgba(255, 71, 87, 0.3)';
    ctx.lineWidth = 2; ctx.stroke();
    flashes = flashes.filter(f => {
      const elapsed = now - f.startTime;
      if (elapsed > MERGE_FLASH_DURATION) return false;
      const alpha = 1 - (elapsed / MERGE_FLASH_DURATION);
      ctx.beginPath(); ctx.arc(f.x, f.y, 40, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`; ctx.lineWidth = 4; ctx.stroke();
      return true;
    });
    scorePops = scorePops.filter(p => {
      const elapsed = now - p.startTime;
      if (elapsed > SCORE_POP_DURATION) return false;
      const alpha = 1 - (elapsed / SCORE_POP_DURATION);
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`; ctx.font = 'bold 20px sans-serif';
      ctx.textAlign = 'center'; ctx.fillText(`+${p.score}`, p.x, p.y - (elapsed / SCORE_POP_DURATION) * 50);
      return true;
    });
    blackHoleEffects = blackHoleEffects.filter(e => {
      const elapsed = now - e.startTime;
      if (elapsed > BLACK_HOLE_DURATION) return false;
      const t = elapsed / BLACK_HOLE_DURATION;
      const maxR = 220;
      const r = 40 + maxR * t;
      const alpha = 0.9 * (1 - t);
      ctx.save();
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(e.x, e.y, r * 0.6, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 * (1 - t)})`;
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.restore();
      return true;
    });
    if (isGameOver) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(0, 0, width, height);
    }
  });

  container.addEventListener('pointerdown', (e) => {
    if (isGameOver) { resetGame(); return; }
    initAudio();
    const rect = container.getBoundingClientRect();
    updateDropX(e.clientX - rect.left);
  });
  container.addEventListener('pointermove', (e) => {
    if (isGameOver) return;
    const rect = container.getBoundingClientRect();
    updateDropX(e.clientX - rect.left);
  });
  container.addEventListener('pointerup', (e) => {
    if (isGameOver || isCoolingDown) return;
    const rect = container.getBoundingClientRect();
    updateDropX(e.clientX - rect.left);
    dropPlanet();
  });

  window.addEventListener('resize', handleResize);

  updateHUD();
  drawNextPreview();
}

function initPlanetImages() {
  for (let i = 1; i <= 11; i++) {
    const img = new Image();
    img.src = PLANET_IMAGE_URLS[i];
    img.onload = () => {
      updateEvolutionUI();
      drawNextPreview();
    };
    planetImages[i] = img;
  }
}

function setGameOver(value: boolean) {
  isGameOver = value;
  if (gameOverOverlay) {
    gameOverOverlay.classList.toggle('active', value);
  }
}

function handleResize() {
  const container = document.getElementById('game-container')!;
  const width = container.clientWidth;
  const height = container.clientHeight;
  render.canvas.width = width;
  render.canvas.height = height;
  render.options.width = width;
  render.options.height = height;
  rebuildBounds(width, height);
  updateDropX(dropX);
}

function rebuildBounds(width: number, height: number) {
  if (ground || leftWall || rightWall) {
    Composite.remove(engine.world, [ground, leftWall, rightWall].filter(Boolean));
  }
  const wallOptions = {
    isStatic: true, restitution: 0.1, friction: WALL_FRICTION,
    render: { fillStyle: '#2c3e50' }
  };
  ground = Bodies.rectangle(width / 2, height + 30, width, 60, wallOptions);
  leftWall = Bodies.rectangle(-30, height / 2, 60, height, wallOptions);
  rightWall = Bodies.rectangle(width + 30, height / 2, 60, height, wallOptions);
  Composite.add(engine.world, [ground, leftWall, rightWall]);
}

function updateDropX(x: number) {
  const container = document.getElementById('game-container')!;
  const def = PLANETS[currentLevel];
  dropX = Math.max(def.radius + 5, Math.min(container.clientWidth - def.radius - 5, x));
}

function dropPlanet() {
  const def = PLANETS[currentLevel];

  // Discover on drop
  if (!discoveredLevels.has(currentLevel)) {
    discoveredLevels.add(currentLevel);
    localStorage.setItem('discoveredLevels', JSON.stringify([...discoveredLevels]));
    updateEvolutionUI();
  }

  const planet = Bodies.circle(dropX, 50, def.radius, {
    restitution: 0.1, friction: PLANET_FRICTION, frictionStatic: PLANET_FRICTION_STATIC, frictionAir: PLANET_FRICTION_AIR,
    render: { visible: false },
    plugin: { planet: { level: def.level }, dropSePlayed: false }
  });
  Composite.add(engine.world, [planet]);
  currentLevel = nextLevel; nextLevel = planetBag.pull();
  updateHUD(); drawNextPreview();
  isCoolingDown = true;
  setTimeout(() => isCoolingDown = false, DROP_COOLDOWN_MS);
}

function handleMerge(bodyA: any, bodyB: any) {
  const lv = bodyA.plugin.planet.level;
  const newLv = lv + 1;
  const x = (bodyA.position.x + bodyB.position.x) / 2;
  const y = (bodyA.position.y + bodyB.position.y) / 2;
  Composite.remove(engine.world, [bodyA, bodyB]);
  const def = PLANETS[newLv];
  const newPlanet = Bodies.circle(x, y, def.radius, {
    restitution: 0.1, friction: PLANET_FRICTION, frictionStatic: PLANET_FRICTION_STATIC, frictionAir: PLANET_FRICTION_AIR,
    render: { visible: false },
    plugin: { planet: { level: def.level }, dropSePlayed: true }
  });
  Composite.add(engine.world, [newPlanet]);

  if (!discoveredLevels.has(newLv)) {
    discoveredLevels.add(newLv);
    localStorage.setItem('discoveredLevels', JSON.stringify([...discoveredLevels]));
    updateEvolutionUI();
  }
  score += def.score;
  if (score > hiScore) { hiScore = score; localStorage.setItem('hiScore', hiScore.toString()); }
  updateHUD();
  flashes.push({ x, y, startTime: performance.now() });
  scorePops.push({ x, y, score: def.score, startTime: performance.now() });
  playSe(200 + newLv * 100, 'sine', 0.5);
}

function triggerBlackHole(x: number, y: number) {
  const bodies = Composite.allBodies(engine.world);
  const planets = bodies.filter(b => !b.isStatic && b.plugin.planet);
  Composite.remove(engine.world, planets);

  score += BLACK_HOLE_BONUS;
  if (score > hiScore) { hiScore = score; localStorage.setItem('hiScore', hiScore.toString()); }
  updateHUD();

  blackHoleEffects.push({ x, y, startTime: performance.now() });
  scorePops.push({ x, y, score: BLACK_HOLE_BONUS, startTime: performance.now() });
  playSe(60, 'sine', 0.7);
}

function checkDeadline() {
  if (isGameOver) return;
  const h = (render.options as any).height;
  const dy = h * DEADLINE_RATIO;
  const bodies = Composite.allBodies(engine.world);
  let violation = false;
  for (const b of bodies) {
    if (!b.isStatic && b.plugin.planet && b.position.y - b.circleRadius! < dy && b.position.y > 120) {
      violation = true; break;
    }
  }
  if (violation) {
    if (!deadLineViolatedStartTime) deadLineViolatedStartTime = performance.now();
    else if (performance.now() - deadLineViolatedStartTime > DEADLINE_THRESHOLD_MS) setGameOver(true);
  } else deadLineViolatedStartTime = null;
}

function resetGame() {
  const bodies = Composite.allBodies(engine.world);
  Composite.remove(engine.world, bodies.filter(b => !b.isStatic));
  score = 0; deadLineViolatedStartTime = null;
  setGameOver(false);
  blackHoleEffects = [];
  planetBag.reset();
  nextLevel = planetBag.pull();
  currentLevel = planetBag.pull();

  // Reset Discovery Progress (each game session starts fresh)
  discoveredLevels = new Set<number>();
  localStorage.setItem('discoveredLevels', JSON.stringify([...discoveredLevels]));
  updateEvolutionUI();

  updateHUD(); drawNextPreview();
}

function updateHUD() {
  document.getElementById('score')!.innerText = score.toString();
  document.getElementById('hi-score')!.innerText = hiScore.toString();
  document.getElementById('next-name')!.innerText = PLANETS[nextLevel].name;
}

function drawNextPreview() {
  const canvas = document.getElementById('next-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const def = PLANETS[nextLevel];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawPlanet(ctx, canvas.width / 2, canvas.height / 2, Math.min(def.radius, 40), nextLevel);
}

function initEvolutionUI() {
  const ui = document.getElementById('evolution-ui')!;
  ui.innerHTML = '';
  for (let i = 1; i <= 11; i++) {
    const div = document.createElement('div');
    div.className = 'evo-item';
    div.id = `evo-${i}`;
    const canvas = document.createElement('canvas');
    canvas.width = 60; canvas.height = 60;
    const span = document.createElement('span');
    span.className = 'evo-name';
    span.innerText = PLANETS[i].name;
    div.appendChild(canvas);
    div.appendChild(span);
    ui.appendChild(div);
  }
  updateEvolutionUI();
}

function updateEvolutionUI() {
  for (let i = 1; i <= 11; i++) {
    const div = document.getElementById(`evo-${i}`)!;
    const nameSpan = div.querySelector('.evo-name') as HTMLElement;
    if (discoveredLevels.has(i)) {
      div.classList.remove('locked');
      nameSpan.style.visibility = 'visible';
    } else {
      div.classList.add('locked');
      nameSpan.style.visibility = 'hidden';
    }
    const canvas = div.querySelector('canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawPlanet(ctx, 30, 30, 25, i);
  }
}

window.onload = init;
