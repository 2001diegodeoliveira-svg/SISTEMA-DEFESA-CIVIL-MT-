/* SGI PROTEGE - Mapa Integrado (14/14): mapa-calor. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= Temperature Overlay (Canvas Heatmap + City Badges) ================= */
let tempOverlay = null;
let tempBadgeLayer = null;
let tempOverlayToken = 0;

const MT_CIDADES = [
    { nome: 'Cuiabá', lat: -15.601, lon: -56.097, pop: 'grande' },
    { nome: 'Sinop', lat: -11.860, lon: -55.502, pop: 'media' },
    { nome: 'Rondonópolis', lat: -16.470, lon: -54.635, pop: 'media' },
    { nome: 'Sorriso', lat: -12.545, lon: -55.728, pop: 'media' },
    { nome: 'Cáceres', lat: -16.076, lon: -57.681, pop: 'pequena' },
    { nome: 'Barra do Garças', lat: -15.890, lon: -52.257, pop: 'pequena' },
    { nome: 'Primavera do Leste', lat: -15.360, lon: -54.280, pop: 'pequena' },
    { nome: 'Tangará da Serra', lat: -14.620, lon: -57.430, pop: 'pequena' },
    { nome: 'Lucas do Rio Verde', lat: -13.058, lon: -55.927, pop: 'pequena' },
    { nome: 'Várzea Grande', lat: -15.647, lon: -56.133, pop: 'grande' },
];

function tempColor(t) {
    if (t < 10) return '#3b82f6';
    if (t < 15) return '#38bdf8';
    if (t < 20) return '#22d3ee';
    if (t < 24) return '#34d399';
    if (t < 28) return '#fbbf24';
    if (t < 32) return '#f9731c';
    if (t < 36) return '#ef4444';
    return '#dc2626';
}

function tempColorRGB(t) {
    const hex = tempColor(t);
    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
    };
}

function tempWeatherFA(code) {
    if (code == null) return 'sun';
    if (code === 0) return 'sun';
    if (code <= 2) return 'cloud-sun';
    if (code === 3) return 'cloud';
    if (code >= 51 && code <= 55) return 'cloud-rain';
    if (code >= 61 && code <= 65) return 'cloud-rain';
    if (code >= 80 && code <= 82) return 'cloud-rain';
    if (code >= 95) return 'cloud-lightning';
    return 'cloud-sun';
}

function tempBadgeHTML(city, data) {
    const t = Math.round(data.temp);
    const color = tempColor(data.temp);
    const icon = tempWeatherFA(data.wcode);
    const feelsLike = data.feels != null ? Math.round(data.feels) : '--';
    const hum = data.hum != null ? data.hum : '--';
    const wind = data.wind != null ? Math.round(data.wind) : '--';
    const windDir = data.windDir != null ? windDirArrow(data.windDir) : '';
    return `
        <div class="temp-badge" style="border-color:${color}33;">
            <div class="tb-glow" style="background:${color};"></div>
            <div class="tb-city">${city.nome}</div>
            <div class="tb-row">
                <span class="tb-icon"><i data-lucide="${icon}"></i></span>
                <span class="tb-val" style="color:${color};">${t}<span class="tb-unit">°C</span></span>
            </div>
            <div class="tb-feels">Sensação ${feelsLike}°C</div>
            <div class="tb-extra">
                <span class="tb-stat"><i data-lucide="droplet" style="color:#38bdf8;"></i> <b>${hum}%</b></span>
                <span class="tb-stat"><i data-lucide="wind" style="color:#22d3ee;"></i> <b>${wind}</b> ${windDir}</span>
            </div>
        </div>`;
}

function windDirArrow(deg) {
    const arrows = ['\u2193','\u2199','\u2190','\u2196','\u2191','\u2197','\u2192','\u2198'];
    return arrows[Math.round(deg / 45) % 8];
}

async function showTempOverlay() {
    if (overlayRequestLock.temp) return;
    if (overlayCache.temp && Date.now() - overlayCache.temp.ts < 5 * 60 * 1000) {
        const data = overlayCache.temp.data;
        tempCanvas.classList.add('show');
        resizeTempCanvas();
        drawTempHeatmap(data);
        return;
    }
    const token = ++tempOverlayToken;
    if (tempOverlay) { map.removeLayer(tempOverlay); tempOverlay = null; }
    if (tempBadgeLayer) { map.removeLayer(tempBadgeLayer); tempBadgeLayer = null; }
    tempOverlay = L.layerGroup();
    tempBadgeLayer = L.layerGroup();

    tempCanvas.classList.add('show');
    resizeTempCanvas();
    tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);

    const loadEl = document.getElementById('ovLoading');
    const loadMsg = document.getElementById('ovLoadMsg');
    loadMsg.textContent = 'Carregando mapa de temperatura...';
    loadEl.classList.add('show');
    overlayRequestLock.temp = true;

    const bounds = map.getBounds();
    const latMin = Math.max(-17, bounds.getSouth() - 1.5);
    const latMax = Math.min(-7, bounds.getNorth() + 1.5);
    const lonMin = Math.max(-64, bounds.getWest() - 1.5);
    const lonMax = Math.min(-50, bounds.getEast() + 1.5);
    const step = 0.6;

    const pts = [];
    for (let lat = latMin; lat <= latMax; lat += step)
        for (let lon = lonMin; lon <= lonMax; lon += step)
            pts.push({ lat: +lat.toFixed(2), lon: +lon.toFixed(2) });

    const allPoints = [];

    const batchSize = 18;
    for (let i = 0; i < pts.length; i += batchSize) {
        const batch = pts.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(p =>
            dcProxyFetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,weather_code&timezone=America/Cuiaba`)
                .then(r => {
                    if (!r.ok) throw new Error(`temp-${r.status}`);
                    return r.json();
                }).catch(() => null)
        ));
        results.forEach((d, j) => {
            const c = d?.current;
            if (!c) return;
            const temp = c.temperature_2m;
            if (temp == null) return;
            allPoints.push({
                lat: batch[j].lat, lon: batch[j].lon,
                temp, hum: c.relative_humidity_2m,
                feels: c.apparent_temperature, wind: c.wind_speed_10m,
                windDir: c.wind_direction_10m, wcode: c.weather_code,
            });
        });
    }

    overlayCache.temp = { data: allPoints, ts: Date.now() };
    drawTempHeatmap(allPoints);

    const cidadeData = {};
    for (const p of allPoints) {
        for (const cid of MT_CIDADES) {
            const dlat = Math.abs(p.lat - cid.lat);
            const dlon = Math.abs(p.lon - cid.lon);
            if (dlat < 0.5 && dlon < 0.5) {
                if (!cidadeData[cid.nome] || (dlat + dlon) < cidadeData[cid.nome]._dist) {
                    cidadeData[cid.nome] = { ...p, _dist: dlat + dlon };
                }
            }
        }
    }

    if (token !== tempOverlayToken) {
        if (tempOverlay) { map.removeLayer(tempOverlay); tempOverlay = null; }
        if (tempBadgeLayer) { map.removeLayer(tempBadgeLayer); tempBadgeLayer = null; }
        return;
    }

    for (const cid of MT_CIDADES) {
        const data = cidadeData[cid.nome];
        if (!data) continue;
        const icon = L.divIcon({
            className: 'temp-badge-wrap',
            html: tempBadgeHTML(cid, data),
            iconSize: [110, 80],
            iconAnchor: [55, 40],
        });
        L.marker([cid.lat, cid.lon], { icon, interactive: true }).bindPopup(`
            <div class="ov-popup ov-popup-temp">
                <div class="ov-val" style="color:${tempColor(data.temp)};">${Math.round(data.temp)}°C</div>
                <div class="ov-lbl">${cid.nome} — MT</div>
                <div class="ov-detail">
                    Sensação: <b>${data.feels != null ? Math.round(data.feels) : '--'}°C</b><br>
                    Umidade: <b>${data.hum ?? '--'}%</b> · Vento: <b>${data.wind != null ? Math.round(data.wind) : '--'} km/h</b>
                </div>
                <a href="https://www.waze.com/ul?ll=${cid.lat},${cid.lon}&navigate=yes&zoom=17" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding:7px 12px;background:linear-gradient(135deg,#33ccff,#0099ff);color:#fff;font-size:11px;font-weight:700;border-radius:8px;text-decoration:none;transition:transform .15s,box-shadow .15s;" onmouseover="this.style.transform='scale(1.03)';this.style.boxShadow='0 4px 16px rgba(0,153,255,.4)';" onmouseout="this.style.transform='';this.style.boxShadow='';">
                    <i data-lucide="navigation"></i> Navegar com Waze
                </a>
            </div>`, { className: 'ov-custom-popup' }).addTo(tempBadgeLayer);
    }

    if (token !== tempOverlayToken) {
        if (tempOverlay) { map.removeLayer(tempOverlay); tempOverlay = null; }
        if (tempBadgeLayer) { map.removeLayer(tempBadgeLayer); tempBadgeLayer = null; }
        return;
    }

    tempOverlay.addTo(map);
    tempBadgeLayer.addTo(map);
    if (window.lucide) lucide.createIcons();
    loadEl.classList.remove('show');
    overlayRequestLock.temp = false;
    toast('Mapa de temperatura carregado.', true);
}

function drawTempHeatmap(points) {
    if (!points.length) return;
    const w = tempCanvas.width;
    const h = tempCanvas.height;
    tempCtx.clearRect(0, 0, w, h);
    tempCtx.globalCompositeOperation = 'source-over';

    for (const p of points) {
        const pos = map.latLngToContainerPoint([p.lat, p.lon]);
        const radius = 85;
        const rgb = tempColorRGB(p.temp);

        const grad = tempCtx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, radius);
        grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0.28)`);
        grad.addColorStop(0.3, `rgba(${rgb.r},${rgb.g},${rgb.b},0.15)`);
        grad.addColorStop(0.6, `rgba(${rgb.r},${rgb.g},${rgb.b},0.06)`);
        grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);

        tempCtx.fillStyle = grad;
        tempCtx.fillRect(pos.x - radius, pos.y - radius, radius * 2, radius * 2);
    }

    tempCtx.globalCompositeOperation = 'source-over';
}

function clearTempOverlay() {
    if (tempOverlay) { map.removeLayer(tempOverlay); tempOverlay = null; }
    if (tempBadgeLayer) { map.removeLayer(tempBadgeLayer); tempBadgeLayer = null; }
    tempCanvas.classList.remove('show');
    tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
}

/* ================= Fire Risk Overlay ================= */
let fireOverlay = null;
let fireOverlayToken = 0;
async function showFireOverlay() {
    if (overlayRequestLock.fire) return;
    if (overlayCache.fire && Date.now() - overlayCache.fire.ts < 5 * 60 * 1000) {
        if (fireOverlay) { map.removeLayer(fireOverlay); fireOverlay = null; }
        fireOverlay = L.layerGroup();
        overlayCache.fire.data.forEach(marker => marker.addTo(fireOverlay));
        fireOverlay.addTo(map);
        return;
    }
    const token = ++fireOverlayToken;
    if (fireOverlay) { map.removeLayer(fireOverlay); fireOverlay = null; }
    const overlay = L.layerGroup();

    const loadEl = document.getElementById('ovLoading');
    const loadMsg = document.getElementById('ovLoadMsg');
    loadMsg.textContent = 'Carregando risco de fogo...';
    loadEl.classList.add('show');
    overlayRequestLock.fire = true;

    const bounds = map.getBounds();
    const latMin = Math.max(-16, bounds.getSouth() - 1);
    const latMax = Math.min(-7.5, bounds.getNorth() + 1);
    const lonMin = Math.max(-63, bounds.getWest() - 1);
    const lonMax = Math.min(-50.5, bounds.getEast() + 1);
    const step = 1.0;

    const pts = [];
    for (let lat = latMin; lat <= latMax; lat += step)
        for (let lon = lonMin; lon <= lonMax; lon += step)
            pts.push({ lat: +lat.toFixed(2), lon: +lon.toFixed(2) });

    const batchSize = 14;
    const markers = [];
    for (let i = 0; i < pts.length; i += batchSize) {
        const batch = pts.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(p =>
            dcProxyFetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m&daily=precipitation_sum&timezone=America/Cuiaba&past_days=1&forecast_days=0`)
                .then(r => {
                    if (!r.ok) throw new Error(`fire-${r.status}`);
                    return r.json();
                }).catch(() => null)
        ));
        results.forEach((d, j) => {
            const c = d?.current;
            if (!c) return;
            const hum = c.relative_humidity_2m ?? 50;
            const wind = c.wind_speed_10m ?? 0;
            const chuva = d.daily?.precipitation_sum?.[1] ?? d.daily?.precipitation_sum?.[0] ?? 0;
            const temp = c.temperature_2m ?? 25;
            let risco = 0;
            if (temp > 35) risco += 10; else if (temp > 30) risco += 5;
            if (hum < 20) risco += 35; else if (hum < 30) risco += 25; else if (hum < 50) risco += 12;
            if (wind > 30) risco += 30; else if (wind > 20) risco += 20; else if (wind > 10) risco += 8;
            if (chuva > 5) risco = Math.max(0, risco - 20);
            risco = Math.min(100, Math.max(0, risco));
            const color = fireRiskColor(risco);
            const riskLabel = risco >= 70 ? 'Crítico' : risco >= 50 ? 'Alto' : risco >= 30 ? 'Médio' : risco >= 15 ? 'Baixo' : 'Mínimo';
            const marker = L.circleMarker([batch[j].lat, batch[j].lon], {
                radius: 14, weight: 0,
                fillColor: color, fillOpacity: 0.2,
                className: 'ov-fire-marker'
            }).bindPopup(`
                <div class="ov-popup ov-popup-fire">
                    <div class="ov-val" style="color:${color};">${risco}%</div>
                    <div class="ov-lbl">Risco ${riskLabel}</div>
                    <div class="ov-bar"><div class="ov-bar-fill" style="width:${risco}%;background:${color};"></div></div>
                    <div class="ov-factors">
                        <span><i data-lucide="droplet" style="color:#38bdf8;"></i> Umidade: ${hum}%</span>
                        <span><i data-lucide="wind" style="color:#22d3ee;"></i> Vento: ${Math.round(wind)} km/h</span>
                        <span><i data-lucide="cloud-rain" style="color:#a78bfa;"></i> Chuva: ${chuva.toFixed(1)} mm</span>
                        <span><i data-lucide="thermometer" style="color:#f9731c;"></i> Temp: ${Math.round(temp)}°C</span>
                    </div>
                    <a href="https://www.waze.com/ul?ll=${batch[j].lat},${batch[j].lon}&navigate=yes&zoom=17" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding:7px 12px;background:linear-gradient(135deg,#33ccff,#0099ff);color:#fff;font-size:11px;font-weight:700;border-radius:8px;text-decoration:none;transition:transform .15s,box-shadow .15s;" onmouseover="this.style.transform='scale(1.03)';this.style.boxShadow='0 4px 16px rgba(0,153,255,.4)';" onmouseout="this.style.transform='';this.style.boxShadow='';">
                        <i data-lucide="navigation"></i> Navegar com Waze
                    </a>
                </div>`, { className: 'ov-custom-popup' });
            markers.push(marker);
        });
    }
    if (token !== fireOverlayToken) {
        if (overlay) { try { map.removeLayer(overlay); } catch {} }
        loadEl.classList.remove('show');
        overlayRequestLock.fire = false;
        return;
    }
    markers.forEach(m => m.addTo(overlay));
    overlayCache.fire = { data: markers, ts: Date.now() };
    fireOverlay = overlay;
    fireOverlay.addTo(map);
    loadEl.classList.remove('show');
    overlayRequestLock.fire = false;
    toast('Mapa de risco de fogo carregado.', true);
}

function fireRiskColor(risco) {
    if (risco >= 70) return '#dc2626';
    if (risco >= 50) return '#ef4444';
    if (risco >= 30) return '#f9731c';
    if (risco >= 15) return '#fbbf24';
    return '#22c55e';
}

// Toggle layers panel visibility
document.getElementById('layersToggle').addEventListener('click', () => {
    const panel = document.getElementById('layersPanel');
    const icon = document.querySelector('#layersToggle [data-lucide]');
    panel.classList.toggle('collapsed');
    icon.setAttribute('data-lucide', panel.classList.contains('collapsed') ? 'chevrons-right' : 'chevrons-left');
    if (window.lucide) lucide.createIcons();
});

// Toggle climate panel visibility
document.getElementById('climateToggle').addEventListener('click', () => {
    const panel = document.getElementById('climatePanel');
    const icon = document.querySelector('#climateToggle [data-lucide]');
    panel.classList.toggle('collapsed');
    icon.setAttribute('data-lucide', panel.classList.contains('collapsed') ? 'chevrons-right' : 'chevrons-left');
    if (window.lucide) lucide.createIcons();
});

/* ================= Alertas Climáticos em Tempo Real =================
   Lógica movida para js/monitor.js (compartilhada entre todas as páginas). */
