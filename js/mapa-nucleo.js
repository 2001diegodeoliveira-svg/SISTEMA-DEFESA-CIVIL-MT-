/* SGI PROTEGE - Mapa Integrado (1/14): mapa-nucleo. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= Mapa base ================= */
const map = L.map('map', { zoomControl: false, attributionControl: true })
             .setView(DC_ORGANIZACAO.nacional.mapa.centro, DC_ORGANIZACAO.nacional.mapa.zoom);

L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);

// CARTO free raster basemaps agora exigem API key (watermark "API key required" sem ela).
// Usamos o Esri "World Dark Gray" (base + rótulos), que é gratuito e não exige chave.
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, maxNativeZoom: 16,
    attribution: '&copy; Esri &copy; OpenStreetMap'
}).addTo(map);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, maxNativeZoom: 16,
    attribution: '&copy; Esri'
}).addTo(map);

/* ================= Estado ================= */
let weather = null;
let weatherLoading = false;
let radarFrames = [], satFrames = [];
const radarLayers = {}, satLayers = {};
let activeOverlay = 'none';
let frameIdx = 0, playing = true, playTimer = null;
let overlayOpacity = 0.8;

let mtLayer = null, munLayer = null, ucWms = null, focosLayer = null;
let focosFilteredLayer = null;
let focosLoaded = false, focosLoading = false, focosCount = 0;
let focosReloadTimer = null;
const centroidByCod = {};
const codByNomeNormalizado = {};
let munNomeByCod = {};
let ibgeLoadedAt = null;

function normalizarNome(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

/* ================= Utilidades ================= */
function toast(msg, info = false) {
    const t = document.getElementById('toast');
    t.innerHTML = msg;
    t.classList.toggle('info', info);
    t.classList.add('show');
    clearTimeout(t._to);
    t._to = setTimeout(() => t.classList.remove('show'), info ? 4200 : 3500);
}
function fmtTime(unix) {
    return new Date(unix * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(unix) {
    return new Date(unix * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
}

/* ================= RainViewer ================= */
async function loadWeather() {
    try {
        Object.values(radarLayers).forEach(l => { try { map.removeLayer(l); } catch {} });
        Object.values(satLayers).forEach(l => { try { map.removeLayer(l); } catch {} });
        for (const k in radarLayers) delete radarLayers[k];
        for (const k in satLayers) delete satLayers[k];

        const res = await dcProxyFetch('https://api.rainviewer.com/public/weather-maps.json');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        weather = await res.json();
        radarFrames = [...(weather.radar?.past || []), ...(weather.radar?.nowcast || [])];
        satFrames = weather.satellite?.infrared || [];
        radarFrames.forEach((f, i) => { radarLayers[i] = makeFrameLayer(f, false).addTo(map); });
        document.getElementById('mtRadarMeta').textContent =
            `${fmtTime(weather.generated)} gerado`;
        updateCloudsAvailability();
        updateTimeline();
        showFrame(radarFrames.length - 1);
        startPlaying();
        setTimeout(loadWeather, 5 * 60 * 1000);
    } catch (e) {
        toast('Não foi possível carregar o radar meteorológico.');
        document.getElementById('playBtn').disabled = true;
        document.getElementById('timeSlider').disabled = true;
    }
}

// RainViewer descontinuou o produto gratuito de satélite infravermelho — quando
// vier vazio, sinaliza no painel em vez de deixar o botão "Nuvens" sem efeito.
function updateCloudsAvailability() {
    const btn = document.querySelector('.layer-btn.clouds');
    const sub = btn?.querySelector('.sub');
    const ovBtn = document.querySelector('.ov-btn[data-ov="clouds"]');
    if (!satFrames.length) {
        if (sub) sub.textContent = 'Indisponível — provedor sem cobertura no momento';
        btn?.classList.add('unavailable');
        ovBtn?.classList.add('unavailable');
        if (ovBtn) ovBtn.title = 'Nuvens — indisponível (RainViewer sem cobertura de satélite no momento)';
    } else {
        if (sub) sub.textContent = 'Satélite infravermelho · RainViewer';
        btn?.classList.remove('unavailable');
        ovBtn?.classList.remove('unavailable');
        if (ovBtn) ovBtn.title = 'Nuvens — satélite IR (C)';
    }
}

function frameUrl(path, isSatellite) {
    const color = isSatellite ? 0 : 4;
    const smooth = 1, snow = isSatellite ? 0 : 1;
    return `${weather.host}${path}/512/{z}/{x}/{y}/${color}/${smooth}_${snow}.png`;
}
function makeFrameLayer(frame, isSatellite) {
    return L.tileLayer(frameUrl(frame.path, isSatellite), {
        opacity: 0, tileSize: 512, zoomOffset: 0, maxZoom: 18, zIndex: 10, attribution: 'RainViewer'
    });
}
function ensureSatLayers() {
    satFrames.forEach((f, i) => { if (!satLayers[i]) satLayers[i] = makeFrameLayer(f, true).addTo(map); });
}
function showFrame(i) {
    const layers = activeOverlay === 'clouds' ? satLayers : radarLayers;
    const frames = activeOverlay === 'clouds' ? satFrames : radarFrames;
    Object.values(layers).forEach(l => l.setOpacity(0));
    if (!frames.length || activeOverlay === 'none') { updateWeatherLabel(); return; }
    i = Math.max(0, Math.min(frames.length - 1, i));
    frameIdx = i;
    if (layers[i]) layers[i].setOpacity(overlayOpacity);
    updateWeatherLabel();
    document.getElementById('timeSlider').value = i;
}
function updateWeatherLabel() {
    const lbl = document.getElementById('tlLabel');
    const timeEl = document.getElementById('tlTime');
    if (activeOverlay === 'none') {
        lbl.textContent = '';
        lbl.classList.remove('future');
        timeEl.innerHTML = `—<small id="tlDate"></small>`;
        return;
    }
    const frames = activeOverlay === 'clouds' ? satFrames : radarFrames;
    const f = frames[frameIdx];
    if (!f) return;
    const isFuture = f.time > weather.generated;
    timeEl.innerHTML = `${fmtTime(f.time)}<small id="tlDate">${fmtDate(f.time)}</small>`;
    if (activeOverlay === 'clouds') { lbl.textContent = 'Nuvens (satélite IR)'; lbl.classList.remove('future'); }
    else if (isFuture) { lbl.textContent = 'Previsão (nowcast)'; lbl.classList.add('future'); }
    else { lbl.textContent = 'Radar observado'; lbl.classList.remove('future'); }
}
function startPlaying() {
    stopPlaying(); playing = true;
    document.getElementById('playBtn').innerHTML = '<i data-lucide="pause"></i>';
    if (window.lucide) lucide.createIcons();
    playTimer = setInterval(() => {
        const total = activeOverlay === 'clouds' ? satFrames.length : radarFrames.length;
        if (!total) return;
        showFrame((frameIdx + 1) % total);
    }, 600);
}
function stopPlaying() {
    playing = false; clearInterval(playTimer);
    document.getElementById('playBtn').innerHTML = '<i data-lucide="play"></i>';
    if (window.lucide) lucide.createIcons();
}
document.getElementById('playBtn').addEventListener('click', () => playing ? stopPlaying() : startPlaying());
document.getElementById('chuvaPlayBtn').addEventListener('click', () => {
    if (!chuvaHoras.length) { loadChuvaTimeline(); return; }
    chuvaTocando ? pararChuva() : tocarChuva();
    desenharChuva();
});
document.getElementById('timeSlider').addEventListener('input', e => { stopPlaying(); showFrame(+e.target.value); });
function updateTimeline() {
    if (!radarFrames.length) return;
    document.getElementById('timeSlider').max = radarFrames.length - 1;
    document.getElementById('tickStart').textContent = fmtTime(radarFrames[0].time);
    document.getElementById('tickEnd').textContent =
        fmtTime(radarFrames.at(-1).time) + (radarFrames.at(-1).time > weather.generated ? ' (prev.)' : '');
}

/* ================= Camadas meteorológicas (radio) ================= */
document.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.dataset.layer;
        if (key === 'tempestadePotencial') {
            const row = document.querySelector('.check-row[data-check="tempestadePotencial"]');
            if (row) row.click();
            return;
        }
        const wasActive = btn.classList.contains('active');
        document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
        if (wasActive) {
            activeOverlay = 'none';
        } else {
            btn.classList.add('active');
            activeOverlay = key;
            if (key === 'clouds') ensureSatLayers();
        }
        document.getElementById('opacityRow').classList.toggle('open', activeOverlay !== 'none');
        refreshLegend();
        if (activeOverlay !== 'none' && !playing) startPlaying();
        showFrame(frameIdx);
    });
});
document.getElementById('opacityRange').addEventListener('input', e => {
    overlayOpacity = +e.target.value / 100;
    document.getElementById('opacityVal').textContent = e.target.value + '%';
    showFrame(frameIdx);
});

