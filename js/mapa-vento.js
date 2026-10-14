/* SGI PROTEGE - Mapa Integrado (13/14): mapa-vento. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= Windy-style Overlay Selector Bar ================= */
let activeOverlayWindy = 'none';
const overlayBar = document.getElementById('overlayBar');
const windCanvas = document.getElementById('windCanvas');
const windCtx = windCanvas.getContext('2d');
const windLegendEl = document.getElementById('windLegend');
const overlayCache = { wind: null, temp: null, fire: null };
const overlayRequestLock = { wind: false, temp: false, fire: false };

// Show overlay bar when map is loaded
overlayBar.classList.add('show');

// Overlay bar buttons
document.querySelectorAll('.ov-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.dataset.ov;
        const wasActive = btn.classList.contains('active');
        document.querySelectorAll('.ov-btn').forEach(b => b.classList.remove('active'));
        if (wasActive) {
            activeOverlayWindy = 'none';
        } else {
            btn.classList.add('active');
            activeOverlayWindy = key;
        }
        handleOverlaySwitch();
    });
});

// Auto-ativa as camadas de fogo (INPE + SIPAM + WMS + risco) quando o mapa abre —
// mesmo comportamento da camada Wildfires do Google Maps, para todo o MT.
setTimeout(() => {
    const fireBtn = document.querySelector('.ov-btn[data-ov="fire"]');
    if (fireBtn && !fireBtn.classList.contains('active')) fireBtn.click();
}, 3500);

// Keyboard shortcuts for overlay bar
const ovKeyMap = { w: 'wind', r: 'rain', c: 'clouds', t: 'temp', f: 'fire' };
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
        document.querySelectorAll('.ov-btn').forEach(b => b.classList.remove('active'));
        activeOverlayWindy = 'none';
        handleOverlaySwitch();
        return;
    }
    if (ovKeyMap[k]) {
        const btn = document.querySelector(`.ov-btn[data-ov="${ovKeyMap[k]}"]`);
        if (btn) btn.click();
    }
});

function hideAllOverlays() {
    windCanvas.classList.remove('show');
    windLegendEl.classList.remove('show');
    stopWindAnimation();
    stopPlaying();
    Object.values(radarLayers).forEach(l => { try { l.setOpacity(0); } catch {} });
    Object.values(satLayers).forEach(l => { try { l.setOpacity(0); } catch {} });
    activeOverlay = 'none';
    clearTempOverlay();
    // Invalida qualquer showFireOverlay() ainda em andamento (fetch em lote
    // demorado) — sem isso, ele terminava depois de fechado e reabria o
    // overlay sozinho, sem nenhum jeito de fechar de novo.
    fireOverlayToken++;
    if (fireOverlay) { map.removeLayer(fireOverlay); fireOverlay = null; }
    document.getElementById('ovLoading')?.classList.remove('show');
    overlayRequestLock.fire = false;
    document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
}

function handleOverlaySwitch() {
    hideAllOverlays();

    const tempLegendEl = document.getElementById('tempLegend');
    const fireLegendEl = document.getElementById('fireLegend');
    if (tempLegendEl) tempLegendEl.classList.remove('show');
    if (fireLegendEl) fireLegendEl.classList.remove('show');

    if (activeOverlayWindy === 'wind') {
        windCanvas.classList.add('show');
        windLegendEl.classList.add('show');
        startWindAnimation();
    } else if (activeOverlayWindy === 'rain') {
        if (!radarFrames.length) {
            toast('Radar de chuva sem dados no momento — tente novamente em instantes.');
            activeOverlayWindy = 'none';
            document.querySelectorAll('.ov-btn').forEach(b => b.classList.remove('active'));
        } else {
            activeOverlay = 'radar';
            document.querySelector('.layer-btn.radar')?.classList.add('active');
            startPlaying();
            showFrame(radarFrames.length - 1);
            toast('Radar de chuva atualizado — ' + fmtTime(weather.generated) + '.', true);
        }
    } else if (activeOverlayWindy === 'clouds') {
        if (!satFrames.length) {
            // RainViewer descontinuou o produto de satélite infravermelho gratuito
            // (a API pública passou a devolver "satellite.infrared": [] sempre vazio).
            toast('Camada de nuvens (satélite IR) indisponível — o provedor RainViewer não está fornecendo esse produto no momento.');
            activeOverlayWindy = 'none';
            document.querySelectorAll('.ov-btn').forEach(b => b.classList.remove('active'));
        } else {
            activeOverlay = 'clouds';
            document.querySelector('.layer-btn.clouds')?.classList.add('active');
            ensureSatLayers();
            startPlaying();
            showFrame(satFrames.length - 1);
            toast('Satélite infravermelho atualizado.', true);
        }
    } else if (activeOverlayWindy === 'temp') {
        showTempOverlay();
        if (tempLegendEl) tempLegendEl.classList.add('show');
    } else if (activeOverlayWindy === 'fire') {
        showFireOverlay();
        if (fireLegendEl) fireLegendEl.classList.add('show');
    }
    document.getElementById('opacityRow').classList.toggle('open',
        activeOverlayWindy === 'rain' || activeOverlayWindy === 'clouds');
    refreshLegend();
}

/* ================= Wind Particle Animation (Windy-style streamlines) ================= */
let windAnimFrame = null;
let windParticles = [];
let windData = null;
let windLastFetch = 0;

const WIND_SPEED_COLORS = [
    [0,  '#1e3a5f'],
    [5,  '#1d4ed8'],
    [10, '#2563eb'],
    [15, '#38bdf8'],
    [20, '#22d3ee'],
    [25, '#06b6d4'],
    [30, '#fbbf24'],
    [40, '#f9731c'],
    [50, '#ef4444'],
    [60, '#dc2626'],
    [80, '#991b1b'],
];

function windSpeedColor(speed) {
    for (let i = WIND_SPEED_COLORS.length - 1; i >= 0; i--) {
        if (speed >= WIND_SPEED_COLORS[i][0]) return WIND_SPEED_COLORS[i][1];
    }
    return WIND_SPEED_COLORS[0][1];
}

function windSpeedRGB(speed) {
    const hex = windSpeedColor(speed);
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b };
}

function resizeWindCanvas() {
    const rect = map.getContainer().getBoundingClientRect();
    windCanvas.width = rect.width;
    windCanvas.height = rect.height;
}

const tempCanvas = document.getElementById('tempCanvas');
const tempCtx = tempCanvas.getContext('2d');
function resizeTempCanvas() {
    const rect = map.getContainer().getBoundingClientRect();
    tempCanvas.width = rect.width;
    tempCanvas.height = rect.height;
}

resizeWindCanvas();
resizeTempCanvas();
map.on('resize', () => { resizeWindCanvas(); resizeTempCanvas(); });

async function fetchWindData() {
    const now = Date.now();
    if (overlayRequestLock.wind) return;
    if (windData && now - windLastFetch < 10 * 60 * 1000) return;
    if (overlayCache.wind && now - overlayCache.wind.ts < 10 * 60 * 1000) {
        windData = overlayCache.wind.data;
        windLastFetch = overlayCache.wind.ts;
        return;
    }
    overlayRequestLock.wind = true;
    windLastFetch = now;

    const bounds = map.getBounds();
    const latMin = Math.max(-16.5, bounds.getSouth() - 2);
    const latMax = Math.min(-8.0, bounds.getNorth() + 2);
    const lonMin = Math.max(-62.0, bounds.getWest() - 2);
    const lonMax = Math.min(-51.0, bounds.getEast() + 2);

    const nLat = 12, nLon = 14;
    const lats = [], lons = [];
    const dLat = (latMax - latMin) / (nLat - 1);
    const dLon = (lonMax - lonMin) / (nLon - 1);
    for (let i = 0; i < nLat; i++) lats.push(latMin + i * dLat);
    for (let j = 0; j < nLon; j++) lons.push(lonMin + j * dLon);

    // Grade regular 2D -> interpolação bilinear suave (sem saltos de direção)
    const vals = [], points = [];
    for (let i = 0; i < nLat; i++) {
        vals[i] = [];
        for (let j = 0; j < nLon; j++) {
            vals[i][j] = { speed: 0, dir: 0, gust: 0 };
            points.push({ i, j, lat: +lats[i].toFixed(2), lon: +lons[j].toFixed(2), used: false });
        }
    }

    const batchSize = 20;
    for (let k = 0; k < points.length; k += batchSize) {
        const batch = points.slice(k, k + batchSize);
        const results = await Promise.all(batch.map(pt =>
            dcProxyFetch(`https://api.open-meteo.com/v1/forecast?latitude=${pt.lat}&longitude=${pt.lon}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&timezone=America/Cuiaba`)
                .then(r => {
                    if (!r.ok) throw new Error(`wind-${r.status}`);
                    return r.json();
                }).catch(() => null)
        ));
        results.forEach((d, n) => {
            if (d?.current) {
                const b = batch[n];
                vals[b.i][b.j] = {
                    speed: d.current.wind_speed_10m || 0,
                    dir: d.current.wind_direction_10m || 0,
                    gust: d.current.wind_gusts_10m || 0,
                };
                b.used = true;
            }
        });
    }
    if (points.some(p => p.used)) {
        windData = { lats, lons, vals, latMin, latMax, lonMin, lonMax };
        overlayCache.wind = { data: windData, ts: Date.now() };
    }
    overlayRequestLock.wind = false;
}

/* Fase 8: orçamento de partículas pela área da tela (dispositivo fraco
   recebe menos) + degradação automática se o frame ficar lento. */
let windBudget = 2000;
let windFrameEmaMs = 16;
let windLastFrameT = 0;
let windSlowFrames = 0;
function initWindParticles() {
    windParticles = [];
    const area = (windCanvas.width || 800) * (windCanvas.height || 600);
    windBudget = Math.max(400, Math.min(2000, Math.round(area / 1200)));
    const count = windBudget;
    const trailLen = 20;
    for (let i = 0; i < count; i++) {
        const x = Math.random() * windCanvas.width;
        const y = Math.random() * windCanvas.height;
        const trail = [];
        for (let t = 0; t < trailLen; t++) trail.push({ x, y });
        const initW = getWindAtPixel(x, y);
        windParticles.push({
            x, y,
            trail,
            age: Math.random() * 120,
            maxAge: 80 + Math.random() * 120,
            dirSmooth: initW.dir,
            spdSmooth: initW.speed,
        });
    }
}

// Interpolação angular pelos caminho mais curto (evita giro de 360° na transição 0<->359)
function lerpAngle(a, b, t) {
    let d = ((b - a + 540) % 360) - 180;
    return (a + d * t + 360) % 360;
}

function bilinearWind(v00, v10, v01, v11, a, b) {
    const lrp = (p, q) => p + (q - p) * a;
    const mix = (t, bt, bb) => t + (bt - t) * bb;
    const speedT = lrp(v00.speed, v10.speed), speedB = lrp(v01.speed, v11.speed);
    const gustT = lrp(v00.gust, v10.gust), gustB = lrp(v01.gust, v11.gust);
    const dirT = lerpAngle(v00.dir, v10.dir, a), dirB = lerpAngle(v01.dir, v11.dir, a);
    return { speed: mix(speedT, speedB, b), gust: mix(gustT, gustB, b), dir: lerpAngle(dirT, dirB, b) };
}

function getWindAtPixel(px, py) {
    if (!windData || !windData.lats) return { speed: 0, dir: 0, gust: 0 };
    const latlng = map.containerPointToLatLng([px, py]);
    const lat = latlng.lat, lon = latlng.lng;
    const { lats, lons, vals } = windData;
    const nLat = lats.length, nLon = lons.length;
    if (nLat < 2 || nLon < 2) {
        let best = vals[0][0], bd = Infinity;
        for (let i = 0; i < nLat; i++) {
            for (let j = 0; j < nLon; j++) {
                const d = Math.pow(lats[i] - lat, 2) + Math.pow(lons[j] - lon, 2);
                if (d < bd) { bd = d; best = vals[i][j]; }
            }
        }
        return best;
    }
    const spanLat = lats[nLat - 1] - lats[0];
    const spanLon = lons[nLon - 1] - lons[0];
    const fi = (lat - lats[0]) / spanLat * (nLat - 1);
    const fj = (lon - lons[0]) / spanLon * (nLon - 1);
    const i0 = Math.max(0, Math.min(nLat - 2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(nLon - 2, Math.floor(fj)));
    const a = Math.min(1, Math.max(0, fi - i0));
    const b = Math.min(1, Math.max(0, fj - j0));
    return bilinearWind(vals[i0][j0], vals[i0 + 1][j0], vals[i0][j0 + 1], vals[i0 + 1][j0 + 1], a, b);
}

function drawWindFrame() {
    if (activeOverlayWindy !== 'wind') return;
    // Auto-degradação: EMA do tempo de frame; lento por 2s seguidos
    // reduz partículas e encurta rastros (piso conservador).
    const agoraT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (windLastFrameT) {
        const dt = agoraT - windLastFrameT;
        windFrameEmaMs = windFrameEmaMs * 0.92 + Math.min(dt, 250) * 0.08;
        if (windFrameEmaMs > 26) {
            if (++windSlowFrames >= 120 && windParticles.length > 300) {
                windParticles.length = Math.max(300, Math.floor(windParticles.length * 0.6));
                windParticles.forEach(p => { p.trail.length = Math.min(p.trail.length, 12); p.maxAge = Math.min(p.maxAge, 90); });
                windSlowFrames = 0;
            }
        } else {
            windSlowFrames = 0;
        }
    }
    windLastFrameT = agoraT;
    windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);

    for (const p of windParticles) {
        const wind = getWindAtPixel(p.x, p.y);
        const speed = wind.speed;
        const gustFactor = wind.gust > speed * 1.3 ? 1.4 : 1.0;
        // Suavização temporal: a partícula "acelera" até a nova direção em vez de pular
        p.dirSmooth = lerpAngle(p.dirSmooth, wind.dir, 0.14);
        p.spdSmooth += (speed - p.spdSmooth) * 0.12;
        const rad = (p.dirSmooth + 180) * Math.PI / 180;
        const step = p.spdSmooth * 0.22 * gustFactor;
        const dx = Math.cos(rad) * step;
        const dy = -Math.sin(rad) * step;

        const trailLen = p.trail.length;
        for (let t = trailLen - 1; t > 0; t--) {
            p.trail[t].x = p.trail[t - 1].x;
            p.trail[t].y = p.trail[t - 1].y;
        }
        p.trail[0].x = p.x;
        p.trail[0].y = p.y;

        p.x += dx;
        p.y += dy;
        p.age++;
        const prevSpeed = p.spdSmooth;

        if (p.age > p.maxAge || p.x < -40 || p.x > windCanvas.width + 40 || p.y < -40 || p.y > windCanvas.height + 40) {
            p.x = Math.random() * windCanvas.width;
            p.y = Math.random() * windCanvas.height;
            for (let t = 0; t < trailLen; t++) { p.trail[t].x = p.x; p.trail[t].y = p.y; }
            p.age = 0;
            const res = getWindAtPixel(p.x, p.y);
            p.dirSmooth = res.dir;
            p.spdSmooth = res.speed;
        }

        const lifeRatio = Math.min(1, (p.maxAge - p.age) / p.maxAge);
        const fadeHead = Math.min(1, p.age / 25);
        const speedFade = Math.min(1, prevSpeed / 5);
        const alpha = lifeRatio * fadeHead * speedFade;
        if (alpha <= 0.01) continue;

        const rgb = windSpeedRGB(prevSpeed);
        const drawLen = Math.min(trailLen, Math.max(4, Math.floor(prevSpeed * 0.6) + 3));

        windCtx.lineCap = 'round';
        windCtx.lineJoin = 'round';

        const baseWidth = Math.min(2.8, 0.6 + prevSpeed * 0.03);
        for (let t = 0; t < drawLen - 1; t++) {
            const ratioT = 1 - t / drawLen;
            const tAlpha = alpha * ratioT * ratioT * 0.75;
            if (tAlpha < 0.008) continue;

            const tWidth = baseWidth * ratioT * ratioT;
            windCtx.beginPath();
            windCtx.moveTo(p.trail[t].x, p.trail[t].y);
            windCtx.lineTo(p.trail[t + 1].x, p.trail[t + 1].y);
            windCtx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${tAlpha})`;
            windCtx.lineWidth = tWidth;
            windCtx.stroke();
        }

        if (prevSpeed > 3 && alpha > 0.1) {
            // Cabeça da partícula
            windCtx.beginPath();
            windCtx.arc(p.trail[0].x, p.trail[0].y, baseWidth * 0.6, 0, Math.PI * 2);
            windCtx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha * 0.6})`;
            windCtx.fill();

            // Seta de direção: triângulo apontando para onde o vento sopra
            const arw = Math.min(15, 4 + prevSpeed * 0.5);
            const ex = Math.cos(rad), ey = -Math.sin(rad);
            const bx = p.x - ex * arw, by = p.y - ey * arw;
            const ox = ey * arw * 0.45, oy = -ex * arw * 0.45;
            windCtx.beginPath();
            windCtx.moveTo(p.x, p.y);
            windCtx.lineTo(bx + ox, by + oy);
            windCtx.lineTo(bx - ox, by - oy);
            windCtx.closePath();
            windCtx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.min(0.92, alpha * 1.3)})`;
            windCtx.fill();
        }
    }
    windCtx.globalAlpha = 1;
    windAnimFrame = requestAnimationFrame(drawWindFrame);
}

async function startWindAnimation() {
    windCanvas.classList.add('loading');
    await fetchWindData();
    windCanvas.classList.remove('loading');
    resizeWindCanvas();
    initWindParticles();
    drawWindFrame();
    const wlBar = document.getElementById('wlBar');
    if (wlBar) wlBar.style.background = 'linear-gradient(90deg, #1e3a5f, #1d4ed8, #2563eb, #38bdf8, #22d3ee, #fbbf24, #f9731c, #ef4444, #dc2626, #991b1b)';
}

function stopWindAnimation() {
    if (windAnimFrame) { cancelAnimationFrame(windAnimFrame); windAnimFrame = null; }
    windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);
}

map.on('moveend', () => {
    if (activeOverlayWindy === 'wind') {
        windLastFetch = 0;
        fetchWindData().then(() => initWindParticles());
    } else if (activeOverlayWindy === 'temp') {
        showTempOverlay();
    } else if (activeOverlayWindy === 'fire') {
        showFireOverlay();
    }
});

