// ===== 微信小游戏：暗夜突围 NightBreak =====
// 全部 UI 在 Canvas 上绘制，无任何 DOM 依赖
// 操作：左下方固定虚拟摇杆移动，右下方技能按钮释放技能

// ========== 画布与屏幕 ==========
const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');
const sys = wx.getSystemInfoSync();
const W = sys.screenWidth;
const H = sys.screenHeight;
const DPR = Math.min(sys.pixelRatio || 1, 2);
canvas.width = W * DPR;
canvas.height = H * DPR;
ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
const TAU = Math.PI * 2;

// 安全区适配（避开刘海/圆角/Home指示条）
const _safe = sys.safeArea || { left: 0, top: 0, right: W, bottom: H };
const SAFE_L = _safe.left || 0;
const SAFE_T = _safe.top || 0;
const SAFE_R = W - (_safe.right || W);
const SAFE_B = H - (_safe.bottom || H);
// 是否横屏
const IS_LANDSCAPE = W >= H;
// 底部 UI 预留（摇杆+技能按钮区域），横屏小屏减小
const BOTTOM_RESERVE = Math.max(110, H * 0.26);

// ========== 大地图（面积约为屏幕 9 倍）==========
const MAP_W = W * 3;
const MAP_H = H * 3;

// 获取胶囊按钮位置，避免 UI 重叠
let _menuBtn = { bottom: 48 };
try { const r = wx.getMenuButtonBoundingClientRect(); if (r && r.bottom) _menuBtn = r; } catch (e) {}
const HUD_TOP = _menuBtn.bottom + 6;

// ========== 工具函数 ==========
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
let _filterOK = false;
try { ctx.filter = 'none'; _filterOK = true; } catch (e) {}

function lighten(hex, amt) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return hex;
  return '#' + [r, g, b].map(v => Math.min(255, Math.max(0, Math.round(v + (255 - v) * amt))).toString(16).padStart(2, '0')).join('');
}
function blendColor(a, b, t) {
  const p = h => { const s = h.replace('#', ''); return [parseInt(s.substr(0, 2), 16), parseInt(s.substr(2, 2), 16), parseInt(s.substr(4, 2), 16)]; };
  const [ar, ag, ab] = p(a), [br, bg, bb] = p(b);
  if (isNaN(ar) || isNaN(ag) || isNaN(ab) || isNaN(br) || isNaN(bg) || isNaN(bb)) return a;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return '#' + [r, g, bl].map(v => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')).join('');
}
function hexA(hex, a) {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.substr(0, 2), 16)},${parseInt(h.substr(2, 2), 16)},${parseInt(h.substr(4, 2), 16)},${a})`;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
function ptInRect(px, py, rx, ry, rw, rh) {
  if (ry == null || rh == null || rw == null || rx == null) return false;
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}
function ptInCircle(px, py, cx, cy, r) {
  return dist2(px, py, cx, cy) < r * r;
}

// ========== 音效系统（WebAudio 合成） ==========
const Audio = {
  actx: null, enabled: true,
  init() {
    try { if (wx.createWebAudioContext) this.actx = wx.createWebAudioContext(); }
    catch (e) { this.enabled = false; }
  },
  resume() { if (this.actx && this.actx.state === 'suspended') this.actx.resume(); },
  tone(freq, dur, type = 'sine', vol = 0.12, slide = 0) {
    if (!this.enabled || !this.actx) return;
    const t = this.actx.currentTime;
    const o = this.actx.createOscillator(), g = this.actx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(1, freq * slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.actx.destination);
    o.start(t); o.stop(t + dur);
  },
  noise(dur, vol = 0.1) {
    if (!this.enabled || !this.actx) return;
    const t = this.actx.currentTime;
    const buf = this.actx.createBuffer(1, Math.floor(this.actx.sampleRate * dur), this.actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    const s = this.actx.createBufferSource(); s.buffer = buf;
    const g = this.actx.createGain(); g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const f = this.actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2000;
    s.connect(f); f.connect(g); g.connect(this.actx.destination); s.start(t);
  },
  shoot() { this.tone(900, 0.04, 'square', 0.04, 0.5); },
  hit() { this.tone(180, 0.03, 'sawtooth', 0.05); },
  kill() { this.tone(520, 0.08, 'triangle', 0.07, 0.6); },
  combo(n) { this.tone(440 + Math.min(n, 15) * 40, 0.06, 'triangle', 0.06, 1.3); },
  pickup() { this.tone(660, 0.05, 'sine', 0.08, 1.4); },
  levelup() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.12, 'triangle', 0.1), i * 60)); },
  equip() { this.tone(330, 0.06, 'sine', 0.08); setTimeout(() => this.tone(550, 0.08, 'sine', 0.08), 60); },
  bossWarn() { [880, 440, 880, 440].forEach((f, i) => setTimeout(() => this.tone(f, 0.15, 'sawtooth', 0.12), i * 150)); },
  bossKill() { this.noise(0.5, 0.15); [220, 330, 440, 660].forEach((f, i) => setTimeout(() => this.tone(f, 0.2, 'triangle', 0.1, f * 1.5), i * 80)); },
  ult() { this.tone(80, 0.3, 'sawtooth', 0.12, 3); this.noise(0.3, 0.08); },
  hurt() { this.tone(120, 0.1, 'sawtooth', 0.1, 0.5); },
  frost() { this.tone(1200, 0.15, 'sine', 0.06, 0.5); },
  chain() { this.tone(800, 0.05, 'square', 0.05, 2); },
};
Audio.init();

// ========== 精灵图加载 ==========
const SPRITES = {};
const SPRITE_LIST = [
  ['player', 'assets/sprites/player_fighter.jpg'],
  ['boss', 'assets/sprites/boss_demon.jpg'],
  ['blob', 'assets/sprites/enemy_blob.jpg'],
  ['spike', 'assets/sprites/enemy_spike.jpg'],
  ['skull', 'assets/sprites/enemy_skull.jpg'],
  ['cube', 'assets/sprites/enemy_cube.jpg'],
  ['bg', 'assets/sprites/bg_space.jpg'],
  ['gem', 'assets/sprites/item_gem.jpg'],
  ['heart', 'assets/sprites/item_heart.jpg'],
  ['chest', 'assets/sprites/item_chest.jpg'],
  ['equip', 'assets/sprites/item_equip.jpg'],
  ['magnet', 'assets/sprites/item_magnet.jpg'],
  ['bomb', 'assets/sprites/item_bomb.jpg'],
];
let spritesReady = 0;
const spritesTotal = SPRITE_LIST.length;
// 把 JPG 白底抠除为透明，存到离屏 canvas（bg 背景图不抠）
function processSprite(key, img) {
  // 背景图保留原样（满屏铺底，不需要透明）
  if (key === 'bg') { SPRITES[key] = img; return; }
  const w = img.width, h = img.height;
  const c = wx.createCanvas(); c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  let data;
  try { data = cx.getImageData(0, 0, w, h); } catch (e) { SPRITES[key] = img; return; }
  const d = data.data;
  // 抠白：亮度高且饱和度低（接近白/浅灰）的像素变透明，用羽化避免锯齿
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx - mn;            // 饱和度
    const light = (mx + mn) / 2;    // 亮度
    if (light > 215 && sat < 28) {
      // 越白越透明，做羽化
      const t = (light - 215) / 40;
      d[i + 3] = Math.max(0, Math.round(d[i + 3] * (1 - Math.min(1, t))));
    }
  }
  cx.putImageData(data, 0, 0);
  SPRITES[key] = c;
}
function loadSprites(cb) {
  SPRITE_LIST.forEach(([key, src]) => {
    const img = wx.createImage();
    img.onload = () => { processSprite(key, img); spritesReady++; if (spritesReady === spritesTotal && cb) cb(); };
    img.onerror = () => { spritesReady++; if (spritesReady === spritesTotal && cb) cb(); };
    img.src = src;
  });
}

// ========== 视差星层 ==========
const starLayers = [];
function buildStarLayers() {
  starLayers.length = 0;
  for (let layer = 0; layer < 3; layer++) {
    const c = wx.createCanvas(); c.width = W; c.height = H;
    const x = c.getContext('2d');
    const count = [70, 50, 25][layer];
    const colors = ['rgba(180,200,230,', 'rgba(140,200,255,', 'rgba(200,220,255,'][layer];
    const sr = [[0.6, 1.2], [1.0, 1.8], [1.5, 2.6]][layer];
    for (let i = 0; i < count; i++) {
      const x2 = Math.random() * W, y2 = Math.random() * H;
      const r = sr[0] + Math.random() * (sr[1] - sr[0]);
      const a = 0.3 + Math.random() * 0.6;
      x.fillStyle = colors + a + ')';
      x.beginPath(); x.arc(x2, y2, r, 0, TAU); x.fill();
    }
    starLayers.push(c);
  }
}

// ========== 性能监控 ==========
let shadowEnabled = true, frameTimes = [], avgFps = 60;
function updatePerf(dt) {
  frameTimes.push(dt);
  if (frameTimes.length > 60) frameTimes.shift();
  if (frameTimes.length === 60) {
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    avgFps = 1 / avg;
    if (avgFps < 35) shadowEnabled = false;
    else if (avgFps > 50) shadowEnabled = true;
  }
}

// ========== 游戏常量 ==========
const RARITY = {
  common: { name: '普通', color: '#c8d0dc', weight: 50, mult: 1.0 },
  rare: { name: '稀有', color: '#4dd0ff', weight: 30, mult: 1.6 },
  epic: { name: '史诗', color: '#b066ff', weight: 15, mult: 2.2 },
  legend: { name: '传说', color: '#ffe27a', weight: 5, mult: 3.5 },
};
function pickRarity() { const r = Math.random() * 100; let acc = 0; for (const k of ['common', 'rare', 'epic', 'legend']) { acc += RARITY[k].weight; if (r < acc) return k; } return 'common'; }
function pickRarityBoss() { const r = Math.random() * 100; if (r < 30) return 'legend'; if (r < 70) return 'epic'; if (r < 90) return 'rare'; return 'common'; }

const STATE = { START: 0, PLAY: 1, LEVELUP: 2, OVER: 3, PAUSE: 4 };
let state = STATE.START;
const cam = { x: 0, y: 0, shake: 0, followX: 0, followY: 0 };
// 屏幕坐标 ↔ 世界坐标转换
function worldToScreenX(wx) { return wx - cam.followX; }
function worldToScreenY(wy) { return wy - cam.followY; }
function screenToWorldX(sx) { return sx + cam.followX; }
function screenToWorldY(sy) { return sy + cam.followY; }
let flashScreen = 0;

const player = {
  x: 0, y: 0, r: 16, hp: 100, maxHp: 100, speed: 180, level: 1, xp: 0, xpNext: 5, kills: 0,
  invuln: 0, pickupRange: 90, facing: -Math.PI / 2,
  regen: 0, damageReduction: 0, xpMult: 1,
};

const skills = {
  bullet: { name: '暗夜弹', icon: '✦', lvl: 1, dmg: 12, cd: 0.7, timer: 0, count: 1, pierce: 0, speed: 460, spread: 0.12, btnCd: 0, btnCdMax: 3.0 },
  orbit: { name: '护体光球', icon: '◉', lvl: 0, dmg: 8, count: 0, radius: 72, speed: 2.6, angle: 0, hitCd: {}, burstCd: 0, burstCdMax: 4.5 },
  aura: { name: '幽冥光环', icon: '◎', lvl: 0, dmg: 6, radius: 0, dps: 0, tick: 0, novaCd: 0, novaCdMax: 6.0 },
  chain: { name: '闪电链', icon: '⚡', lvl: 0, dmg: 18, cd: 2.2, timer: 0, targets: 3, bounce: 2 },
  frost: { name: '冰冻新星', icon: '❄', lvl: 0, dmg: 20, cd: 7.0, timer: 0, radius: 0, slowDur: 3 },
  laser: { name: '激光束', icon: '⟿', lvl: 0, dmg: 5, cd: 0, timer: 0, dps: 55, width: 10, angle: 0, sweep: 0.25, tickTimer: 0 },
  boomerang: { name: '回旋镖', icon: '✧', lvl: 0, dmg: 16, cd: 1.6, timer: 0, count: 1, pierce: 4, speed: 320 },
  ult: { name: '终极爆发', icon: '✺', lvl: 0, cdMax: 20, cd: 0, dmg: 60, radius: 160 },
};

// 装备系统
const EQUIP_SLOTS = ['weapon', 'armor', 'boots', 'amulet'];
const EQ_SLOT_NAME = { weapon: '武器', armor: '护甲', boots: '靴子', amulet: '护符' };
const EQ_SLOT_ICON = { weapon: '⚔', armor: '🛡', boots: '👟', amulet: '📿' };
const equipment = { weapon: null, armor: null, boots: null, amulet: null };
let eqDrops = [];
const EQ_STAT_POOL = {
  weapon: [['bulletDmg', 0.15, '弹幕伤害 +15%'], ['bulletCd', -0.10, '弹幕冷却 -10%'], ['allDmg', 0.10, '全技能伤害 +10%'], ['crit', 0.10, '暴击率 +10%']],
  armor: [['maxHp', 25, '最大生命 +25'], ['damageReduction', 0.06, '伤害减免 +6%'], ['regen', 1.2, '每秒回复 +1.2'], ['pickupRange', 0.20, '拾取范围 +20%']],
  boots: [['speed', 0.10, '移速 +10%'], ['pickupRange', 0.25, '拾取范围 +25%'], ['maxHp', 15, '最大生命 +15']],
  amulet: [['xpMult', 0.15, '经验获取 +15%'], ['allDmg', 0.08, '全技能伤害 +8%'], ['regen', 0.8, '每秒回复 +0.8'], ['bulletPierce', 1, '弹幕穿透 +1']],
};
function rollEquipment(slot, rarity) {
  const pool = EQ_STAT_POOL[slot]; const stats = {}; const picked = [];
  const statCount = rarity === 'legend' ? 4 : rarity === 'epic' ? 3 : rarity === 'rare' ? 2 : 1;
  while (picked.length < statCount && picked.length < pool.length) {
    const i = randi(0, pool.length - 1); if (picked.includes(i)) continue;
    picked.push(i); const [key, val] = pool[i];
    stats[key] = (stats[key] || 0) + val * RARITY[rarity].mult;
  }
  return { slot, rarity, stats };
}
function applyEquipStats() {
  player.maxHp = 100; player.speed = 180; player.pickupRange = 90;
  player.regen = 0; player.damageReduction = 0; player.xpMult = 1;
  let bonusBulletDmg = 1, bonusBulletCd = 1, bonusAllDmg = 1, bonusBulletPierce = 0;
  for (const slot of EQUIP_SLOTS) { const eq = equipment[slot]; if (!eq) continue;
    for (const [k, v] of Object.entries(eq.stats)) { switch (k) {
      case 'maxHp': player.maxHp += v; break;
      case 'speed': player.speed *= (1 + v); break;
      case 'pickupRange': player.pickupRange *= (1 + v); break;
      case 'regen': player.regen += v; break;
      case 'damageReduction': player.damageReduction = Math.min(0.6, player.damageReduction + v); break;
      case 'xpMult': player.xpMult *= (1 + v); break;
      case 'bulletDmg': bonusBulletDmg *= (1 + v); break;
      case 'bulletCd': bonusBulletCd *= (1 + v); break;
      case 'allDmg': bonusAllDmg *= (1 + v); break;
      case 'bulletPierce': bonusBulletPierce += v; break;
    } }
  }
  skills.bullet.dmg = 12 * bonusBulletDmg * bonusAllDmg;
  skills.bullet.cd = Math.max(0.15, 0.7 * bonusBulletCd);
  skills.bullet.pierce = Math.max(0, (upgradeLevels['bPierce'] || 0) + bonusBulletPierce);
  skills.orbit.dmg = 8 * bonusAllDmg;
  if (skills.aura.lvl > 0) skills.aura.dps = 12 * bonusAllDmg * Math.pow(1.3, Math.max(0, skills.aura.lvl - 1));
  skills.chain.dmg = 18 * bonusAllDmg;
  skills.frost.dmg = 20 * bonusAllDmg;
  skills.laser.dps = 55 * bonusAllDmg;
  skills.boomerang.dmg = 16 * bonusAllDmg;
  skills.ult.dmg = 60 * bonusAllDmg;
  skills.chain.cd = 2.2; skills.frost.cd = 7.0; skills.boomerang.cd = 1.6;
  computeSynergies();
  player.maxHp += synergies.maxHpBonus;
  if (player.hp > player.maxHp) player.hp = player.maxHp;
}

// ===== 技能协同 + 装备套装 =====
const synergies = { allDmgMult: 1, bulletPierceBonus: 0, maxHpBonus: 0, text: '' };
function computeSynergies() {
  synergies.allDmgMult = 1; synergies.bulletPierceBonus = 0; synergies.maxHpBonus = 0;
  const active = [];
  let unlocked = 0;
  if (skills.bullet.lvl > 0) unlocked++;
  if (skills.orbit.count > 0) unlocked++;
  if (skills.aura.lvl > 0) unlocked++;
  if (skills.chain.lvl > 0) unlocked++;
  if (skills.frost.lvl > 0) unlocked++;
  if (skills.laser.lvl > 0) unlocked++;
  if (skills.boomerang.lvl > 0) unlocked++;
  if (unlocked >= 6) { synergies.allDmgMult *= 1.20; synergies.bulletPierceBonus += 1; active.push('技能大师 +20%'); }
  else if (unlocked >= 4) { synergies.allDmgMult *= 1.10; active.push('技能熟练 +10%'); }
  else if (unlocked >= 2) { synergies.allDmgMult *= 1.05; active.push('技能初成 +5%'); }
  if (skills.frost.lvl > 0 && skills.chain.lvl > 0) { synergies.allDmgMult *= 1.10; active.push('超导 +10%'); }
  if (skills.bullet.lvl > 0 && skills.laser.lvl > 0) { synergies.bulletPierceBonus += 1; active.push('聚焦光束 +1穿透'); }
  if (skills.aura.lvl > 0 && skills.orbit.count > 0) { synergies.allDmgMult *= 1.08; active.push('力场共振 +8%'); }
  if (skills.boomerang.lvl > 0 && skills.chain.lvl > 0) { synergies.allDmgMult *= 1.08; active.push('电磁回旋 +8%'); }
  const rc = { common: 0, rare: 0, epic: 0, legend: 0 };
  for (const slot of EQUIP_SLOTS) { const eq = equipment[slot]; if (eq) rc[eq.rarity]++; }
  let bestR = null, bestC = 0;
  for (const r of ['legend', 'epic', 'rare', 'common']) { if (rc[r] > bestC) { bestC = rc[r]; bestR = r; } }
  if (bestC >= 4) { synergies.allDmgMult *= 1.40; synergies.maxHpBonus = 60; active.push(RARITY[bestR].name + '4件套 +40% +60HP'); }
  else if (bestC >= 3) { synergies.allDmgMult *= 1.22; synergies.maxHpBonus = 30; active.push(RARITY[bestR].name + '3件套 +22% +30HP'); }
  else if (bestC >= 2) { synergies.allDmgMult *= 1.10; active.push(RARITY[bestR].name + '2件套 +10%'); }
  synergies.text = active.join('  ·  ');
}
function pickupEquipment(eqPick) {
  const cur = equipment[eqPick.slot];
  const order = { common: 1, rare: 2, epic: 3, legend: 4 };
  if (!cur || order[eqPick.rarity] >= order[cur.rarity]) {
    if (cur) { const xpGain = (cur.rarity === 'legend' ? 20 : cur.rarity === 'epic' ? 10 : cur.rarity === 'rare' ? 5 : 2); gainXp(xpGain);
      floatText(player.x, player.y - 40, '分解+' + xpGain + '经验', '#9aa6b8'); }
    equipment[eqPick.slot] = eqPick; applyEquipStats(); Audio.equip();
    if (player.hp > player.maxHp) player.hp = player.maxHp;
    floatText(player.x, player.y - 28, '获得 ' + RARITY[eqPick.rarity].name + ' ' + EQ_SLOT_NAME[eqPick.slot], RARITY[eqPick.rarity].color);
  } else { const xpGain = 3; gainXp(xpGain); floatText(player.x, player.y - 28, '分解为 +' + xpGain + ' 经验', '#9aa6b8'); }
}

// ========== 连击系统 ==========
const combo = { count: 0, timer: 0, maxTime: 2.5, best: 0 };
let timeScale = 1, slowMoTimer = 0;
function comboKill(x, y) {
  combo.count++; combo.timer = combo.maxTime;
  if (combo.count > combo.best) combo.best = combo.count;
  Audio.combo(combo.count);
  if (combo.count >= 5 && combo.count % 5 === 0) {
    floatText(x, y - 20, combo.count + ' COMBO!', '#ffe27a');
    cam.shake = Math.max(cam.shake, 4);
    timeScale = 0.35; slowMoTimer = 0.12;
  }
}

// ========== 分享 ==========
function shareScore() {
  const m = Math.floor(time / 60), s = Math.floor(time % 60);
  const shareText = `我在暗夜突围中存活了${m}分${s}秒，到达Lv.${player.level}，击杀${player.kills}个敌人！你能超过我吗？`;
  if (wx.shareAppMessage) wx.shareAppMessage({ title: shareText, imageUrl: '' });
}

// ========== 排行榜 ==========
const RANK_KEY = 'nightbreak_rank_v1';
const NAME_KEY = 'nightbreak_player_name';
// 启动时静默登录，生成默认昵称（微信小游戏无后端，无法换 openid，用本地昵称）
let playerName = '';
function ensureLogin() {
  try { wx.login({ success: () => {} }); } catch (e) {}
  playerName = wx.getStorageSync(NAME_KEY) || '';
  if (!playerName) {
    // 生成"指挥官+4位"默认昵称
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    playerName = '指挥官' + suffix;
    wx.setStorageSync(NAME_KEY, playerName);
  }
}
function loadRank() { try { return JSON.parse(wx.getStorageSync(RANK_KEY) || '[]'); } catch (e) { return []; } }
function saveRank(list) { try { wx.setStorageSync(RANK_KEY, JSON.stringify(list.slice(0, 20))); } catch (e) {} }
function calcScore() { return player.level * 1000 + player.kills * 50 + Math.floor(time); }
// 自动提交：每个昵称只保留最高分
function submitScore() {
  const list = loadRank();
  const score = calcScore();
  const entry = { id: playerName, score, level: player.level, kills: player.kills, time: Math.floor(time), wave, date: Date.now() };
  const existIdx = list.findIndex(e => e.id === playerName);
  if (existIdx >= 0) {
    if (score > list[existIdx].score) list[existIdx] = entry; // 刷新最高分
  } else {
    list.push(entry);
  }
  list.sort((a, b) => b.score - a.score); saveRank(list);
  return entry;
}

// ========== 游戏数据 ==========
let enemies = [], bullets = [], particles = [], gems = [], pickups = [], floats = [];
let chains = [], lasers = [], boomerangs = [], frosts = [];
let traps = []; // 黑洞陷阱
let boss = null;
let time = 0, spawnTimer = 0, pickupTimer = 8, wave = 1, lastTime = 0;
const upgradeLevels = {};

// ========== 输入系统：固定虚拟摇杆 + 技能按钮 ==========
// 固定摇杆位置（左下方，王者荣耀式），考虑 safeArea 避开刘海
const JOY_CX = Math.max(70, W * 0.16) + SAFE_L;
const JOY_CY = H - Math.max(80, H * 0.16) - SAFE_B;
const JOY_R = Math.min(W * 0.11, 55);
const JOY_KNOB_R = JOY_R * 0.52;
const JOY_DEAD = 0.15;
const joystick = {
  active: false, knobX: JOY_CX, knobY: JOY_CY,
  vec: { x: 0, y: 0 }, touchId: null,
};
// 摇杆触控区：左半屏下半部分
function isInJoyZone(x, y) { return x < W * 0.45 && y > H * 0.35; }

// 技能按钮布局（右下方 2×2 网格），考虑 safeArea
const SK_R = Math.min(W * 0.085, 34);
const SK_GAP = SK_R * 0.5;
const SK_M = 16;
const SK_RIGHT_X = W - SK_R - SK_M - SAFE_R;
const SK_LEFT_X = SK_RIGHT_X - SK_R * 2 - SK_GAP;
const SK_BOTTOM_Y = H - SK_R - SK_M - 8 - SAFE_B;
const SK_TOP_Y = SK_BOTTOM_Y - SK_R * 2 - SK_GAP;
const skillBtns = {
  bullet: { cx: SK_LEFT_X, cy: SK_TOP_Y, r: SK_R, icon: '✦', name: '弹幕', key: '1' },
  orbit: { cx: SK_RIGHT_X, cy: SK_TOP_Y, r: SK_R, icon: '◉', name: '光球', key: '2' },
  aura: { cx: SK_LEFT_X, cy: SK_BOTTOM_Y, r: SK_R, icon: '◎', name: '光环', key: '3' },
  ult: { cx: SK_RIGHT_X, cy: SK_BOTTOM_Y, r: SK_R, icon: '✺', name: '爆发', key: 'R' },
};

// 顶部按钮
const TOP_R = 15;
const topBtns = {
  sound: { cx: W - TOP_R - 10 - SAFE_R, cy: HUD_TOP + TOP_R + 2, r: TOP_R },
  pause: { cx: W - TOP_R * 3 - 14 - SAFE_R, cy: HUD_TOP + TOP_R + 2, r: TOP_R },
};

// 升级界面卡片
let levelUpChoices = [];
let levelUpCardRects = [];

// 结算界面状态
let goSubmitted = false;
let goRankEntry = null;

// 排行榜界面
let showRankFromStart = false;

// 触控处理
function onTouchStart(e) {
  Audio.resume(); // 首次触摸恢复音频上下文（微信限制）
  for (const t of e.changedTouches) {
    const x = t.clientX, y = t.clientY;
    handleTouchStart(x, y, t.identifier);
  }
}
function handleTouchStart(x, y, id) {
  // 升级界面
  if (state === STATE.LEVELUP) {
    for (const cr of levelUpCardRects) {
      if (ptInRect(x, y, cr.x, cr.y, cr.w, cr.h)) {
        for (let i = 0; i < cr.times; i++) cr.upgrade.apply();
        upgradeLevels[cr.upgrade.id] = (upgradeLevels[cr.upgrade.id] || 0) + 1;
        computeSynergies();
        state = STATE.PLAY; cam.shake = 6; Audio.levelup();
        return;
      }
    }
    return;
  }
  // 结算界面
  if (state === STATE.OVER) { handleOverTouch(x, y); return; }
  // 暂停界面
  if (state === STATE.PAUSE) { handlePauseTouch(x, y); return; }
  // 开始界面
  if (state === STATE.START) {
    if (showRankFromStart) { handleRankClose(x, y); return; }
    handleStartTouch(x, y); return;
  }
  // 游戏中
  if (state === STATE.PLAY) {
    // 技能按钮
    for (const [name, btn] of Object.entries(skillBtns)) {
      if (ptInCircle(x, y, btn.cx, btn.cy, btn.r)) { tryCastSkill(name); return; }
    }
    // 顶部按钮
    if (ptInCircle(x, y, topBtns.sound.cx, topBtns.sound.cy, topBtns.sound.r)) {
      Audio.enabled = !Audio.enabled; if (Audio.enabled) Audio.resume(); return;
    }
    if (ptInCircle(x, y, topBtns.pause.cx, topBtns.pause.cy, topBtns.pause.r)) {
      state = STATE.PAUSE; return;
    }
    // 摇杆
    if (isInJoyZone(x, y) && joystick.touchId === null) {
      joystick.active = true; joystick.touchId = id;
      joystick.knobX = JOY_CX; joystick.knobY = JOY_CY;
    }
  }
}
function onTouchMove(e) {
  if (!joystick.active) return;
  for (const t of e.changedTouches) {
    if (t.identifier === joystick.touchId) {
      let dx = t.clientX - JOY_CX, dy = t.clientY - JOY_CY;
      const d = Math.hypot(dx, dy);
      if (d > JOY_R) { dx = dx / d * JOY_R; dy = dy / d * JOY_R; }
      joystick.knobX = JOY_CX + dx; joystick.knobY = JOY_CY + dy;
      let nx = dx / JOY_R, ny = dy / JOY_R;
      if (Math.hypot(nx, ny) < JOY_DEAD) { nx = 0; ny = 0; }
      joystick.vec.x = nx; joystick.vec.y = ny;
      break;
    }
  }
}
function onTouchEnd(e) {
  if (joystick.active) {
    for (const t of e.changedTouches) {
      if (t.identifier === joystick.touchId) {
        joystick.active = false; joystick.touchId = null;
        joystick.knobX = JOY_CX; joystick.knobY = JOY_CY;
        joystick.vec = { x: 0, y: 0 };
        break;
      }
    }
  }
}
wx.onTouchStart(onTouchStart);
wx.onTouchMove(onTouchMove);
wx.onTouchEnd(onTouchEnd);
wx.onTouchCancel(onTouchEnd);

function handleStartTouch(x, y) {
  const btnW = IS_LANDSCAPE ? W * 0.32 : W * 0.7;
  const btnH = 58;
  const btnGap = 18;
  const totalBtnH = btnH * 2 + btnGap;
  const btnRightX = IS_LANDSCAPE ? W * 0.62 : (W - btnW) / 2;
  const btnStartY = H / 2 - totalBtnH / 2;
  // 开始按钮
  if (ptInRect(x, y, btnRightX, btnStartY, btnW, btnH)) {
    resetGame(); state = STATE.PLAY; return;
  }
  // 排行榜按钮
  if (ptInRect(x, y, btnRightX, btnStartY + btnH + btnGap, btnW, btnH)) {
    showRankFromStart = true; return;
  }
}
function handleRankClose(x, y) {
  const btnW = W * 0.4, btnH = 42;
  if (ptInRect(x, y, (W - btnW) / 2, H * 0.85, btnW, btnH)) showRankFromStart = false;
}
function handleOverTouch(x, y) {
  const btnW = W * 0.4, btnH = 46;
  const btnY = H * 0.82;
  // 再次突围
  if (ptInRect(x, y, (W - btnW) / 2 - btnW / 2 - 6, btnY, btnW, btnH)) {
    resetGame(); state = STATE.PLAY; return;
  }
  // 分享战绩
  if (ptInRect(x, y, (W - btnW) / 2 + btnW / 2 + 6, btnY, btnW, btnH)) {
    shareScore(); return;
  }
}
function handlePauseTouch(x, y) {
  const btnW = W * 0.5, btnH = 46;
  const btnY1 = H * 0.42, btnY2 = H * 0.42 + 60;
  if (ptInRect(x, y, (W - btnW) / 2, btnY1, btnW, btnH)) { state = STATE.PLAY; return; }
  if (ptInRect(x, y, (W - btnW) / 2, btnY2, btnW, btnH)) {
    state = STATE.START; showRankFromStart = false; return;
  }
}

// ========== UI 渲染（全部 Canvas 绘制） ==========
function drawGradientBtn(x, y, w, h, text, c1, c2, fontSize) {
  const grad = ctx.createLinearGradient(x, y, x + w, y);
  grad.addColorStop(0, c1); grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  roundRect(ctx, x, y, w, h, 10); ctx.fill();
  ctx.fillStyle = '#06121a';
  ctx.font = 'bold ' + (fontSize || 16) + 'px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + h / 2);
}
function drawText(text, x, y, font, color, align, baseline) {
  ctx.font = font || '14px sans-serif';
  ctx.textAlign = align || 'left'; ctx.textBaseline = baseline || 'alphabetic';
  ctx.fillStyle = color || '#e8ecf3';
  ctx.fillText(text, x, y);
}
function drawOverlay(alpha) {
  const g = ctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H / 2, Math.max(W, H));
  g.addColorStop(0, 'rgba(20,24,40,' + (alpha || 0.72) + ')');
  g.addColorStop(1, 'rgba(5,6,10,' + ((alpha || 0.72) + 0.15) + ')');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

function drawHUD() {
  // ===== 王者荣耀风：左上角玩家信息卡片 =====
  const avR = 18;                       // 头像半径
  const cardX = 12 + SAFE_L;            // 卡片左起点（避开刘海）
  const cardY = HUD_TOP + 4;            // 卡片顶部
  const barW = Math.min(W * 0.32, 150); // 短血条宽度
  const barH = 9;                       // 血条高度
  const barX = cardX + avR * 2 + 10;    // 条起始 x（头像右侧）
  const xpH = 5;                        // 经验条更细

  // 头像背景圆
  ctx.fillStyle = 'rgba(10,14,28,0.85)';
  ctx.beginPath(); ctx.arc(cardX + avR, cardY + avR, avR + 2, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(138,255,214,0.6)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cardX + avR, cardY + avR, avR + 2, 0, TAU); ctx.stroke();
  // 头像图标（玩家战机）
  ctx.font = '18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8affd6'; ctx.shadowColor = 'rgba(138,255,214,0.6)'; ctx.shadowBlur = 6;
  ctx.fillText('✦', cardX + avR, cardY + avR + 1); ctx.shadowBlur = 0;
  // 等级徽章（头像右下角小圆）
  const bx = cardX + avR * 2 - 2, by = cardY + avR * 2 - 2;
  ctx.fillStyle = '#ffe27a';
  ctx.beginPath(); ctx.arc(bx, by, 8, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#1a1408'; ctx.font = 'bold 10px sans-serif';
  ctx.fillText(String(player.level), bx, by + 1);

  // HP 条（短）
  const hpY = cardY + 3;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(ctx, barX - 1, hpY - 1, barW + 2, barH + 2, (barH + 2) / 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  roundRect(ctx, barX, hpY, barW, barH, barH / 2); ctx.fill();
  const hpW = barW * clamp(player.hp / player.maxHp, 0, 1);
  if (hpW > 0) {
    const hpGrad = ctx.createLinearGradient(barX, hpY, barX + barW, hpY);
    hpGrad.addColorStop(0, '#ff4d6d'); hpGrad.addColorStop(1, '#ff8fa3');
    ctx.fillStyle = hpGrad;
    roundRect(ctx, barX, hpY, hpW, barH, barH / 2); ctx.fill();
  }
  // HP 数值
  ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(Math.ceil(player.hp) + '/' + Math.round(player.maxHp), barX + 4, hpY + barH / 2 + 1);

  // XP 条（更短更细，紧贴血条下方）
  const xpY = hpY + barH + 3;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(ctx, barX - 1, xpY - 1, barW + 2, xpH + 2, (xpH + 2) / 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  roundRect(ctx, barX, xpY, barW, xpH, xpH / 2); ctx.fill();
  const xpW = barW * clamp(player.xp / player.xpNext, 0, 1);
  if (xpW > 0) {
    const xpGrad = ctx.createLinearGradient(barX, xpY, barX + barW, xpY);
    xpGrad.addColorStop(0, '#4dd0ff'); xpGrad.addColorStop(1, '#8affd6');
    ctx.fillStyle = xpGrad;
    roundRect(ctx, barX, xpY, xpW, xpH, xpH / 2); ctx.fill();
  }

  // ===== 统计信息（左上角卡片下方，避开右上角按钮）=====
  const stX = cardX + 2;
  const stY = cardY + avR * 2 + 8;
  const m = Math.floor(time / 60), s = Math.floor(time % 60);
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillStyle = '#ffe27a';
  ctx.fillText(m + ':' + String(s).padStart(2, '0'), stX, stY);
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#9aa6b8';
  ctx.fillText('击杀 ' + player.kills + ' · 波 ' + wave, stX, stY + 14);
}

function drawTopBtns() {
  for (const [name, btn] of Object.entries(topBtns)) {
    ctx.fillStyle = 'rgba(10,14,28,0.7)';
    ctx.beginPath(); ctx.arc(btn.cx, btn.cy, btn.r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(btn.cx, btn.cy, btn.r, 0, TAU); ctx.stroke();
    ctx.font = '15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8affd6';
    if (name === 'sound') ctx.fillText(Audio.enabled ? '🔊' : '🔇', btn.cx, btn.cy + 1);
    else ctx.fillText('⏸', btn.cx, btn.cy + 1);
  }
}

function drawEquipBar() {
  const slotSize = 38, gap = 6;
  const totalW = EQUIP_SLOTS.length * slotSize + (EQUIP_SLOTS.length - 1) * gap;
  const startX = 10;
  const y = JOY_CY - JOY_R - slotSize - 12;
  for (let i = 0; i < EQUIP_SLOTS.length; i++) {
    const slot = EQUIP_SLOTS[i];
    const eq = equipment[slot];
    const x = startX + i * (slotSize + gap);
    ctx.fillStyle = 'rgba(10,14,28,0.7)';
    roundRect(ctx, x, y, slotSize, slotSize, 8); ctx.fill();
    if (eq) {
      const rc = RARITY[eq.rarity].color;
      ctx.strokeStyle = rc; ctx.lineWidth = 1.5;
      roundRect(ctx, x, y, slotSize, slotSize, 8); ctx.stroke();
      ctx.font = '18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = rc; ctx.fillText(EQ_SLOT_ICON[slot], x + slotSize / 2, y + slotSize / 2 + 1);
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
      roundRect(ctx, x, y, slotSize, slotSize, 8); ctx.stroke();
    }
    ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(138,147,166,0.7)';
    ctx.fillText(EQ_SLOT_NAME[slot], x + slotSize / 2, y - 2);
  }
  // 协同提示
  if (synergies.text) {
    ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#8affd6';
    ctx.fillText(synergies.text, startX, y + slotSize + 4);
  }
}

function drawComboDisp() {
  if (combo.count < 3) return;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 38px sans-serif';
  ctx.fillStyle = '#ffe27a';
  ctx.shadowColor = 'rgba(255,226,122,0.6)'; ctx.shadowBlur = 20;
  ctx.fillText(String(combo.count), W / 2, H * 0.32);
  ctx.shadowBlur = 0;
  ctx.font = '12px sans-serif'; ctx.fillStyle = '#8affd6';
  ctx.fillText('COMBO', W / 2, H * 0.32 + 24);
}

function drawJoystick() {
  // 外环
  ctx.strokeStyle = 'rgba(138,255,214,0.4)'; ctx.lineWidth = 2.5;
  ctx.fillStyle = 'rgba(77,208,255,0.06)';
  ctx.beginPath(); ctx.arc(JOY_CX, JOY_CY, JOY_R, 0, TAU); ctx.fill(); ctx.stroke();
  // 内圈虚线
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.arc(JOY_CX, JOY_CY, JOY_R - 12, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);
  // 摇杆头
  const kg = ctx.createRadialGradient(
    joystick.knobX - JOY_KNOB_R * 0.3, joystick.knobY - JOY_KNOB_R * 0.3, 0,
    joystick.knobX, joystick.knobY, JOY_KNOB_R
  );
  kg.addColorStop(0, 'rgba(189,255,230,0.95)');
  kg.addColorStop(0.6, 'rgba(77,208,255,0.65)');
  kg.addColorStop(1, 'rgba(40,120,160,0.5)');
  ctx.fillStyle = kg;
  ctx.shadowColor = 'rgba(138,255,214,0.6)'; ctx.shadowBlur = joystick.active ? 18 : 10;
  ctx.beginPath(); ctx.arc(joystick.knobX, joystick.knobY, JOY_KNOB_R, 0, TAU); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(189,255,230,0.9)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(joystick.knobX, joystick.knobY, JOY_KNOB_R, 0, TAU); ctx.stroke();
}

function drawSkillButtons() {
  const map = {
    bullet: { cd: skills.bullet.btnCd, max: skills.bullet.btnCdMax, enabled: true, cls: 's-bullet' },
    orbit: { cd: skills.orbit.burstCd, max: skills.orbit.burstCdMax, enabled: skills.orbit.lvl > 0, cls: 's-orbit' },
    aura: { cd: skills.aura.novaCd, max: skills.aura.novaCdMax, enabled: skills.aura.lvl > 0, cls: 's-aura' },
    ult: { cd: skills.ult.cd, max: skills.ult.cdMax, enabled: true, cls: 's-ult' },
  };
  const iconColors = { bullet: '#8affd6', orbit: '#bdffe6', aura: '#d9a8ff', ult: '#ffd86b' };
  for (const [name, btn] of Object.entries(skillBtns)) {
    const info = map[name];
    const r = btn.r;
    // 按钮背景
    const bgGrad = ctx.createLinearGradient(btn.cx - r, btn.cy - r, btn.cx + r, btn.cy + r);
    bgGrad.addColorStop(0, 'rgba(40,56,90,0.9)');
    bgGrad.addColorStop(1, 'rgba(18,26,46,0.95)');
    ctx.fillStyle = bgGrad;
    ctx.beginPath(); ctx.arc(btn.cx, btn.cy, r, 0, TAU); ctx.fill();
    // 边框
    ctx.strokeStyle = info.enabled ? 'rgba(77,208,255,0.45)' : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(btn.cx, btn.cy, r, 0, TAU); ctx.stroke();
    // 图标
    ctx.globalAlpha = info.enabled ? 1 : 0.35;
    ctx.font = '24px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = iconColors[name];
    ctx.shadowColor = iconColors[name]; ctx.shadowBlur = info.enabled && info.cd <= 0 ? 8 : 0;
    ctx.fillText(btn.icon, btn.cx, btn.cy - 2);
    ctx.shadowBlur = 0;
    // 名称
    ctx.font = '10px sans-serif'; ctx.fillStyle = 'rgba(200,208,220,0.7)';
    ctx.fillText(btn.name, btn.cx, btn.cy + r - 10);
    ctx.globalAlpha = 1;
    // 冷却遮罩
    if (info.cd > 0 && info.enabled) {
      const ratio = info.cd / info.max;
      ctx.fillStyle = 'rgba(5,8,16,0.72)';
      ctx.beginPath();
      ctx.moveTo(btn.cx, btn.cy);
      ctx.arc(btn.cx, btn.cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * ratio, false);
      ctx.closePath(); ctx.fill();
      ctx.font = 'bold 16px sans-serif'; ctx.fillStyle = '#fff';
      ctx.fillText(info.cd.toFixed(1), btn.cx, btn.cy);
    }
    // 按键提示
    ctx.font = 'bold 9px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(btn.key, btn.cx + r - 4, btn.cy - r + 3);
  }
}

function drawHint() {
  ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(154,166,184,0.4)';
  ctx.fillText('靠近经验宝石自动拾取 · 击败Boss有传说装备掉落', W / 2, H - 4);
}

function drawStartScreen() {
  drawOverlay(0.88);
  // 左侧：标题 + 简介（横屏左半区）
  const leftW = IS_LANDSCAPE ? W * 0.55 : W * 0.92;
  const dx = IS_LANDSCAPE ? W * 0.06 : W * 0.04;
  // 标题
  const tg = ctx.createLinearGradient(dx, H * 0.18, dx + leftW, H * 0.18);
  tg.addColorStop(0, '#4dd0ff'); tg.addColorStop(0.5, '#8affd6'); tg.addColorStop(1, '#ffe27a');
  ctx.fillStyle = tg; ctx.shadowColor = 'rgba(77,208,255,0.4)'; ctx.shadowBlur = 22;
  ctx.font = 'bold 36px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('暗 夜 突 围', dx, H * 0.22);
  ctx.shadowBlur = 0;
  ctx.font = '13px sans-serif'; ctx.fillStyle = '#8a93a6';
  ctx.fillText('N  I  G  H  T  B  R  E  A  K', dx, H * 0.22 + 30);
  // 简介
  ctx.font = '13px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillStyle = '#aab4c6';
  const lines = [
    '· 暗夜之中敌潮汹涌，驾驶战机自动释放弹幕清场',
    '· 击杀获取经验升级，学习闪电链/激光束/回旋镖',
    '· 警惕冲锋、分裂、远程、自爆四类特殊敌人',
    '· 2分钟精英Boss，5分钟终极Boss，掉落传说装备',
    '· 大地图自由走位，小心黑洞陷阱！',
  ];
  let ly = H * 0.36;
  for (const ln of lines) { ctx.fillText(ln, dx, ly); ly += 24; }
  // 操作说明
  ctx.font = '12px sans-serif'; ctx.fillStyle = '#8a93a6';
  ly += 8;
  ctx.fillText('左下摇杆移动 · 右下技能按钮释放', dx, ly);

  // 右侧：两个大按钮（竖排，横屏右半区居中）
  const btnW = IS_LANDSCAPE ? W * 0.32 : W * 0.7;
  const btnH = 58;
  const btnGap = 18;
  const totalBtnH = btnH * 2 + btnGap;
  const btnRightX = IS_LANDSCAPE ? W * 0.62 : (W - btnW) / 2;
  const btnStartY = H / 2 - totalBtnH / 2;
  drawGradientBtn(btnRightX, btnStartY, btnW, btnH, '开 始 突 围', '#4dd0ff', '#8affd6', 20);
  drawGradientBtn(btnRightX, btnStartY + btnH + btnGap, btnW, btnH, '排  行  榜', '#b066ff', '#4dd0ff', 18);
}

function drawLevelUpScreen() {
  drawOverlay(0.82);
  // 标题（带光晕）
  ctx.font = 'bold 26px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8affd6'; ctx.shadowColor = 'rgba(138,255,214,0.6)'; ctx.shadowBlur = 18;
  ctx.fillText('升 级', W / 2, H * 0.13);
  ctx.shadowBlur = 0;
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#8a93a6';
  ctx.fillText('选 择 一 项 强 化', W / 2, H * 0.13 + 24);

  for (let i = 0; i < levelUpChoices.length; i++) {
    const ch = levelUpChoices[i];
    const cr = levelUpCardRects[i];
    const rc = RARITY[ch.rarity].color;
    const rcDim = hexA(rc, 0.35);
    const cw = cr.w, ch_h = cr.h, cx = cr.x, cy = cr.y;
    // 卡片背景（双层渐变 + 稀有度色调）
    const bgGrad = ctx.createLinearGradient(cx, cy, cx, cy + ch_h);
    bgGrad.addColorStop(0, blendColor('#2a3450', rc, 0.18));
    bgGrad.addColorStop(1, 'rgba(12,16,30,0.96)');
    ctx.fillStyle = bgGrad;
    roundRect(ctx, cx, cy, cw, ch_h, 16); ctx.fill();
    // 顶部稀有度高光带
    const topGrad = ctx.createLinearGradient(cx, cy, cx + cw, cy);
    topGrad.addColorStop(0, 'rgba(0,0,0,0)'); topGrad.addColorStop(0.5, hexA(rc, 0.5)); topGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = topGrad;
    roundRect(ctx, cx, cy, cw, 3, 1.5); ctx.fill();
    // 外发光边框（稀有度颜色）
    ctx.shadowColor = rc; ctx.shadowBlur = ch.rarity === 'legend' ? 22 : ch.rarity === 'epic' ? 16 : 10;
    ctx.strokeStyle = rc; ctx.lineWidth = 2;
    roundRect(ctx, cx, cy, cw, ch_h, 16); ctx.stroke();
    ctx.shadowBlur = 0;
    // 内层细边
    ctx.strokeStyle = rcDim; ctx.lineWidth = 1;
    roundRect(ctx, cx + 3, cy + 3, cw - 6, ch_h - 6, 13); ctx.stroke();

    // 图标圆形底座（居中靠上）
    const iconR = Math.min(cw, ch_h) * 0.18;
    const iconCX = cx + cw / 2, iconCY = cy + iconR + 18;
    // 外光晕环
    ctx.fillStyle = hexA(rc, 0.12);
    ctx.beginPath(); ctx.arc(iconCX, iconCY, iconR + 6, 0, TAU); ctx.fill();
    // 圆形底座渐变
    const iconBg = ctx.createRadialGradient(iconCX - iconR * 0.3, iconCY - iconR * 0.3, 0, iconCX, iconCY, iconR);
    iconBg.addColorStop(0, blendColor('#3a4870', rc, 0.3)); iconBg.addColorStop(1, 'rgba(10,14,28,0.95)');
    ctx.fillStyle = iconBg;
    ctx.beginPath(); ctx.arc(iconCX, iconCY, iconR, 0, TAU); ctx.fill();
    ctx.strokeStyle = rc; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(iconCX, iconCY, iconR, 0, TAU); ctx.stroke();
    // 图标字符
    ctx.font = Math.round(iconR * 1.3) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = rc; ctx.shadowColor = rc; ctx.shadowBlur = 10;
    ctx.fillText(ch.upgrade.icon, iconCX, iconCY + 1);
    ctx.shadowBlur = 0;

    // 稀有度标签（右上角小胶囊）
    const tagW = 32, tagH = 14, tagX = cx + cw - tagW - 8, tagY = cy + 8;
    ctx.fillStyle = hexA(rc, 0.2);
    roundRect(ctx, tagX, tagY, tagW, tagH, tagH / 2); ctx.fill();
    ctx.strokeStyle = rc; ctx.lineWidth = 1;
    roundRect(ctx, tagX, tagY, tagW, tagH, tagH / 2); ctx.stroke();
    ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = rc;
    ctx.fillText(RARITY[ch.rarity].name, tagX + tagW / 2, tagY + tagH / 2 + 0.5);

    // 名称（图标下方居中）
    ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = rc; ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 3;
    ctx.fillText(ch.upgrade.name, cx + cw / 2, iconCY + iconR + 16);
    ctx.shadowBlur = 0;
    // 等级（名称下方）
    ctx.font = '10px sans-serif'; ctx.fillStyle = 'rgba(200,210,225,0.7)';
    const lvlText = ch.upgrade.getLvl() > 0 ? 'Lv.' + ch.upgrade.getLvl() + ' → Lv.' + (ch.upgrade.getLvl() + ch.times) : '新技能 · ×' + ch.times;
    ctx.fillText(lvlText, cx + cw / 2, iconCY + iconR + 32);
    // 描述（底部居中换行）
    ctx.font = '11px sans-serif'; ctx.fillStyle = '#b8c0d0';
    const descY = cy + ch_h - 30;
    ctx.fillText(ch.upgrade.desc, cx + cw / 2, descY);
    if (ch.times > 1) {
      ctx.fillStyle = rc;
      ctx.fillText('稀有度加成 ×' + ch.times, cx + cw / 2, descY + 14);
    }
  }
}

function drawOverScreen() {
  drawOverlay(0.85);
  ctx.font = 'bold 26px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ff6b8a'; ctx.shadowColor = 'rgba(255,77,109,0.5)'; ctx.shadowBlur = 22;
  ctx.fillText('突 围 失 败', W / 2, H * 0.10);
  ctx.shadowBlur = 0;
  ctx.font = '12px sans-serif'; ctx.fillStyle = '#8a93a6';
  ctx.fillText('你的战机坠毁在暗夜中', W / 2, H * 0.10 + 24);
  // 本局统计（左列）+ 排行榜（右列），横屏并排
  const colW = IS_LANDSCAPE ? W * 0.4 : W * 0.9;
  const colGap = IS_LANDSCAPE ? W * 0.04 : 0;
  const leftX = IS_LANDSCAPE ? W * 0.04 : W * 0.05;
  const rightX = IS_LANDSCAPE ? W * 0.5 : W * 0.05;
  // 左：本局战绩
  ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#8affd6';
  ctx.fillText('本 局 战 绩', leftX, H * 0.20);
  const m = Math.floor(time / 60), s = Math.floor(time % 60);
  const stats = [
    ['存活时间', m + ':' + String(s).padStart(2, '0')],
    ['到达等级', 'Lv.' + player.level],
    ['击杀数', String(player.kills)],
    ['波次', String(wave)],
    ['总得分', String(calcScore())],
  ];
  let sy = H * 0.24;
  for (const [k, v] of stats) {
    ctx.font = '13px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#8a93a6';
    ctx.fillText(k, leftX, sy);
    ctx.textAlign = 'left'; ctx.fillStyle = v === String(calcScore()) ? '#8affd6' : '#ffe27a';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(v, leftX + 90, sy);
    sy += 22;
  }
  // 右：英雄榜（自动已提交）
  ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#8affd6';
  ctx.fillText('暗 夜 英 雄 榜', rightX, H * 0.20);
  const list = loadRank();
  const myRankIdx = goRankEntry ? list.findIndex(e => e.id === goRankEntry.id && e.score === goRankEntry.score && e.date === goRankEntry.date) : -1;
  let ry = H * 0.24;
  const showCount = Math.min(6, list.length);
  for (let i = 0; i < showCount; i++) {
    const r = list[i];
    const isMe = i === myRankIdx;
    ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
    ctx.fillStyle = isMe ? '#4dd0ff' : (i === 0 ? '#ffe27a' : i < 3 ? '#cd9b4a' : '#9aa6b8');
    ctx.fillText((i + 1) + '. ' + r.id, rightX, ry);
    ctx.textAlign = 'right';
    ctx.fillText(String(r.score) + ' (Lv.' + r.level + ')', rightX + colW, ry);
    ry += 18;
  }
  // 若自己不在前6，单独显示自己的名次
  if (myRankIdx >= 6) {
    ry += 6;
    ctx.font = '12px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#4dd0ff';
    ctx.fillText((myRankIdx + 1) + '. ' + goRankEntry.id + ' (你)', rightX, ry);
    ctx.textAlign = 'right';
    ctx.fillText(String(goRankEntry.score) + ' (Lv.' + goRankEntry.level + ')', rightX + colW, ry);
  }
  // 按钮
  const btnY = H * 0.82, btnW = W * 0.4, btnH = 46;
  drawGradientBtn((W - btnW) / 2 - btnW / 2 - 6, btnY, btnW, btnH, '再次突围', '#4dd0ff', '#8affd6', 16);
  drawGradientBtn((W - btnW) / 2 + btnW / 2 + 6, btnY, btnW, btnH, '分享战绩', '#b066ff', '#4dd0ff', 16);
}

function drawPauseScreen() {
  drawOverlay(0.8);
  ctx.font = 'bold 24px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8affd6';
  ctx.fillText('暂 停', W / 2, H * 0.32);
  ctx.font = '12px sans-serif'; ctx.fillStyle = '#8a93a6';
  ctx.fillText('游戏已暂停', W / 2, H * 0.32 + 24);
  const btnW = W * 0.5, btnH = 46;
  drawGradientBtn((W - btnW) / 2, H * 0.42, btnW, btnH, '继续游戏', '#4dd0ff', '#8affd6');
  drawGradientBtn((W - btnW) / 2, H * 0.42 + 60, btnW, btnH, '返回主菜单', '#b066ff', '#4dd0ff');
}

function drawRankScreen() {
  drawOverlay(0.85);
  ctx.font = 'bold 24px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8affd6';
  ctx.fillText('排 行 榜', W / 2, H * 0.12);
  ctx.font = '12px sans-serif'; ctx.fillStyle = '#8a93a6';
  ctx.fillText('暗 夜 英 雄 榜', W / 2, H * 0.12 + 24);
  const list = loadRank();
  if (list.length === 0) {
    ctx.font = '14px sans-serif'; ctx.fillStyle = '#5a6478';
    ctx.fillText('暂无记录，快来成为第一位上榜者！', W / 2, H * 0.4);
  } else {
    let ry = H * 0.20;
    for (let i = 0; i < Math.min(list.length, 15); i++) {
      const r = list[i];
      const medal = i === 0 ? '#ffe27a' : i === 1 ? '#c8d0dc' : i === 2 ? '#cd7f4a' : '#9aa6b8';
      ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'left';
      ctx.fillStyle = medal;
      ctx.fillText(String(i + 1), W * 0.12, ry);
      ctx.font = '13px sans-serif'; ctx.fillStyle = '#e8ecf3';
      ctx.fillText(r.id, W * 0.18, ry);
      ctx.textAlign = 'right'; ctx.fillStyle = '#ffe27a';
      ctx.fillText(String(r.score), W * 0.68, ry);
      const rm = Math.floor(r.time / 60), rs = r.time % 60;
      ctx.font = '11px sans-serif'; ctx.fillStyle = '#8a93a6';
      ctx.fillText('Lv.' + r.level + ' · ' + r.kills + '杀 · ' + rm + ':' + String(rs).padStart(2, '0'), W * 0.88, ry);
      ry += 22;
    }
  }
  const btnW = W * 0.4, btnH = 42;
  drawGradientBtn((W - btnW) / 2, H * 0.85, btnW, btnH, '返回', '#4dd0ff', '#8affd6');
}

function drawUI() {
  if (state === STATE.START) {
    if (showRankFromStart) drawRankScreen();
    else drawStartScreen();
    return;
  }
  drawHUD();
  drawBossBar();
  drawTopBtns();
  drawEquipBar();
  drawComboDisp();
  if (state === STATE.PLAY || state === STATE.PAUSE) {
    drawJoystick();
    drawSkillButtons();
    drawHint();
  }
  if (state === STATE.LEVELUP) drawLevelUpScreen();
  if (state === STATE.OVER) drawOverScreen();
  if (state === STATE.PAUSE) drawPauseScreen();
}

// ========== 技能释放 ==========
function tryCastSkill(name) {
  if (state !== STATE.PLAY) return;
  const s = skills[name]; if (!s) return;
  if (name === 'bullet') { if (s.btnCd > 0) return; s.btnCd = s.btnCdMax; castBulletBurst(); }
  else if (name === 'orbit') { if (s.lvl <= 0) return floatText(player.x, player.y - 28, '未解锁', '#8a93a6'); if (s.burstCd > 0) return; s.burstCd = s.burstCdMax; castOrbitBurst(); }
  else if (name === 'aura') { if (s.lvl <= 0) return floatText(player.x, player.y - 28, '未解锁', '#8a93a6'); if (s.novaCd > 0) return; s.novaCd = s.novaCdMax; castAuraNova(); }
  else if (name === 'ult') { if (s.cd > 0) return; s.cd = s.cdMax; castUlt(); }
}
function castBulletBurst() { const b = skills.bullet; cam.shake = 5;
  for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; bullets.push({ x: player.x, y: player.y, r: 6, vx: Math.cos(a) * b.speed, vy: Math.sin(a) * b.speed, dmg: b.dmg * 1.4, pierce: Math.max(1, b.pierce + synergies.bulletPierceBonus), hit: new Set(), life: 1.4, color: '#ffe27a' }); }
  spawnParticles(player.x, player.y, '#ffe27a', 16, 180); floatText(player.x, player.y - 28, '弹幕爆发!', '#ffe27a'); }
function castOrbitBurst() { const o = skills.orbit; cam.shake = 4;
  for (let k = 0; k < o.count; k++) { const a = o.angle + (k / o.count) * TAU; const sx = player.x + Math.cos(a) * o.radius, sy = player.y + Math.sin(a) * o.radius;
    for (let i = 0; i < 6; i++) { const aa = (i / 6) * TAU + a * 0.3; bullets.push({ x: sx, y: sy, r: 5, vx: Math.cos(aa) * 380, vy: Math.sin(aa) * 380, dmg: o.dmg * 1.6, pierce: 0, hit: new Set(), life: 1.2, color: '#bdffe6' }); } }
  spawnParticles(player.x, player.y, '#8affd6', 20, 200); floatText(player.x, player.y - 28, '光球散射!', '#8affd6'); }
function castAuraNova() { const au = skills.aura; cam.shake = 6;
  const r = au.radius + 40, r2 = r * r;
  for (let i = enemies.length - 1; i >= 0; i--) { const e = enemies[i]; if (dist2(e.x, e.y, player.x, player.y) < r2) damageEnemy(e, au.dps * 4, i); }
  if (boss && dist2(boss.x, boss.y, player.x, player.y) < r2) damageBoss(au.dps * 4);
  particles.push({ kind: 'ring', x: player.x, y: player.y, r0: 10, r, life: 0.45, max: 0.45, color: '#c89bff' });
  spawnParticles(player.x, player.y, '#b066ff', 24, 220); floatText(player.x, player.y - 28, '幽冥冲击!', '#c89bff'); }
function castUlt() { const u = skills.ult; cam.shake = 16; Audio.ult();
  const r2 = u.radius * u.radius;
  for (let i = enemies.length - 1; i >= 0; i--) { const e = enemies[i]; if (dist2(e.x, e.y, player.x, player.y) < r2) damageEnemy(e, u.dmg + player.level * 2, i); }
  if (boss && dist2(boss.x, boss.y, player.x, player.y) < r2) damageBoss(u.dmg + player.level * 3);
  particles.push({ kind: 'ring', x: player.x, y: player.y, r0: 10, r: u.radius, life: 0.6, max: 0.6, color: '#ffd86b' });
  particles.push({ kind: 'ring', x: player.x, y: player.y, r0: 10, r: u.radius * 0.7, life: 0.45, max: 0.45, color: '#ff8fa3' });
  spawnParticles(player.x, player.y, '#ffe27a', 50, 360); floatText(player.x, player.y - 28, '终焉爆发!!', '#ffd86b'); }

// ========== 游戏重置 ==========
function resetGame() {
  // 玩家出生在地图中心
  player.x = MAP_W / 2; player.y = MAP_H / 2;
  player.hp = 100; player.maxHp = 100; player.speed = 180;
  player.level = 1; player.xp = 0; player.xpNext = 5; player.kills = 0;
  player.invuln = 0; player.pickupRange = 90; player.regen = 0;
  player.damageReduction = 0; player.xpMult = 1; player.facing = -Math.PI / 2;
  skills.bullet = { name: '暗夜弹', icon: '✦', lvl: 1, dmg: 12, cd: 0.7, timer: 0, count: 1, pierce: 0, speed: 460, spread: 0.12, btnCd: 0, btnCdMax: 3.0 };
  skills.orbit = { name: '护体光球', icon: '◉', lvl: 0, dmg: 8, count: 0, radius: 72, speed: 2.6, angle: 0, hitCd: {}, burstCd: 0, burstCdMax: 4.5 };
  skills.aura = { name: '幽冥光环', icon: '◎', lvl: 0, dmg: 6, radius: 0, dps: 0, tick: 0, novaCd: 0, novaCdMax: 6.0 };
  skills.chain = { name: '闪电链', icon: '⚡', lvl: 0, dmg: 18, cd: 2.2, timer: 0, targets: 3, bounce: 2 };
  skills.frost = { name: '冰冻新星', icon: '❄', lvl: 0, dmg: 20, cd: 7.0, timer: 0, radius: 0, slowDur: 3 };
  skills.laser = { name: '激光束', icon: '⟿', lvl: 0, dmg: 5, cd: 0, timer: 0, dps: 55, width: 10, angle: 0, sweep: 0.25, tickTimer: 0 };
  skills.boomerang = { name: '回旋镖', icon: '✧', lvl: 0, dmg: 16, cd: 1.6, timer: 0, count: 1, pierce: 4, speed: 320 };
  skills.ult = { name: '终极爆发', icon: '✺', lvl: 0, cdMax: 20, cd: 0, dmg: 60, radius: 160 };
  enemies = []; bullets = []; particles = []; gems = []; pickups = []; floats = [];
  chains = []; lasers = []; boomerangs = []; frosts = []; eqDrops = []; boss = null;
  time = 0; spawnTimer = 0; pickupTimer = 8; wave = 1; cam.shake = 0; nextBossStageIdx = 0;
  // 相机初始对准玩家
  cam.followX = clamp(player.x - W / 2, 0, MAP_W - W);
  cam.followY = clamp(player.y - H / 2, 0, MAP_H - H);
  // 初始化陷阱（黑洞）：在地图上随机分布，避开出生点
  traps = [];
  const trapCount = 5;
  for (let i = 0; i < trapCount; i++) {
    let tx, ty, tries = 0;
    do {
      tx = rand(MAP_W * 0.15, MAP_W * 0.85);
      ty = rand(MAP_H * 0.15, MAP_H * 0.85);
      tries++;
    } while (dist2(tx, ty, player.x, player.y) < 400 * 400 && tries < 30);
    traps.push({ x: tx, y: ty, killR: 34, pullR: 135, spin: rand(0, TAU) });
  }
  for (let i = 0; i < 3; i++) spawnEnemy();
  for (const slot of EQUIP_SLOTS) equipment[slot] = null;
  for (const k in upgradeLevels) delete upgradeLevels[k];
  combo.count = 0; combo.timer = 0; combo.best = 0; timeScale = 1; slowMoTimer = 0; flashScreen = 0;
  goSubmitted = false; goRankEntry = null;
  applyEquipStats();
}

// ========== 敌人 ==========
const ENEMY_TYPES = {
  grunt: { r: 12, hp: 18, speed: 55, dmg: 8, xp: 1, color: '#ff5566', glow: '#ff3344', shape: 'blob', ai: 'chase' },
  runner: { r: 9, hp: 10, speed: 100, dmg: 6, xp: 1, color: '#ffa033', glow: '#ff7722', shape: 'spike', ai: 'chase' },
  brute: { r: 16, hp: 40, speed: 70, dmg: 12, xp: 2, color: '#ff3399', glow: '#ff1a88', shape: 'skull', ai: 'chase' },
  tank: { r: 20, hp: 70, speed: 35, dmg: 16, xp: 4, color: '#b066ff', glow: '#9933ff', shape: 'cube', ai: 'chase' },
  charger: { r: 11, hp: 24, speed: 60, dmg: 14, xp: 2, color: '#ff5522', glow: '#ff3300', shape: 'spike', ai: 'charge' },
  splitter: { r: 14, hp: 32, speed: 48, dmg: 8, xp: 2, color: '#66dd66', glow: '#33aa33', shape: 'blob', ai: 'split' },
  shooter: { r: 13, hp: 26, speed: 42, dmg: 6, xp: 2, color: '#cc66ff', glow: '#aa33ff', shape: 'skull', ai: 'shoot' },
  bomber: { r: 13, hp: 22, speed: 80, dmg: 18, xp: 2, color: '#ffcc33', glow: '#ffaa00', shape: 'cube', ai: 'bomb' },
};
function spawnEnemy(forceType) {
  // 在玩家屏幕视野外生成（相机视野边缘 + 一定缓冲）
  const margin = 60;
  const vx0 = cam.followX - margin, vy0 = cam.followY - margin;
  const vx1 = cam.followX + W + margin, vy1 = cam.followY + H + margin;
  const side = randi(0, 3); let x, y;
  if (side === 0) { x = rand(vx0, vx1); y = vy0; }
  else if (side === 1) { x = vx1; y = rand(vy0, vy1); }
  else if (side === 2) { x = rand(vx0, vx1); y = vy1; }
  else { x = vx0; y = rand(vy0, vy1); }
  // 限制在地图内
  x = clamp(x, 20, MAP_W - 20); y = clamp(y, 20, MAP_H - 20);
  let type = forceType || 'grunt'; const r = Math.random();
  if (!forceType) {
    if (time > 10 && r < 0.30) type = 'runner';
    if (time > 40 && r > 0.55 && r < 0.72) type = 'brute';
    if (time > 75 && r > 0.88 && r < 0.95) type = 'tank';
    if (time > 15 && r > 0.72 && r < 0.78) type = 'charger';
    if (time > 30 && r > 0.78 && r < 0.84) type = 'splitter';
    if (time > 45 && r > 0.84 && r < 0.88) type = 'shooter';
    if (time > 60 && r > 0.95 && r <= 1.0) type = 'bomber';
    if (time < 10) type = 'grunt';
  }
  const t = ENEMY_TYPES[type]; const hpScale = 1 + time / 60, dmgScale = 1 + time / 120;
  const elite = Math.floor(time / 30) > Math.floor((time - 1) / 30) && time > 20;
  const eliteMult = elite ? 2.5 : 1;
  enemies.push({ type, x, y, r: t.r * eliteMult, hp: t.hp * hpScale * eliteMult, maxHp: t.hp * hpScale * eliteMult,
    speed: t.speed, dmg: t.dmg * dmgScale, xp: t.xp * eliteMult,
    color: t.color, glow: t.glow, shape: t.shape, ai: t.ai, hitFlash: 0, slow: 0, spin: rand(0, TAU), elite,
    aiState: 0, aiTimer: rand(0.6, 1.4), dashVx: 0, dashVy: 0, fireTimer: rand(1, 2) });
}

// ========== Boss ==========
const BOSS_STAGES = [
  { time: 120, kind: 'elite', name: '影爪先锋', hp: 600, r: 34, speed: 55, dmg: 22, xp: 30, color: '#ff5a3c', glow: '#ff3a1c', dropRare: true, atkPattern: 'spread' },
  { time: 300, kind: 'ultimate', name: '暗魇君主', hp: 2200, r: 54, speed: 42, dmg: 34, xp: 80, color: '#b02dff', glow: '#9020ff', dropLegend: true, atkPattern: 'spiral' },
  { time: 480, kind: 'elite', name: '血翼执事', hp: 1100, r: 38, speed: 60, dmg: 28, xp: 50, color: '#ff2d55', glow: '#ff0044', dropRare: true, atkPattern: 'spread' },
  { time: 660, kind: 'ultimate', name: '永夜魔主', hp: 3800, r: 60, speed: 48, dmg: 42, xp: 120, color: '#ff2dff', glow: '#ff00cc', dropLegend: true, atkPattern: 'spiral' },
];
let nextBossStageIdx = 0;
function spawnBoss(stage) {
  const hpScale = 1 + time / 120;
  boss = {
    x: player.x, y: player.y - 260,
    hp: stage.hp * hpScale, maxHp: stage.hp * hpScale,
    r: stage.r, speed: stage.speed, dmg: stage.dmg, xp: stage.xp,
    color: stage.color, glow: stage.glow,
    hitFlash: 0, slow: 0, angle: 0, phase: 0, attackTimer: 1.5,
    title: stage.name, kind: stage.kind, atkPattern: stage.atkPattern,
    dropRare: !!stage.dropRare, dropLegend: !!stage.dropLegend,
  };
  floatText(W / 2, 100, '⚠ ' + stage.name + ' 降临 ⚠', stage.color);
  cam.shake = stage.kind === 'ultimate' ? 20 : 14;
  Audio.bossWarn();
  if (stage.kind === 'ultimate') flashScreen = 0.2;
}
function damageBoss(dmg) {
  boss.hp -= dmg * synergies.allDmgMult; boss.hitFlash = 0.1;
  spawnParticles(boss.x + rand(-10, 10), boss.y + rand(-10, 10), '#ff4d6d', 3, 80);
  if (boss.hp <= 0) killBoss();
}
function killBoss() {
  spawnParticles(boss.x, boss.y, '#ffd86b', 80, 500);
  particles.push({ kind: 'ring', x: boss.x, y: boss.y, r0: 10, r: 200, life: 0.9, max: 0.9, color: '#ffe27a' });
  particles.push({ kind: 'ring', x: boss.x, y: boss.y, r0: 10, r: 140, life: 0.7, max: 0.7, color: '#fff' });
  cam.shake = boss.kind === 'ultimate' ? 26 : 20;
  for (let i = 0; i < (boss.kind === 'ultimate' ? 18 : 10); i++) spawnGem(boss.x + rand(-30, 30), boss.y + rand(-30, 30), 3);
  gainXp(boss.xp); player.kills++;
  const dropN = boss.kind === 'ultimate' ? 4 : 2;
  for (let i = 0; i < dropN; i++) {
    const slot = EQUIP_SLOTS[randi(0, 3)]; let rarity;
    if (boss.dropLegend) rarity = (Math.random() < 0.6) ? 'legend' : 'epic';
    else if (boss.dropRare) rarity = (Math.random() < 0.5) ? 'epic' : (Math.random() < 0.6 ? 'rare' : 'legend');
    else rarity = pickRarityBoss();
    const eq = rollEquipment(slot, rarity);
    eqDrops.push({ ...eq, x: boss.x + rand(-50, 50), y: boss.y + rand(-50, 50), r: 14, life: 40, pulse: rand(0, TAU) });
  }
  if (boss.kind === 'ultimate') {
    pickups.push({ ...PICKUP_TYPES[0], x: boss.x, y: boss.y + 30, r: 14, life: 25, pulse: 0 });
    floatText(boss.x, boss.y - 30, '终极击破！传说装备掉落！', '#ffe27a');
  } else { floatText(player.x, player.y - 30, 'Boss 已击破！', '#ffe27a'); }
  const killedKind = boss.kind;
  boss = null; Audio.bossKill();
  flashScreen = killedKind === 'ultimate' ? 0.45 : 0.3;
  timeScale = 0.3; slowMoTimer = 0.5;
}

// ========== 粒子/浮字/宝石/拾取 ==========
function spawnParticles(x, y, color, n, spd) {
  for (let i = 0; i < n; i++) { const a = rand(0, TAU), s = rand(spd * 0.3, spd);
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.3, 0.7), max: 0.7, color, r: rand(1.5, 3.5) }); } }
function spawnSparks(x, y, color, n, spd) {
  for (let i = 0; i < n; i++) { const a = rand(0, TAU), s = rand(spd * 0.5, spd);
    const life = rand(0.2, 0.45);
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, r: rand(1, 2), kind: 'spark', rot: a, rotSpd: rand(-10, 10) }); } }
function spawnShards(x, y, color, n, spd) {
  for (let i = 0; i < n; i++) { const a = rand(0, TAU), s = rand(spd * 0.4, spd * 0.9);
    const life = rand(0.4, 0.8);
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, r: rand(2, 4), kind: 'shard', rot: rand(0, TAU), rotSpd: rand(-8, 8) }); } }
function spawnDeathBurst(x, y, color, r) {
  spawnShards(x, y, color, 6, r * 12); spawnSparks(x, y, color, 8, r * 15);
  particles.push({ kind: 'ring', x, y, r0: r * 0.3, r: r * 2.5, life: 0.35, max: 0.35, color, glow: true });
  particles.push({ kind: 'ring', x, y, r0: r * 0.2, r: r * 1.5, life: 0.25, max: 0.25, color, glow: true });
}
function floatText(x, y, txt, color) { floats.push({ x, y, txt, color, life: 0.9, max: 0.9 }); }
function spawnGem(x, y, value) { gems.push({ x, y, vx: rand(-30, 30), vy: rand(-30, 30), value, life: 30, pull: false }); }

const PICKUP_TYPES = [
  { kind: 'heal', icon: '✚', color: '#5dff9b', name: '医疗包', desc: '恢复 40 点生命' },
  { kind: 'magnet', icon: '⩕', color: '#4dd0ff', name: '磁铁', desc: '吸取全场经验宝石' },
  { kind: 'bomb', icon: '✺', color: '#ffaa33', name: '爆裂符', desc: '对全场敌人造成伤害' },
  { kind: 'chest', icon: '◆', color: '#ffe27a', name: '宝箱', desc: '获得大量经验' },
];
function spawnPickup() { const t = PICKUP_TYPES[randi(0, PICKUP_TYPES.length - 1)];
  pickups.push({ ...t, x: rand(cam.followX + 60, cam.followX + W - 60), y: rand(cam.followY + 100, cam.followY + H - 60), r: 14, life: 18, pulse: 0 }); }
function spawnPickupAt(x, y) {
  if (Math.random() < 0.18) {
    const slot = EQUIP_SLOTS[randi(0, 3)]; const rarity = pickRarity(); const eq = rollEquipment(slot, rarity);
    eqDrops.push({ ...eq, x: clamp(x, 30, MAP_W - 30), y: clamp(y, 30, MAP_H - 30), r: 14, life: 40, pulse: 0 }); return;
  }
  const t = PICKUP_TYPES[randi(0, PICKUP_TYPES.length - 1)];
  pickups.push({ ...t, x: clamp(x, 30, MAP_W - 30), y: clamp(y, 30, MAP_H - 30), r: 14, life: 15, pulse: 0 });
}

// ========== 升级池 ==========
const UPGRADES = [
  { id: 'bDmg', icon: '✦', name: '弹丸强化', desc: '暗夜弹伤害 +35%', apply: () => { skills.bullet.dmg *= 1.35; applyEquipStats(); }, maxLvl: 8, getLvl: () => skills.bullet.lvl },
  { id: 'bRate', icon: '⚡', name: '急速射击', desc: '暗夜弹射速 +20%', apply: () => { skills.bullet.cd *= 0.8; applyEquipStats(); }, maxLvl: 8, getLvl: () => 0 },
  { id: 'bCount', icon: '✲', name: '多重弹幕', desc: '暗夜弹数量 +1', apply: () => { skills.bullet.count++; skills.bullet.lvl++; }, maxLvl: 6, getLvl: () => skills.bullet.count - 1 },
  { id: 'bPierce', icon: '➳', name: '穿透弹头', desc: '暗夜弹穿透 +1', apply: () => { skills.bullet.pierce++; skills.bullet.lvl++; applyEquipStats(); }, maxLvl: 4, getLvl: () => skills.bullet.pierce },
  { id: 'oNew', icon: '◉', name: '护体光球', desc: '解锁环绕光球，撞击敌人', apply: () => { skills.orbit.count++; skills.orbit.lvl++; applyEquipStats(); }, maxLvl: 6, getLvl: () => skills.orbit.count },
  { id: 'oDmg', icon: '◎', name: '光球充能', desc: '光球伤害 +40%', apply: () => { skills.orbit.dmg *= 1.4; applyEquipStats(); }, maxLvl: 6, getLvl: () => skills.orbit.lvl },
  { id: 'aNew', icon: '⊙', name: '幽冥光环', desc: '解锁周身伤害光环', apply: () => { skills.aura.radius = 70; skills.aura.dps = 12; skills.aura.lvl++; applyEquipStats(); }, maxLvl: 5, getLvl: () => skills.aura.lvl },
  { id: 'aDmg', icon: '◌', name: '光环扩散', desc: '光环范围与伤害提升', apply: () => { skills.aura.radius += 18; skills.aura.dps *= 1.3; skills.aura.lvl++; applyEquipStats(); }, maxLvl: 5, getLvl: () => skills.aura.lvl },
  { id: 'cNew', icon: '⚡', name: '闪电链', desc: '解锁闪电链，在敌人之间跳跃', apply: () => { skills.chain.lvl++; skills.chain.timer = 0.5; }, maxLvl: 5, getLvl: () => skills.chain.lvl },
  { id: 'cUp', icon: '⚡', name: '雷劫', desc: '闪电链伤害+40%，目标+1，跳跃+1', apply: () => { skills.chain.dmg *= 1.4; skills.chain.targets++; skills.chain.bounce++; skills.chain.lvl++; }, maxLvl: 4, getLvl: () => skills.chain.lvl },
  { id: 'fNew', icon: '❄', name: '冰冻新星', desc: '周期性释放冰霜，减速敌人并爆炸', apply: () => { skills.frost.lvl++; skills.frost.radius = 110; skills.frost.timer = 2; }, maxLvl: 5, getLvl: () => skills.frost.lvl },
  { id: 'fUp', icon: '❄', name: '绝对零度', desc: '冰冻新星伤害+50%，范围+30', apply: () => { skills.frost.dmg *= 1.5; skills.frost.radius += 30; skills.frost.lvl++; }, maxLvl: 4, getLvl: () => skills.frost.lvl },
  { id: 'lNew', icon: '⟿', name: '激光束', desc: '前方持续激光扫射，高DPS', apply: () => { skills.laser.lvl++; }, maxLvl: 5, getLvl: () => skills.laser.lvl },
  { id: 'lUp', icon: '⟿', name: '歼灭光束', desc: '激光伤害+45%，宽度+6', apply: () => { skills.laser.dps *= 1.45; skills.laser.width += 6; skills.laser.lvl++; }, maxLvl: 4, getLvl: () => skills.laser.lvl },
  { id: 'mNew', icon: '✧', name: '回旋镖', desc: '掷出回旋镖，飞出后返回，多次命中', apply: () => { skills.boomerang.lvl++; }, maxLvl: 5, getLvl: () => skills.boomerang.lvl },
  { id: 'mUp', icon: '✧', name: '飞轮风暴', desc: '回旋镖伤害+40%，数量+1', apply: () => { skills.boomerang.dmg *= 1.4; skills.boomerang.count++; skills.boomerang.lvl++; applyEquipStats(); }, maxLvl: 4, getLvl: () => skills.boomerang.lvl },
  { id: 'pSpeed', icon: '⇶', name: '迅捷', desc: '战机移动速度 +12%', apply: () => { player.speed *= 1.12; }, maxLvl: 6, getLvl: () => 0 },
  { id: 'pHp', icon: '♥', name: '装甲强化', desc: '最大生命 +25 并回满', apply: () => { player.maxHp += 25; player.hp = player.maxHp; }, maxLvl: 8, getLvl: () => 0 },
  { id: 'pRange', icon: '◎', name: '吸取领域', desc: '经验拾取范围 +40%', apply: () => { player.pickupRange *= 1.4; }, maxLvl: 5, getLvl: () => 0 },
  { id: 'pRegen', icon: '✚', name: '纳米修复', desc: '每秒回复 1.5 点生命', apply: () => { player.regen += 1.5; }, maxLvl: 5, getLvl: () => 0 },
  { id: 'uUp', icon: '✺', name: '爆发核心', desc: '终极爆发伤害与范围提升，缩短CD', apply: () => { skills.ult.dmg += 25; skills.ult.radius += 25; skills.ult.cdMax = Math.max(10, skills.ult.cdMax - 2); }, maxLvl: 4, getLvl: () => 0 },
];
function availableUpgrades() { return UPGRADES.filter(u => (upgradeLevels[u.id] || 0) < u.maxLvl); }
function showLevelUp() {
  state = STATE.LEVELUP;
  const pool = availableUpgrades(); const choices = []; const tmp = pool.slice();
  for (let i = 0; i < 3 && tmp.length; i++) { const idx = randi(0, tmp.length - 1); choices.push(tmp.splice(idx, 1)[0]); }
  levelUpChoices = []; levelUpCardRects = [];
  // 横屏：3张卡片横排；竖屏：纵排
  const n = choices.length;
  const gap = 12;
  const cardW = IS_LANDSCAPE ? Math.min(W * 0.26, 230) : W * 0.82;
  const cardH = IS_LANDSCAPE ? Math.min(H * 0.68, 300) : H * 0.22;
  const totalW = n * cardW + (n - 1) * gap;
  const startX = (W - totalW) / 2;
  const startY = IS_LANDSCAPE ? H * 0.20 : H * 0.20;
  for (let i = 0; i < choices.length; i++) {
    const u = choices[i];
    const rarity = pickRarity(); const rm = RARITY[rarity].mult; const times = rm >= 3.5 ? 3 : rm >= 2.2 ? 2 : 1;
    const cx = startX + i * (cardW + gap);
    levelUpChoices.push({ upgrade: u, rarity, times });
    levelUpCardRects.push({ x: cx, y: startY, w: cardW, h: cardH, upgrade: u, rarity, times });
  }
}

// ========== 游戏逻辑更新 ==========
function update(dt) {
  if (slowMoTimer > 0) { slowMoTimer -= dt; if (slowMoTimer <= 0) timeScale = 1; }
  dt *= timeScale;
  updatePerf(dt);
  if (combo.timer > 0) { combo.timer -= dt; if (combo.timer <= 0) combo.count = 0; }
  if (flashScreen > 0) flashScreen -= dt * 2;
  time += dt;

  // 移动
  let mx = joystick.vec.x, my = joystick.vec.y;
  const ml = Math.hypot(mx, my);
  if (ml > 0.05) {
    mx /= Math.max(ml, 1); my /= Math.max(ml, 1);
    player.x += mx * player.speed * dt; player.y += my * player.speed * dt;
    const target = Math.atan2(my, mx); let d = target - player.facing;
    while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
    player.facing += d * Math.min(1, dt * 10);
  }
  player.x = clamp(player.x, player.r, MAP_W - player.r);
  player.y = clamp(player.y, player.r, MAP_H - player.r);
  if (player.invuln > 0) player.invuln -= dt;
  if (player.regen > 0 && player.hp < player.maxHp) player.hp = Math.min(player.maxHp, player.hp + player.regen * dt);

  // 技能CD
  if (skills.bullet.btnCd > 0) skills.bullet.btnCd = Math.max(0, skills.bullet.btnCd - dt);
  if (skills.orbit.burstCd > 0) skills.orbit.burstCd = Math.max(0, skills.orbit.burstCd - dt);
  if (skills.aura.novaCd > 0) skills.aura.novaCd = Math.max(0, skills.aura.novaCd - dt);
  if (skills.ult.cd > 0) skills.ult.cd = Math.max(0, skills.ult.cd - dt);

  // Boss 触发
  if (!boss && nextBossStageIdx < BOSS_STAGES.length) {
    const stage = BOSS_STAGES[nextBossStageIdx];
    if (time >= stage.time) { spawnBoss(stage); nextBossStageIdx++; }
  }

  // 敌人生成
  spawnTimer -= dt;
  const targetCount = Math.min(8 + Math.floor(time / 4) * 2, 90);
  const spawnInterval = Math.max(0.25, 0.6 - time / 100);
  if (spawnTimer <= 0 && enemies.length < targetCount) {
    const batch = 1 + Math.floor(time / 15);
    for (let i = 0; i < batch && enemies.length < targetCount; i++) spawnEnemy();
    spawnTimer = spawnInterval;
  }
  wave = 1 + Math.floor(time / 20);
  pickupTimer -= dt;
  if (pickupTimer <= 0) { spawnPickup(); pickupTimer = rand(12, 20); }

  // 1.暗夜弹
  const b = skills.bullet;
  if (b.lvl > 0) {
    b.timer -= dt;
    if (b.timer <= 0 && (enemies.length > 0 || boss)) {
      b.timer = b.cd;
      const best = findClosestEnemy(player.x, player.y);
      if (best) {
        const baseAng = Math.atan2(best.y - player.y, best.x - player.x);
        Audio.shoot(); spawnSparks(player.x, player.y, '#8affd6', 3, 100);
        for (let i = 0; i < b.count; i++) { const off = (i - (b.count - 1) / 2) * b.spread; const a = baseAng + off;
          bullets.push({ x: player.x, y: player.y, r: 5, vx: Math.cos(a) * b.speed, vy: Math.sin(a) * b.speed,
            dmg: b.dmg, pierce: b.pierce + synergies.bulletPierceBonus, hit: new Set(), life: 1.6, color: '#8affd6' }); }
      }
    }
  }
  // 2.护体光球
  const o = skills.orbit;
  if (o.count > 0) {
    o.angle += o.speed * dt;
    for (let i = 0; i < enemies.length; i++) { const e = enemies[i];
      for (let k = 0; k < o.count; k++) {
        const a = o.angle + (k / o.count) * TAU; const ox = player.x + Math.cos(a) * o.radius, oy = player.y + Math.sin(a) * o.radius;
        if (dist2(ox, oy, e.x, e.y) < (12 + e.r) ** 2) { const key = i + '_' + k; if (!o.hitCd[key] || o.hitCd[key] <= 0) { damageEnemy(e, o.dmg, i); o.hitCd[key] = 0.5; } } } }
    if (boss) for (let k = 0; k < o.count; k++) {
      const a = o.angle + (k / o.count) * TAU; const ox = player.x + Math.cos(a) * o.radius, oy = player.y + Math.sin(a) * o.radius;
      if (dist2(ox, oy, boss.x, boss.y) < (12 + boss.r) ** 2) { const key = 'B_' + k; if (!o.hitCd[key] || o.hitCd[key] <= 0) { damageBoss(o.dmg * 0.6); o.hitCd[key] = 0.5; } } }
    for (const k in o.hitCd) { o.hitCd[k] -= dt; if (o.hitCd[k] <= 0) delete o.hitCd[k]; }
  }
  // 3.光环
  const au = skills.aura;
  if (au.radius > 0) {
    au.tick -= dt;
    if (au.tick <= 0) { au.tick = 0.4; const r2 = au.radius * au.radius;
      for (let i = 0; i < enemies.length; i++) { const e = enemies[i]; if (dist2(e.x, e.y, player.x, player.y) < r2) damageEnemy(e, au.dps * 0.4, i, false); }
      if (boss && dist2(boss.x, boss.y, player.x, player.y) < r2) damageBoss(au.dps * 0.4); }
  }
  // 4.闪电链
  const ch = skills.chain;
  if (ch.lvl > 0) {
    ch.timer -= dt;
    if (ch.timer <= 0 && (enemies.length > 0 || boss)) {
      ch.timer = ch.cd;
      const first = findClosestEnemy(player.x, player.y);
      if (first) {
        const hitList = []; let cur = first; const used = new Set();
        for (let i = 0; i < ch.targets && cur; i++) {
          hitList.push(cur); used.add(cur); let next = null, bd = Infinity;
          for (const e of enemies) { if (used.has(e)) continue; const d = dist2(e.x, e.y, cur.x, cur.y); if (d < bd && d < 180 * 180 + ch.bounce * 60 * 60) { bd = d; next = e; } }
          cur = next;
        }
        if (boss && !used.has(boss)) {
          const dLast = hitList.length ? dist2(boss.x, boss.y, hitList[hitList.length - 1].x, hitList[hitList.length - 1].y) : dist2(boss.x, boss.y, player.x, player.y);
          if (dLast < 240 * 240) hitList.push(boss);
        }
        for (let i = 0; i < hitList.length; i++) { const tgt = hitList[i]; const dmg = ch.dmg * Math.pow(0.78, i);
          if (tgt === boss) damageBoss(dmg); else { const idx = enemies.indexOf(tgt); if (idx >= 0) damageEnemy(tgt, dmg, idx); } }
        const pts = [{ x: player.x, y: player.y }]; for (const t of hitList) pts.push({ x: t.x, y: t.y });
        chains.push({ pts, life: 0.28, max: 0.28 }); Audio.chain();
      }
    }
  }
  // 5.冰冻
  const fr = skills.frost;
  if (fr.lvl > 0) {
    fr.timer -= dt;
    if (fr.timer <= 0) { fr.timer = fr.cd; const r2 = fr.radius * fr.radius;
      for (let i = enemies.length - 1; i >= 0; i--) { const e = enemies[i]; if (dist2(e.x, e.y, player.x, player.y) < r2) { damageEnemy(e, fr.dmg, i); e.slow = Math.max(e.slow, fr.slowDur); } }
      if (boss && dist2(boss.x, boss.y, player.x, player.y) < r2) { damageBoss(fr.dmg * 0.6); boss.slow = Math.max(boss.slow || 0, fr.slowDur * 0.5); }
      frosts.push({ x: player.x, y: player.y, r0: 10, r: fr.radius, life: 0.5, max: 0.5 });
      spawnParticles(player.x, player.y, '#9fd6ff', 26, 220); Audio.frost();
    }
  }
  // 6.激光
  const la = skills.laser;
  if (la.lvl > 0) {
    const tgt = findClosestEnemy(player.x, player.y);
    const targetAng = tgt ? Math.atan2(tgt.y - player.y, tgt.x - player.x) : player.facing;
    let d = targetAng - la.angle; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
    la.angle += d * Math.min(1, dt * 4);
    la.tickTimer -= dt;
    if (la.tickTimer <= 0) { la.tickTimer = 0.1;
      const cx = player.x, cy = player.y, a = la.angle, reach = 640;
      const endX = cx + Math.cos(a) * reach, endY = cy + Math.sin(a) * reach;
      for (let i = 0; i < enemies.length; i++) { const e = enemies[i]; if (pointToSegDist(e.x, e.y, cx, cy, endX, endY) < la.width / 2 + e.r) damageEnemy(e, la.dps * 0.1, i, false); }
      if (boss && pointToSegDist(boss.x, boss.y, cx, cy, endX, endY) < la.width / 2 + boss.r) damageBoss(la.dps * 0.07);
    }
    lasers.push({ x1: player.x, y1: player.y, a: la.angle, w: la.width, life: 0.06, max: 0.06 });
  }
  // 7.回旋镖
  const bm = skills.boomerang;
  if (bm.lvl > 0) {
    bm.timer -= dt;
    if (bm.timer <= 0 && (enemies.length > 0 || boss)) {
      bm.timer = bm.cd;
      const tgt = findClosestEnemy(player.x, player.y);
      const baseAng = tgt ? Math.atan2(tgt.y - player.y, tgt.x - player.x) : player.facing;
      for (let i = 0; i < bm.count; i++) { const ang = baseAng + (i - (bm.count - 1) / 2) * 0.35;
        boomerangs.push({ x: player.x, y: player.y, ox: player.x, oy: player.y,
          vx: Math.cos(ang) * bm.speed, vy: Math.sin(ang) * bm.speed,
          t: 0, maxT: 0.9, r: 10, dmg: bm.dmg, pierce: bm.pierce, hit: new Set(), color: '#ffd86b', angle: 0 }); }
    }
  }
  // 子弹
  for (let i = bullets.length - 1; i >= 0; i--) { const bl = bullets[i];
    bl.x += bl.vx * dt; bl.y += bl.vy * dt; bl.life -= dt;
    if (Math.random() < 0.5) particles.push({ x: bl.x + rand(-2, 2), y: bl.y + rand(-2, 2), vx: rand(-15, 15), vy: rand(-15, 15), life: 0.2, max: 0.2, color: bl.color, r: rand(0.8, 1.5) });
    if (bl.life <= 0 || bl.x < cam.followX - 20 || bl.x > cam.followX + W + 20 || bl.y < cam.followY - 20 || bl.y > cam.followY + H + 20) { bullets.splice(i, 1); continue; }
    let consumed = false;
    for (let j = 0; j < enemies.length; j++) { const e = enemies[j]; if (bl.hit.has(e)) continue;
      if (dist2(bl.x, bl.y, e.x, e.y) < (bl.r + e.r) ** 2) { damageEnemy(e, bl.dmg, j); bl.hit.add(e);
        spawnSparks(e.x, e.y, bl.color, 4, 180);
        if (bl.pierce <= 0) { bullets.splice(i, 1); consumed = true; break; } bl.pierce--; } }
    if (consumed) continue;
    if (boss && !bl.hit.has(boss) && dist2(bl.x, bl.y, boss.x, boss.y) < (bl.r + boss.r) ** 2) {
      damageBoss(bl.dmg); bl.hit.add(boss); spawnSparks(boss.x, boss.y, bl.color, 4, 180);
      if (bl.pierce <= 0) bullets.splice(i, 1); else bl.pierce--;
    }
  }
  // 回旋镖
  for (let i = boomerangs.length - 1; i >= 0; i--) { const b1 = boomerangs[i];
    b1.t += dt; b1.angle += 10 * dt;
    if (b1.t < b1.maxT) { b1.x += b1.vx * dt; b1.y += b1.vy * dt; b1.vx *= 0.985; b1.vy *= 0.985; }
    else { const dx = player.x - b1.x, dy = player.y - b1.y; const d = Math.hypot(dx, dy) || 1;
      const sp = b1.t < b1.maxT + 0.2 ? 240 : 480;
      b1.x += dx / d * sp * dt; b1.y += dy / d * sp * dt;
      if (d < player.r + 8) { boomerangs.splice(i, 1); continue; } }
    for (let j = 0; j < enemies.length; j++) { const e = enemies[j]; if (b1.hit.has(e)) continue;
      if (dist2(b1.x, b1.y, e.x, e.y) < (b1.r + e.r) ** 2) { damageEnemy(e, b1.dmg, j); b1.hit.add(e); } }
    if (boss && !b1.hit.has(boss) && dist2(b1.x, b1.y, boss.x, boss.y) < (b1.r + boss.r) ** 2) { damageBoss(b1.dmg * 0.7); b1.hit.add(boss); }
  }
  for (let i = chains.length - 1; i >= 0; i--) { chains[i].life -= dt; if (chains[i].life <= 0) chains.splice(i, 1); }
  for (let i = lasers.length - 1; i >= 0; i--) { lasers[i].life -= dt; if (lasers[i].life <= 0) lasers.splice(i, 1); }
  for (let i = frosts.length - 1; i >= 0; i--) { frosts[i].life -= dt; if (frosts[i].life <= 0) frosts.splice(i, 1); }

  // 敌人 AI
  for (let i = enemies.length - 1; i >= 0; i--) { const e = enemies[i];
    if (e.hitFlash > 0) e.hitFlash -= dt;
    if (e.slow > 0) e.slow -= dt;
    e.spin += dt * (e.type === 'runner' ? 3.5 : e.type === 'charger' ? 2.8 : 1.5);
    const ang = Math.atan2(player.y - e.y, player.x - e.x);
    const sp = e.speed * (e.slow > 0 ? 0.5 : 1);
    const d2p = dist2(e.x, e.y, player.x, player.y);
    let moveX = Math.cos(ang), moveY = Math.sin(ang);
    if (e.ai === 'charge') {
      e.aiTimer -= dt;
      if (e.aiState === 0) { if (d2p < 280 * 280) { e.aiState = 1; e.aiTimer = 0.7; } }
      else if (e.aiState === 1) { moveX = 0; moveY = 0; if (Math.floor(time * 10) % 2 === 0) e.hitFlash = Math.max(e.hitFlash, 0.05);
        if (e.aiTimer <= 0) { e.aiState = 2; e.aiTimer = 0.45; e.dashVx = Math.cos(ang) * sp * 4.5; e.dashVy = Math.sin(ang) * sp * 4.5; Audio.chain(); } }
      else if (e.aiState === 2) { moveX = e.dashVx / sp; moveY = e.dashVy / sp; if (e.aiTimer <= 0) { e.aiState = 3; e.aiTimer = 1.2; e.dashVx = 0; e.dashVy = 0; } }
      else { if (e.aiTimer <= 0) { e.aiState = 0; e.aiTimer = rand(0.4, 1.0); } moveX *= 0.3; moveY *= 0.3; }
    } else if (e.ai === 'shoot') {
      const desired = 220;
      if (d2p > (desired + 30) * (desired + 30)) { moveX = Math.cos(ang); moveY = Math.sin(ang); }
      else if (d2p < (desired - 30) * (desired - 30)) { moveX = -Math.cos(ang); moveY = -Math.sin(ang); }
      else { moveX *= 0.2; moveY *= 0.2; }
      moveX += Math.cos(ang + Math.PI / 2) * 0.4 * Math.sin(time * 1.5 + i);
      moveY += Math.sin(ang + Math.PI / 2) * 0.4 * Math.sin(time * 1.5 + i);
      e.fireTimer -= dt;
      if (e.fireTimer <= 0 && d2p < 360 * 360) {
        e.fireTimer = rand(1.8, 2.6); const fa = Math.atan2(player.y - e.y, player.x - e.x); const fsp = 220;
        particles.push({ kind: 'enemyShot', x: e.x, y: e.y, vx: Math.cos(fa) * fsp, vy: Math.sin(fa) * fsp, r: 6, life: 3.0, max: 3.0, color: '#cc66ff', dmg: e.dmg * (1 - player.damageReduction) });
        Audio.shoot();
      }
    } else if (e.ai === 'bomb') {
      if (d2p < 90 * 90) {
        e.aiTimer -= dt;
        if (e.aiState === 0) { e.aiState = 1; e.aiTimer = 0.8; }
        if (e.aiState === 1) { moveX = 0; moveY = 0; if (Math.floor(time * 12) % 2 === 0) e.hitFlash = Math.max(e.hitFlash, 0.06);
          if (e.aiTimer <= 0) { const explosionR = 70;
            if (player.invuln <= 0 && dist2(e.x, e.y, player.x, player.y) < explosionR * explosionR) { const realDmg = e.dmg * 1.5 * (1 - player.damageReduction); player.hp -= realDmg; player.invuln = 0.5; cam.shake = 10; spawnParticles(player.x, player.y, '#ff4d6d', 10, 200); }
            spawnDeathBurst(e.x, e.y, '#ffaa33', explosionR * 0.6);
            particles.push({ kind: 'ring', x: e.x, y: e.y, r0: 10, r: explosionR, life: 0.45, max: 0.45, color: '#ffcc33', glow: true });
            spawnParticles(e.x, e.y, '#ffcc33', 20, 260); Audio.ult(); cam.shake = Math.max(cam.shake, 8);
            if (player.hp <= 0) { player.hp = 0; gameOver(); return; }
            enemies.splice(i, 1); continue;
          }
        }
      } else { moveX *= 1.4; moveY *= 1.4; }
    }
    e.x += moveX * sp * dt; e.y += moveY * sp * dt;
    if (player.invuln <= 0 && dist2(e.x, e.y, player.x, player.y) < (e.r + player.r) ** 2) {
      const realDmg = e.dmg * (1 - player.damageReduction);
      player.hp -= realDmg; player.invuln = 0.6; cam.shake = 8; Audio.hurt();
      spawnParticles(player.x, player.y, '#ff4d6d', 8, 160);
      if (player.hp <= 0) { player.hp = 0; gameOver(); return; }
    }
  }
  // Boss
  if (boss) {
    if (boss.hitFlash > 0) boss.hitFlash -= dt;
    if (boss.slow > 0) boss.slow -= dt;
    boss.angle += dt * 0.8;
    // Boss 在玩家附近徘徊
    const dest = { x: player.x + Math.sin(time * 0.5) * 180, y: player.y - 160 + Math.cos(time * 0.3) * 50 };
    const dx = dest.x - boss.x, dy = dest.y - boss.y; const d = Math.hypot(dx, dy) || 1;
    const sp = boss.speed * (boss.slow > 0 ? 0.6 : 1);
    boss.x += dx / d * Math.min(sp * dt, d); boss.y += dy / d * Math.min(sp * dt, d);
    if (player.invuln <= 0 && dist2(boss.x, boss.y, player.x, player.y) < (boss.r + player.r) ** 2) {
      const realDmg = boss.dmg * (1 - player.damageReduction);
      player.hp -= realDmg; player.invuln = 0.8; cam.shake = 14;
      spawnParticles(player.x, player.y, '#ff4d6d', 14, 220);
      if (player.hp <= 0) { player.hp = 0; gameOver(); return; }
    }
    boss.attackTimer -= dt;
    if (boss.pendingWaves) {
      for (let i = boss.pendingWaves.length - 1; i >= 0; i--) {
        const w = boss.pendingWaves[i]; w.t -= dt;
        if (w.t <= 0) { const off = w.idx * (Math.PI / w.n);
          for (let k = 0; k < w.n; k++) { const a = (k / w.n) * TAU + off;
            particles.push({ kind: 'enemyShot', x: boss.x, y: boss.y, vx: Math.cos(a) * 220, vy: Math.sin(a) * 220, r: 7, life: 3.5, max: 3.5, color: boss.color, dmg: boss.dmg * 0.4 * (1 - player.damageReduction) }); }
          Audio.shoot(); boss.pendingWaves.splice(i, 1);
        }
      }
    }
    if (boss.attackTimer <= 0 && boss.y > 80) {
      if (boss.atkPattern === 'spiral') {
        boss.attackTimer = boss.kind === 'ultimate' ? 1.8 : 2.2;
        if (!boss.pendingWaves) boss.pendingWaves = [];
        const waves = 3, n = 8;
        for (let w = 0; w < waves; w++) boss.pendingWaves.push({ idx: w, n, t: w * 0.18 });
      } else {
        boss.attackTimer = 2.2; const n = 10;
        const baseAng = Math.atan2(player.y - boss.y, player.x - boss.x);
        for (let i = 0; i < n; i++) { const a = baseAng + (i - (n - 1) / 2) * 0.18;
          particles.push({ kind: 'enemyShot', x: boss.x, y: boss.y, vx: Math.cos(a) * 260, vy: Math.sin(a) * 260, r: 7, life: 3.0, max: 3.0, color: '#ff4d6d', dmg: 10 * (1 - player.damageReduction) }); }
      }
    }
  }
  // 宝石
  for (let i = gems.length - 1; i >= 0; i--) { const g = gems[i]; g.life -= dt;
    if (g.life <= 0) { gems.splice(i, 1); continue; }
    const d2 = dist2(g.x, g.y, player.x, player.y); const pr = player.pickupRange;
    if (g.pull || d2 < pr * pr) { g.pull = true; const ang = Math.atan2(player.y - g.y, player.x - g.x);
      g.x += Math.cos(ang) * 260 * dt; g.y += Math.sin(ang) * 260 * dt; }
    else { g.x += g.vx * dt; g.y += g.vy * dt; g.vx *= 0.92; g.vy *= 0.92; }
    if (d2 < (player.r + 8) ** 2) { gainXp(g.value); gems.splice(i, 1); }
  }
  // 拾取物
  for (let i = pickups.length - 1; i >= 0; i--) { const p = pickups[i]; p.life -= dt; p.pulse += dt;
    if (p.life <= 0) { pickups.splice(i, 1); continue; }
    if (dist2(p.x, p.y, player.x, player.y) < (p.r + player.r) ** 2) { applyPickup(p); pickups.splice(i, 1); }
  }
  // 装备掉落
  for (let i = eqDrops.length - 1; i >= 0; i--) { const eq = eqDrops[i]; eq.life -= dt; eq.pulse += dt;
    if (eq.life <= 0) { eqDrops.splice(i, 1); continue; }
    if (dist2(eq.x, eq.y, player.x, player.y) < (eq.r + player.r + 8) ** 2) { pickupEquipment(eq); eqDrops.splice(i, 1); }
  }
  // 粒子 + 敌弹
  for (let i = particles.length - 1; i >= 0; i--) { const p = particles[i];
    if (p.kind === 'ring') { p.life -= dt; if (p.life <= 0) particles.splice(i, 1); }
    else if (p.kind === 'enemyShot') {
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life <= 0 || p.x < cam.followX - 30 || p.x > cam.followX + W + 30 || p.y < cam.followY - 30 || p.y > cam.followY + H + 30) { particles.splice(i, 1); continue; }
      if (player.invuln <= 0 && dist2(p.x, p.y, player.x, player.y) < (p.r + player.r) ** 2) {
        player.hp -= p.dmg; player.invuln = 0.5; cam.shake = 6;
        spawnParticles(player.x, player.y, '#ff4d6d', 6, 140); particles.splice(i, 1);
        if (player.hp <= 0) { player.hp = 0; gameOver(); return; }
      }
    } else { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; p.life -= dt; if (p.life <= 0) particles.splice(i, 1); }
  }
  // 浮字
  for (let i = floats.length - 1; i >= 0; i--) { const f = floats[i]; f.y -= 30 * dt; f.life -= dt; if (f.life <= 0) floats.splice(i, 1); }
  if (cam.shake > 0) cam.shake -= dt * 30;

  // ===== 陷阱（黑洞）效果 =====
  for (const tr of traps) {
    const dx = tr.x - player.x, dy = tr.y - player.y;
    const d = Math.hypot(dx, dy) || 1;
    // 引力区：缓慢吸引玩家
    if (d < tr.pullR && d > tr.killR) {
      const pull = (1 - d / tr.pullR) * 60;
      player.x += dx / d * pull * dt; player.y += dy / d * pull * dt;
    }
    // 致命区：大掉血
    if (d < tr.killR && player.invuln <= 0) {
      player.hp -= 25; player.invuln = 0.6; cam.shake = 12; Audio.hurt();
      spawnParticles(player.x, player.y, '#b066ff', 12, 200);
      if (player.hp <= 0) { player.hp = 0; gameOver(); return; }
    }
    // 吸引并吞噬敌人
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      const ed = Math.hypot(tr.x - e.x, tr.y - e.y) || 1;
      if (ed < tr.pullR) { e.x += (tr.x - e.x) / ed * 40 * dt; e.y += (tr.y - e.y) / ed * 40 * dt; }
      if (ed < tr.killR) { spawnDeathBurst(e.x, e.y, e.color, e.r); enemies.splice(i, 1); }
    }
  }

  // ===== 相机跟随玩家（屏幕中心）=====
  const targetCX = clamp(player.x - W / 2, 0, MAP_W - W);
  const targetCY = clamp(player.y - H / 2, 0, MAP_H - H);
  cam.followX += (targetCX - cam.followX) * Math.min(1, dt * 8);
  cam.followY += (targetCY - cam.followY) * Math.min(1, dt * 8);
}
function findClosestEnemy(x, y) {
  let best = boss, bd = boss ? dist2(boss.x, boss.y, x, y) : Infinity;
  for (const e of enemies) { const d = dist2(e.x, e.y, x, y); if (d < bd) { bd = d; best = e; } }
  return best;
}
function pointToSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1; const l2 = dx * dx + dy * dy; if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2; t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function damageEnemy(e, dmg, idx, showNum) {
  e.hp -= dmg * synergies.allDmgMult; e.hitFlash = 0.1; Audio.hit();
  if (showNum !== false) floatText(e.x, e.y - e.r - 4, Math.round(dmg), '#fff');
  if (e.hp <= 0) killEnemy(e, idx);
}
function killEnemy(e, idx) {
  spawnDeathBurst(e.x, e.y, e.color, e.r); spawnGem(e.x, e.y, e.xp); player.kills++;
  comboKill(e.x, e.y); Audio.kill();
  if (e.elite) { spawnSparks(e.x, e.y, '#ffe27a', 12, 320); floatText(e.x, e.y - 20, '精英击破!', '#ffe27a'); }
  if (Math.random() < 0.05) spawnPickupAt(e.x, e.y);
  if (e.ai === 'split' && !e.split) {
    for (let k = 0; k < 2; k++) {
      const t = ENEMY_TYPES.grunt; const ang = rand(0, TAU);
      enemies.push({ type: 'grunt', x: e.x + Math.cos(ang) * 8, y: e.y + Math.sin(ang) * 8, r: e.r * 0.55,
        hp: t.hp * 0.5, maxHp: t.hp * 0.5, speed: t.speed * 1.2, dmg: t.dmg * 0.6, xp: 1,
        color: '#99ee99', glow: '#66cc66', shape: 'blob', ai: 'chase', hitFlash: 0, slow: 0, spin: rand(0, TAU), elite: false,
        aiState: 0, aiTimer: rand(0.4, 0.8), dashVx: 0, dashVy: 0, fireTimer: 1, split: true });
    }
    floatText(e.x, e.y - 20, '分裂!', '#66dd66');
  }
  enemies.splice(idx, 1);
}
function applyPickup(p) {
  floatText(player.x, player.y - 20, p.name, p.color); spawnParticles(p.x, p.y, p.color, 16, 220); Audio.pickup();
  if (p.kind === 'heal') player.hp = Math.min(player.maxHp, player.hp + 40);
  else if (p.kind === 'magnet') for (const g of gems) g.pull = true;
  else if (p.kind === 'bomb') { cam.shake = 14; for (let i = enemies.length - 1; i >= 0; i--) damageEnemy(enemies[i], 40 + time * 0.5, i);
    if (boss) damageBoss(40 + time * 0.5); spawnParticles(player.x, player.y, '#ffaa33', 30, 300); Audio.ult(); }
  else if (p.kind === 'chest') for (let i = 0; i < 6; i++) spawnGem(player.x + rand(-20, 20), player.y + rand(-20, 20), 2);
}
function gainXp(v) {
  player.xp += v * player.xpMult;
  while (player.xp >= player.xpNext) {
    player.xp -= player.xpNext; player.level++;
    player.xpNext = Math.floor(5 + player.level * 3 + player.level * player.level * 0.5);
    spawnParticles(player.x, player.y, '#8affd6', 20, 200); Audio.levelup(); showLevelUp(); return;
  }
}
function gameOver() {
  state = STATE.OVER;
  // 自动提交上榜（取最高分）
  goRankEntry = submitScore();
  goSubmitted = true;
}

// ========== 世界渲染 ==========
function drawBackground() {
  // 大地图底色（地图范围铺底）
  ctx.fillStyle = '#04050a';
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  // 地图边界发光（区分可活动区域）
  ctx.strokeStyle = 'rgba(77,208,255,0.25)'; ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, MAP_W, MAP_H);
  ctx.strokeStyle = 'rgba(138,255,214,0.12)'; ctx.lineWidth = 1.5;
  ctx.setLineDash([16, 12]);
  ctx.strokeRect(8, 8, MAP_W - 16, MAP_H - 16);
  ctx.setLineDash([]);
  // 网格纹理（让移动有参照感）
  ctx.strokeStyle = 'rgba(77,140,200,0.06)'; ctx.lineWidth = 1;
  const grid = 120;
  const vx0 = cam.followX, vy0 = cam.followY;
  const gx0 = Math.floor(vx0 / grid) * grid, gy0 = Math.floor(vy0 / grid) * grid;
  for (let x = gx0; x < vx0 + W + grid; x += grid) {
    ctx.beginPath(); ctx.moveTo(x, Math.max(0, vy0 - grid)); ctx.lineTo(x, Math.min(MAP_H, vy0 + H + grid)); ctx.stroke();
  }
  for (let y = gy0; y < vy0 + H + grid; y += grid) {
    ctx.beginPath(); ctx.moveTo(Math.max(0, vx0 - grid), y); ctx.lineTo(Math.min(MAP_W, vx0 + W + grid), y); ctx.stroke();
  }
  // 玩家附近环境光
  const g = ctx.createRadialGradient(player.x, player.y, 40, player.x, player.y, Math.max(W, H) * 0.7);
  g.addColorStop(0, 'rgba(30,40,70,0.6)'); g.addColorStop(0.6, 'rgba(10,14,28,0.3)'); g.addColorStop(1, 'rgba(4,5,10,0)');
  ctx.fillStyle = g; ctx.fillRect(vx0 - 50, vy0 - 50, W + 100, H + 100);
  // 视差星层（屏幕坐标，但跟随相机）
  for (let i = 0; i < starLayers.length; i++) {
    const layer = starLayers[i];
    const parallax = (i + 1) * 0.04;
    let ox = -cam.followX * parallax, oy = -cam.followY * parallax;
    ox = ((ox % W) + W) % W - W + cam.followX; oy = ((oy % H) + H) % H - H + cam.followY;
    ctx.globalAlpha = 0.5 - i * 0.1;
    ctx.drawImage(layer, ox, oy); ctx.drawImage(layer, ox + W, oy);
    ctx.drawImage(layer, ox, oy + H); ctx.drawImage(layer, ox + W, oy + H);
  }
  ctx.globalAlpha = 1;
  // 飘动光晕（跟随相机视野）
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const t = time * 0.06 + i * 2.1;
    const fx = cam.followX + W * 0.5 + Math.sin(t) * W * 0.35;
    const fy = cam.followY + H * 0.4 + Math.cos(t * 0.7) * H * 0.3;
    const cols = ['rgba(77,140,255,0.05)', 'rgba(176,80,255,0.04)', 'rgba(255,140,80,0.04)'][i];
    const rad = Math.max(W, H) * 0.35;
    const fg = ctx.createRadialGradient(fx, fy, 0, fx, fy, rad);
    fg.addColorStop(0, cols); fg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fg; ctx.fillRect(cam.followX - 50, cam.followY - 50, W + 100, H + 100);
  }
  ctx.restore();
  // 视野暗角
  const vg = ctx.createRadialGradient(cam.followX + W / 2, cam.followY + H / 2, Math.min(W, H) * 0.35, cam.followX + W / 2, cam.followY + H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg; ctx.fillRect(cam.followX - 50, cam.followY - 50, W + 100, H + 100);
}

// ========== 陷阱渲染（黑洞）—— 高对比危险标识 ==========
function drawTrap(tr) {
  tr.spin += 0.04;
  // 玩家是否在引力区内：在区内则警告更急促（脉动加快）
  const pd = Math.hypot(tr.x - player.x, tr.y - player.y);
  const inDanger = pd < tr.pullR;
  const pulse = 0.5 + 0.5 * Math.sin(time * (inDanger ? 12 : 6));
  // 1) 危险区域填充：暗红渐变（红色=危险直觉，替代原紫色）
  const pg = ctx.createRadialGradient(tr.x, tr.y, tr.killR * 0.6, tr.x, tr.y, tr.pullR);
  pg.addColorStop(0, `rgba(255,60,90,${0.22 + pulse * 0.10})`);
  pg.addColorStop(0.55, 'rgba(180,30,70,0.10)');
  pg.addColorStop(1, 'rgba(80,10,30,0)');
  ctx.fillStyle = pg;
  ctx.beginPath(); ctx.arc(tr.x, tr.y, tr.pullR, 0, TAU); ctx.fill();
  // 2) 外圈脉动警告环（明亮红色，最关键的易读性元素）
  ctx.save();
  ctx.lineWidth = 2.5 + pulse * 1.5;
  ctx.strokeStyle = `rgba(255,80,110,${0.55 + pulse * 0.40})`;
  ctx.shadowColor = '#ff5078'; ctx.shadowBlur = 12 + pulse * 10;
  ctx.beginPath(); ctx.arc(tr.x, tr.y, tr.pullR, 0, TAU); ctx.stroke();
  ctx.restore();
  // 3) 危险条纹（黄黑斜纹围绕外环，工业警告标识）
  ctx.save();
  ctx.translate(tr.x, tr.y); ctx.rotate(tr.spin * 0.5);
  const stripeN = 16;
  for (let i = 0; i < stripeN; i++) {
    const a0 = (i / stripeN) * TAU, a1 = a0 + TAU / stripeN * 0.5;
    ctx.beginPath();
    ctx.arc(0, 0, tr.pullR - 4, a0, a1);
    ctx.arc(0, 0, tr.pullR - 11, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,200,60,0.55)' : 'rgba(40,20,10,0.5)';
    ctx.fill();
  }
  ctx.restore();
  // 4) 旋转吸积盘（红紫色调，强化"吞噬"感）
  ctx.save();
  ctx.translate(tr.x, tr.y); ctx.rotate(tr.spin);
  for (let i = 0; i < 4; i++) {
    ctx.rotate(TAU / 4);
    ctx.strokeStyle = `rgba(255,120,160,${0.55 - i * 0.10})`; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, tr.killR + 7 + i * 5, 0, Math.PI * 1.3); ctx.stroke();
  }
  ctx.restore();
  // 5) 黑洞核心（纯黑 + 红色致命边缘高光）
  const cg = ctx.createRadialGradient(tr.x, tr.y, 0, tr.x, tr.y, tr.killR);
  cg.addColorStop(0, 'rgba(0,0,0,1)');
  cg.addColorStop(0.65, 'rgba(15,3,30,1)');
  cg.addColorStop(1, 'rgba(120,20,50,0.85)');
  ctx.fillStyle = cg;
  ctx.beginPath(); ctx.arc(tr.x, tr.y, tr.killR, 0, TAU); ctx.fill();
  // 核心边缘：脉动红光（致命区清晰可辨）
  ctx.save();
  ctx.lineWidth = 2.5 + pulse * 1.5;
  ctx.strokeStyle = `rgba(255,90,120,${0.8 + pulse * 0.2})`;
  ctx.shadowColor = '#ff5078'; ctx.shadowBlur = 14 + pulse * 8;
  ctx.beginPath(); ctx.arc(tr.x, tr.y, tr.killR, 0, TAU); ctx.stroke();
  ctx.restore();
  // 6) 顶部危险标识（⚠ 脉动），远距离也能识别
  ctx.save();
  ctx.font = `bold ${18 + pulse * 4}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(255,210,80,${0.85 + pulse * 0.15})`;
  ctx.shadowColor = '#ff8a00'; ctx.shadowBlur = 10 + pulse * 6;
  ctx.fillText('⚠', tr.x, tr.y - tr.pullR - 14 - pulse * 3);
  ctx.restore();
}

function drawPlayer() {
  ctx.save();
  if (skills.aura.radius > 0) { ctx.beginPath(); ctx.arc(player.x, player.y, skills.aura.radius, 0, TAU);
    ctx.fillStyle = 'rgba(176,102,255,0.10)'; ctx.fill();
    ctx.strokeStyle = 'rgba(176,102,255,0.35)'; ctx.lineWidth = 1.5; ctx.stroke(); }
  ctx.beginPath(); ctx.arc(player.x, player.y, player.pickupRange, 0, TAU);
  ctx.strokeStyle = 'rgba(138,255,214,0.06)'; ctx.stroke();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.facing + Math.PI / 2);
  const blink = player.invuln > 0 && Math.floor(player.invuln * 20) % 2 === 0;
  const R = player.r;
  // 引擎尾焰
  ctx.save();
  ctx.shadowColor = '#4dd0ff'; ctx.shadowBlur = 22;
  const flameH = 14 + Math.sin(time * 60) * 3;
  const fg = ctx.createLinearGradient(0, R * 0.6, 0, R * 0.6 + flameH);
  fg.addColorStop(0, 'rgba(255,220,150,0.95)'); fg.addColorStop(0.4, 'rgba(255,140,60,0.85)'); fg.addColorStop(1, 'rgba(77,120,255,0)');
  ctx.fillStyle = fg;
  ctx.beginPath();
  ctx.moveTo(-R * 0.35, R * 0.55); ctx.quadraticCurveTo(0, R * 0.55 + flameH + 6, R * 0.35, R * 0.55); ctx.closePath(); ctx.fill();
  ctx.restore();
  // 主体
  if (SPRITES.player) {
    const sz = R * 3.0;
    ctx.save();
    if (blink) { ctx.globalAlpha = 0.5; if (_filterOK) ctx.filter = 'brightness(2)'; }
    ctx.shadowColor = '#4dd0ff'; ctx.shadowBlur = blink ? 22 : 14;
    ctx.drawImage(SPRITES.player, -sz / 2, -sz / 2, sz, sz);
    if (_filterOK) ctx.filter = 'none';
    ctx.restore();
  } else {
    ctx.shadowColor = '#4dd0ff'; ctx.shadowBlur = blink ? 28 : 18;
    ctx.fillStyle = blink ? '#ffffff' : '#36c6e8';
    ctx.beginPath();
    ctx.moveTo(0, -R * 1.15);
    ctx.quadraticCurveTo(R * 0.45, -R * 0.5, R * 0.35, R * 0.55); ctx.lineTo(-R * 0.35, R * 0.55);
    ctx.quadraticCurveTo(-R * 0.45, -R * 0.5, 0, -R * 1.15); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
  // ===== 玩家头顶小血条（王者荣耀英雄头顶式）=====
  const hbW = 44, hbH = 4, hbX = player.x - hbW / 2, hbY = player.y - player.r - 14;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  roundRect(ctx, hbX - 1, hbY - 1, hbW + 2, hbH + 2, 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, hbX, hbY, hbW, hbH, 2); ctx.fill();
  const hpRatio = clamp(player.hp / player.maxHp, 0, 1);
  ctx.fillStyle = hpRatio > 0.5 ? '#4dff88' : hpRatio > 0.25 ? '#ffd86b' : '#ff4d6d';
  roundRect(ctx, hbX, hbY, hbW * hpRatio, hbH, 2); ctx.fill();
}
function drawOrbit() {
  const o = skills.orbit; if (o.count === 0) return;
  for (let k = 0; k < o.count; k++) { const a = o.angle + (k / o.count) * TAU;
    const ox = player.x + Math.cos(a) * o.radius, oy = player.y + Math.sin(a) * o.radius;
    ctx.save(); ctx.shadowColor = '#8affd6'; ctx.shadowBlur = 16;
    const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, 10);
    g.addColorStop(0, '#fff'); g.addColorStop(0.5, '#bdffe6'); g.addColorStop(1, 'rgba(138,255,214,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ox, oy, 10, 0, TAU); ctx.fill(); ctx.restore();
  }
}
const ENEMY_SPRITE_MAP = { blob: 'blob', spike: 'spike', skull: 'skull', cube: 'cube' };
function drawEnemy(e) {
  const pulse = 1 + Math.sin(time * 4 + e.spin) * 0.06;
  ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(e.spin);
  if (e.hitFlash > 0 && _filterOK) ctx.filter = 'brightness(3)';
  if (e.elite) {
    ctx.shadowColor = '#ffe27a'; ctx.shadowBlur = 24;
    ctx.strokeStyle = 'rgba(255,226,122,0.7)'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, e.r + 8 + Math.sin(time * 3) * 2, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,226,122,0.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, e.r + 14, 0, TAU); ctx.stroke();
  }
  const R = e.r * pulse;
  const spriteKey = ENEMY_SPRITE_MAP[e.shape];
  const sprite = SPRITES[spriteKey];
  if (sprite) {
    ctx.save();
    ctx.shadowColor = e.glow; ctx.shadowBlur = shadowEnabled ? 14 : 0;
    const sz = R * 2.6;
    if (e.slow > 0 && _filterOK) ctx.filter = (ctx.filter !== 'none' ? ctx.filter + ' ' : '') + 'hue-rotate(180deg) brightness(1.1)';
    ctx.drawImage(sprite, -sz / 2, -sz / 2, sz, sz);
    ctx.restore();
  } else {
    // 后备：纯色发光圆
    ctx.shadowColor = e.glow; ctx.shadowBlur = shadowEnabled ? 14 : 0;
    const col = e.slow > 0 ? blendColor(e.color, '#9fd6ff', 0.5) : e.color;
    const grad = ctx.createRadialGradient(-R * 0.2, -R * 0.2, 0, 0, 0, R);
    grad.addColorStop(0, lighten(col, 0.35)); grad.addColorStop(0.6, col); grad.addColorStop(1, blendColor(col, '#000', 0.4));
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
  }
  if (_filterOK) ctx.filter = 'none';
  ctx.shadowBlur = 0;
  // 冰冻效果：冰晶覆盖
  if (e.slow > 0) {
    ctx.strokeStyle = 'rgba(159,214,255,0.85)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.25, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(200,240,255,0.5)'; ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU + time;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * R * 0.8, Math.sin(a) * R * 0.8);
      ctx.lineTo(Math.cos(a) * R * 1.2, Math.sin(a) * R * 1.2); ctx.stroke(); }
  }
  ctx.restore();
  // 血条
  if (e.maxHp > 20 && e.hp < e.maxHp) {
    const w = e.r * 2.5;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(e.x - w / 2, e.y - e.r - 10, w, 4);
    ctx.fillStyle = e.elite ? '#ffe27a' : '#ff5566'; ctx.fillRect(e.x - w / 2, e.y - e.r - 10, w * (e.hp / e.maxHp), 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 0.5; ctx.strokeRect(e.x - w / 2, e.y - e.r - 10, w, 4);
  }
}
function drawBoss() {
  if (!boss) return;
  ctx.save(); ctx.translate(boss.x, boss.y);
  if (boss.hitFlash > 0 && _filterOK) ctx.filter = 'brightness(3)';
  ctx.rotate(boss.angle * 0.3);
  const R = boss.r;
  if (SPRITES.boss) {
    ctx.save();
    ctx.shadowColor = boss.glow; ctx.shadowBlur = shadowEnabled ? 30 : 0;
    const sz = R * 2.8;
    ctx.drawImage(SPRITES.boss, -sz / 2, -sz / 2, sz, sz);
    ctx.restore();
  } else {
    // 后备：纯色多角星 + 核心
    ctx.shadowColor = boss.glow; ctx.shadowBlur = 30;
    ctx.fillStyle = '#7a001a'; ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + boss.angle; const rr = i % 2 === 0 ? R * 1.2 : R * 1.0;
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    const grd = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 0.95);
    grd.addColorStop(0, '#ffd86b'); grd.addColorStop(0.4, '#ff5566'); grd.addColorStop(1, '#7a001a');
    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(0, 0, R * 0.9, 0, TAU); ctx.fill();
    ctx.shadowColor = '#ffe27a'; ctx.shadowBlur = 20;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, R * 0.22, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ff2d55'; ctx.beginPath(); ctx.arc(0, 0, R * 0.12, 0, TAU); ctx.fill();
  }
  if (_filterOK) ctx.filter = 'none';
  ctx.shadowBlur = 0;
  if (boss.slow > 0) { ctx.strokeStyle = 'rgba(159,214,255,0.8)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.4, 0, TAU); ctx.stroke(); }
  ctx.restore();
}
// Boss 顶部血条（屏幕坐标，在 drawUI 中调用）
function drawBossBar() {
  if (!boss) return;
  const barW = Math.min(W * 0.45, 320), barH = 10;
  const bx = (W - barW) / 2, by = HUD_TOP + 30;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  roundRect(ctx, bx - 3, by - 3, barW + 6, barH + 6, 3); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, bx, by, barW, barH, barH / 2); ctx.fill();
  const bg = ctx.createLinearGradient(bx, by, bx + barW, by);
  bg.addColorStop(0, '#ff2d55'); bg.addColorStop(1, '#ff8a4d');
  ctx.fillStyle = bg;
  const bw = barW * clamp(boss.hp / boss.maxHp, 0, 1);
  if (bw > 0) { roundRect(ctx, bx, by, bw, barH, barH / 2); ctx.fill(); }
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
  roundRect(ctx, bx, by, barW, barH, barH / 2); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.font = 'bold 11px sans-serif';
  ctx.fillStyle = '#ffd6de'; ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
  ctx.fillText((boss.title || '夜魇巨像') + ' · BOSS', W / 2, by - 5);
  ctx.shadowBlur = 0;
}
function drawBullet(b) {
  ctx.save();
  const len = 22; const sp = Math.hypot(b.vx, b.vy) || 1;
  const tx = b.x - (b.vx / sp) * len, ty = b.y - (b.vy / sp) * len;
  const grad = ctx.createLinearGradient(tx, ty, b.x, b.y);
  grad.addColorStop(0, hexA(b.color, 0)); grad.addColorStop(0.5, hexA(b.color, 0.3)); grad.addColorStop(1, b.color);
  ctx.strokeStyle = grad; ctx.lineWidth = b.r * 2.5; ctx.lineCap = 'round';
  ctx.shadowColor = b.color; ctx.shadowBlur = shadowEnabled ? 16 : 0;
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.shadowBlur = 0;
  const grad2 = ctx.createLinearGradient(tx, ty, b.x, b.y);
  grad2.addColorStop(0, hexA(b.color, 0)); grad2.addColorStop(1, '#ffffff');
  ctx.strokeStyle = grad2; ctx.lineWidth = b.r * 0.8;
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.shadowColor = b.color; ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.7, 0, TAU); ctx.fill();
  ctx.fillStyle = lighten(b.color, 0.5);
  ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.35, 0, TAU); ctx.fill();
  ctx.restore();
}
function drawChains() {
  for (const c of chains) {
    const a = clamp(c.life / c.max, 0, 1);
    ctx.save(); ctx.lineWidth = 3 * a + 1; ctx.strokeStyle = `rgba(180,230,255,${a})`;
    ctx.shadowColor = '#8affd6'; ctx.shadowBlur = 18;
    for (let i = 0; i < c.pts.length - 1; i++) { const a1 = c.pts[i], a2 = c.pts[i + 1];
      ctx.beginPath(); ctx.moveTo(a1.x, a1.y);
      for (let s = 1; s <= 7; s++) { const t = s / 7;
        const x = a1.x + (a2.x - a1.x) * t + (s < 7 ? rand(-14, 14) : 0);
        const y = a1.y + (a2.y - a1.y) * t + (s < 7 ? rand(-14, 14) : 0);
        ctx.lineTo(x, y); } ctx.stroke(); }
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    for (const p of c.pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 5 * a, 0, TAU); ctx.fill(); }
    ctx.restore();
  }
}
function drawLasers() {
  for (const l of lasers) {
    const a = clamp(l.life / l.max, 0, 1); const reach = 640;
    const x2 = l.x1 + Math.cos(l.a) * reach, y2 = l.y1 + Math.sin(l.a) * reach;
    ctx.save();
    ctx.strokeStyle = `rgba(255,120,170,${0.45 * a})`; ctx.lineWidth = l.w * 2.2; ctx.lineCap = 'round';
    ctx.shadowColor = '#ff4d8a'; ctx.shadowBlur = 22;
    ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${0.95 * a})`; ctx.lineWidth = l.w * 0.7;
    ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(l.x1, l.y1, l.w * 0.8, 0, TAU); ctx.fill();
    ctx.restore();
  }
}
function drawFrosts() {
  for (const f of frosts) {
    const t = 1 - f.life / f.max; const rr = f.r0 + (f.r - f.r0) * t;
    ctx.save(); ctx.globalAlpha = clamp(f.life / f.max, 0, 1);
    const g = ctx.createRadialGradient(f.x, f.y, rr * 0.2, f.x, f.y, rr);
    g.addColorStop(0, 'rgba(200,240,255,0)'); g.addColorStop(0.7, 'rgba(159,214,255,0.25)'); g.addColorStop(1, 'rgba(100,180,255,0.85)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(f.x, f.y, rr, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(200,240,255,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(f.x, f.y, rr, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 12; i++) { const ang = (i / 12) * TAU;
      const px = f.x + Math.cos(ang) * rr * 0.9, py = f.y + Math.sin(ang) * rr * 0.9;
      ctx.fillRect(px - 1, py - 2, 2, 4); }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
function drawBoomerangs() {
  for (const bm of boomerangs) {
    ctx.save(); ctx.translate(bm.x, bm.y); ctx.rotate(bm.angle);
    ctx.shadowColor = bm.color; ctx.shadowBlur = 16; ctx.fillStyle = '#ffe27a';
    ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(0, -4); ctx.lineTo(12, 0); ctx.lineTo(0, 4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = bm.color; ctx.fillRect(-12, -2, 24, 1.5); ctx.restore();
  }
}
function drawGem(g) {
  ctx.save(); ctx.translate(g.x, g.y);
  const isBig = g.value >= 3;
  const glow = isBig ? '#ffe27a' : '#4dd0ff';
  // 光晕底
  ctx.shadowColor = glow; ctx.shadowBlur = shadowEnabled ? 14 : 0;
  ctx.fillStyle = hexA(glow, 0.15); ctx.beginPath(); ctx.arc(0, 0, 10, 0, TAU); ctx.fill();
  ctx.shadowBlur = 0;
  if (SPRITES.gem) {
    const sz = isBig ? 26 : 20;
    ctx.rotate(time * 2);
    ctx.drawImage(SPRITES.gem, -sz / 2, -sz / 2, sz, sz);
  } else {
    ctx.rotate(time * 2);
    const s = isBig ? 7 : 5;
    const col = isBig ? '#ffe27a' : '#7fe8ff';
    const grad = ctx.createRadialGradient(-s * 0.2, -s * 0.2, 0, 0, 0, s);
    grad.addColorStop(0, '#fff'); grad.addColorStop(0.4, col); grad.addColorStop(1, blendColor(col, '#000', 0.3));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s, 0); ctx.lineTo(0, s); ctx.lineTo(-s, 0); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
function drawPickup(p) {
  ctx.save(); const blink = p.life < 4 && Math.floor(p.life * 6) % 2 === 0;
  const pulse = 1 + Math.sin(p.pulse * 4) * 0.15; ctx.globalAlpha = blink ? 0.4 : 1;
  const bob = Math.sin(p.pulse * 3) * 3;
  ctx.translate(p.x, p.y + bob);
  // 光束
  const beamGrad = ctx.createLinearGradient(0, -50, 0, 0);
  beamGrad.addColorStop(0, hexA(p.color, 0)); beamGrad.addColorStop(1, hexA(p.color, 0.2));
  ctx.fillStyle = beamGrad; ctx.beginPath();
  ctx.moveTo(-3, 0); ctx.lineTo(3, 0); ctx.lineTo(7, -50); ctx.lineTo(-7, -50); ctx.closePath(); ctx.fill();
  // 光晕底
  ctx.shadowColor = p.color; ctx.shadowBlur = shadowEnabled ? 22 : 0;
  ctx.fillStyle = hexA(p.color, 0.2); ctx.beginPath(); ctx.arc(0, 0, p.r * pulse * 1.5, 0, TAU); ctx.fill();
  ctx.shadowBlur = 0;
  // 道具精灵图
  const spriteMap = { chest: 'chest', bomb: 'bomb', heal: 'heart', magnet: 'magnet' };
  const spKey = spriteMap[p.kind];
  if (spKey && SPRITES[spKey]) {
    const sz = p.r * 2.6 * pulse;
    ctx.drawImage(SPRITES[spKey], -sz / 2, -sz / 2, sz, sz);
  } else if (p.kind === 'chest') {
    const s = p.r * pulse;
    ctx.fillStyle = '#8a5a2a'; ctx.beginPath();
    ctx.moveTo(-s, s * 0.7); ctx.lineTo(s, s * 0.7); ctx.lineTo(s * 0.8, -s * 0.2); ctx.lineTo(-s * 0.8, -s * 0.2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#a06a30'; ctx.beginPath();
    ctx.moveTo(-s * 0.8, -s * 0.2); ctx.quadraticCurveTo(0, -s * 0.9, s * 0.8, -s * 0.2); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#ffe27a'; ctx.fillRect(-s * 0.15, -s * 0.1, s * 0.3, s * 0.4);
    ctx.strokeStyle = '#5a3a1a'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(-s * 0.8, -s * 0.2); ctx.lineTo(s * 0.8, -s * 0.2); ctx.stroke();
  } else if (p.kind === 'bomb') {
    const s = p.r * pulse;
    ctx.fillStyle = '#2a2a2a'; ctx.beginPath(); ctx.arc(0, 0, s, 0, TAU); ctx.fill();
    ctx.fillStyle = '#1a1a1a'; ctx.beginPath(); ctx.arc(-s * 0.3, -s * 0.3, s * 0.3, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0; ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -s); ctx.quadraticCurveTo(s * 0.5, -s * 1.3, s * 0.3, -s * 1.6); ctx.stroke();
    ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(s * 0.3, -s * 1.6, 2 + Math.sin(time * 10) * 1, 0, TAU); ctx.fill();
  } else if (p.kind === 'heal') {
    const s = p.r * pulse;
    ctx.fillStyle = 'rgba(255,255,255,0.95)'; roundRect(ctx, -s, -s, s * 2, s * 2, 4); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = p.color;
    ctx.fillRect(-s * 0.7, -s * 0.2, s * 1.4, s * 0.4); ctx.fillRect(-s * 0.2, -s * 0.7, s * 0.4, s * 1.4);
  } else if (p.kind === 'magnet') {
    const s = p.r * pulse;
    ctx.fillStyle = '#ff4d6d'; ctx.beginPath();
    ctx.arc(0, 0, s, Math.PI, 0, false); ctx.lineTo(s * 0.6, s); ctx.lineTo(s * 0.6, s * 0.3);
    ctx.arc(0, s * 0.3, s * 0.6, 0, Math.PI, true); ctx.lineTo(-s, s * 0.3); ctx.lineTo(-s, s); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#bbb';
    ctx.fillRect(-s, s * 0.8, s * 0.6, s * 0.3); ctx.fillRect(s * 0.4, s * 0.8, s * 0.6, s * 0.3);
  } else {
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(0, 0, p.r * pulse, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#0a0e1c';
    ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.icon, 0, 1);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}
function drawEqDrop(eq) {
  ctx.save(); const blink = eq.life < 6 && Math.floor(eq.life * 5) % 2 === 0;
  ctx.globalAlpha = blink ? 0.55 : 1;
  const pulse = 1 + Math.sin(eq.pulse * 3) * 0.12;
  ctx.translate(eq.x, eq.y);
  const rc = RARITY[eq.rarity].color;
  // 光束
  const beamH = 60 + Math.sin(eq.pulse * 2) * 10;
  const beamGrad = ctx.createLinearGradient(0, -beamH, 0, 0);
  beamGrad.addColorStop(0, hexA(rc, 0)); beamGrad.addColorStop(1, hexA(rc, 0.25));
  ctx.fillStyle = beamGrad;
  ctx.beginPath(); ctx.moveTo(-3, 0); ctx.lineTo(3, 0); ctx.lineTo(8, -beamH); ctx.lineTo(-8, -beamH); ctx.closePath(); ctx.fill();
  // 稀有度光晕
  ctx.shadowColor = rc; ctx.shadowBlur = shadowEnabled ? 28 : 0;
  ctx.fillStyle = hexA(rc, 0.18); ctx.beginPath(); ctx.arc(0, 0, 26 * pulse, 0, TAU); ctx.fill();
  ctx.shadowBlur = 0;
  const s = 18 * pulse;
  if (SPRITES.equip) {
    // 装备精灵图 + 稀有度边框
    ctx.drawImage(SPRITES.equip, -s, -s, s * 2, s * 2);
    ctx.strokeStyle = rc; ctx.lineWidth = 2.5;
    roundRect(ctx, -s, -s, s * 2, s * 2, 6); ctx.stroke();
    ctx.strokeStyle = hexA(rc, 0.4); ctx.lineWidth = 1;
    roundRect(ctx, -s - 3, -s - 3, s * 2 + 6, s * 2 + 6, 8); ctx.stroke();
  } else {
    const bgGrad = ctx.createRadialGradient(-s * 0.3, -s * 0.3, 0, 0, 0, s * 1.5);
    bgGrad.addColorStop(0, 'rgba(20,28,50,0.95)'); bgGrad.addColorStop(1, 'rgba(8,12,24,0.95)');
    ctx.fillStyle = bgGrad; roundRect(ctx, -s, -s, s * 2, s * 2, 6); ctx.fill();
    ctx.strokeStyle = rc; ctx.lineWidth = 2.5; roundRect(ctx, -s, -s, s * 2, s * 2, 6); ctx.stroke();
    ctx.strokeStyle = hexA(rc, 0.4); ctx.lineWidth = 1; roundRect(ctx, -s - 3, -s - 3, s * 2 + 6, s * 2 + 6, 8); ctx.stroke();
    ctx.fillStyle = rc;
    ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(EQ_SLOT_ICON[eq.slot], 0, 1);
  }
  // 史诗/传说旋转粒子
  if (eq.rarity === 'legend' || eq.rarity === 'epic') {
    ctx.rotate(eq.pulse * 1.5);
    ctx.fillStyle = rc; ctx.globalAlpha = (blink ? 0.55 : 1) * 0.6;
    for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU; const px = Math.cos(a) * (s + 6), py = Math.sin(a) * (s + 6);
      ctx.beginPath(); ctx.arc(px, py, 1.5, 0, TAU); ctx.fill(); }
    ctx.globalAlpha = blink ? 0.55 : 1;
  }
  if (Math.sin(eq.pulse * 4) > 0.7) { ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.arc(-s * 0.3, -s * 0.3, s * 0.4, 0, TAU); ctx.fill(); }
  ctx.restore();
  ctx.globalAlpha = 1;
}
function drawParticles() {
  for (const p of particles) {
    const a = clamp(p.life / p.max, 0, 1);
    if (p.kind === 'ring') {
      const t = 1 - p.life / p.max; const rr = p.r0 + (p.r - p.r0) * t;
      ctx.globalAlpha = a;
      ctx.strokeStyle = p.color; ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.shadowColor = p.color; ctx.shadowBlur = shadowEnabled ? 16 : 0;
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, TAU); ctx.stroke();
      if (p.glow) { ctx.globalAlpha = a * 0.3; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, rr * 0.6, 0, TAU); ctx.fill(); }
      ctx.shadowBlur = 0;
    } else if (p.kind === 'enemyShot') {
      ctx.globalAlpha = a; ctx.fillStyle = p.color;
      ctx.shadowColor = p.color; ctx.shadowBlur = shadowEnabled ? 12 : 0;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
    } else if (p.kind === 'spark') {
      ctx.globalAlpha = a; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.shadowColor = p.color; ctx.shadowBlur = shadowEnabled ? 8 : 0;
      ctx.strokeStyle = p.color; ctx.lineWidth = p.r; ctx.lineCap = 'round';
      const len = p.r * 3; ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(0, 0); ctx.stroke();
      ctx.restore(); ctx.shadowBlur = 0;
    } else if (p.kind === 'shard') {
      ctx.globalAlpha = a; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.shadowColor = p.color; ctx.shadowBlur = shadowEnabled ? 6 : 0;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(0, -p.r); ctx.lineTo(p.r * 0.7, p.r * 0.5); ctx.lineTo(-p.r * 0.7, p.r * 0.5);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = lighten(p.color, 0.4);
      ctx.beginPath(); ctx.moveTo(0, -p.r * 0.6); ctx.lineTo(p.r * 0.3, 0); ctx.lineTo(-p.r * 0.2, -p.r * 0.2);
      ctx.closePath(); ctx.fill();
      ctx.restore(); ctx.shadowBlur = 0;
    } else {
      ctx.globalAlpha = a; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
      if (a > 0.5) { ctx.globalAlpha = a * 0.5; ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(p.x - p.r * 0.3, p.y - p.r * 0.3, p.r * 0.3, 0, TAU); ctx.fill(); }
    }
  }
  ctx.globalAlpha = 1;
}
function drawFloats() {
  ctx.textAlign = 'center'; ctx.font = 'bold 14px sans-serif';
  for (const f of floats) {
    ctx.globalAlpha = clamp(f.life / f.max, 0, 1); ctx.fillStyle = f.color;
    ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.fillText(f.txt, f.x, f.y); ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
}

// ========== 主渲染 ==========
function render() {
  // ===== 世界渲染（应用相机偏移）=====
  ctx.save();
  let camX = cam.followX, camY = cam.followY;
  if (cam.shake > 0) { camX -= rand(-cam.shake, cam.shake); camY -= rand(-cam.shake, cam.shake); }
  ctx.translate(-camX, -camY);
  drawBackground();
  for (const tr of traps) drawTrap(tr);
  for (const g of gems) drawGem(g);
  for (const p of pickups) drawPickup(p);
  for (const eq of eqDrops) drawEqDrop(eq);
  for (const e of enemies) drawEnemy(e);
  drawBoss();
  drawOrbit();
  drawPlayer();
  for (const b of bullets) drawBullet(b);
  drawBoomerangs();
  drawFrosts();
  drawLasers();
  drawChains();
  drawParticles();
  drawFloats();
  ctx.restore();
  // ===== UI 渲染（屏幕坐标，不受相机影响）=====
  if (flashScreen > 0) {
    ctx.fillStyle = `rgba(255,255,255,${flashScreen})`;
    ctx.fillRect(0, 0, W, H);
  }
}

// ========== 主循环 ==========
function loop(ts) {
  if (!lastTime) lastTime = ts;
  let dt = (ts - lastTime) / 1000; lastTime = ts; if (dt > 0.05) dt = 0.05;
  if (state === STATE.PLAY) update(dt);
  if (state === STATE.PLAY || state === STATE.LEVELUP || state === STATE.OVER || state === STATE.PAUSE) {
    render(); drawUI();
  } else {
    // START 状态：纯背景 + UI（不进入世界渲染，避免依赖未初始化的 cam/player）
    ctx.fillStyle = '#04050a'; ctx.fillRect(0, 0, W, H);
    drawUI();
  }
  requestAnimationFrame(loop);
}

// ========== 启动 ==========
buildStarLayers();
ensureLogin(); // 静默微信登录 + 生成/读取本地昵称，供结算自动上榜
loadSprites(() => { /* 精灵图加载完成后会自动用于绘制 */ });

// 切前台时恢复音频上下文（微信限制）
wx.onShow && wx.onShow(() => { Audio.resume(); });

// 显示分享菜单
wx.showShareMenu && wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });

// 默认分享配置
wx.onShareAppMessage && wx.onShareAppMessage(() => ({
  title: '暗夜突围 · 我挺到了 ' + Math.floor(time) + ' 秒，击杀 ' + player.kills + '，敢来一战吗？',
  imageUrl: '',
}));

requestAnimationFrame(loop);
