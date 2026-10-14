/* SGI PROTEGE - Mapa Integrado (10/14): mapa-paineis. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= Windy-style: 48h Hourly Cards ================= */
function renderHourly48h(hourly) {
    const container = document.getElementById('ppHourlyRow');
    container.innerHTML = '';
    const now = new Date(); now.setMinutes(0, 0, 0);
    let startIdx = hourly.time.findIndex(t => new Date(t) >= now);
    if (startIdx < 0) startIdx = 0;
    for (let i = startIdx; i < Math.min(startIdx + 48, hourly.time.length); i++) {
        const dt = new Date(hourly.time[i]);
        const hr = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const temp = hourly.temperature_2m[i];
        const rain = hourly.precipitation[i] ?? 0;
        const prob = hourly.precipitation_probability[i] ?? 0;
        const wind = hourly.wind_speed_10m[i] ?? 0;
        const gusts = hourly.wind_gusts_10m[i] ?? 0;
        const wcode = hourly.weather_code?.[i] ?? 0;
        const [, icon] = WMO_ICONS[wcode] || ['—', 'cloud'];
        const isToday = dt.getDate() === new Date().getDate();
        const dayLabel = isToday ? '' : dt.toLocaleDateString('pt-BR', { weekday: 'short' }) + ' ';
        const item = document.createElement('div');
        item.className = 'pp-h-item';
        item.innerHTML = `
            <span class="phi-time">${dayLabel}${hr}</span>
            <span class="phi-icon"><i data-lucide="${icon}"></i></span>
            <span class="phi-temp">${temp != null ? Math.round(temp) + '\u00B0' : '\u2014'}</span>
            <span class="phi-wind"><i data-lucide="wind" style="font-size:7px;"></i>${Math.round(wind)}<sup style="font-size:6px;color:#ef4444;">${gusts > wind ? ' g' + Math.round(gusts) : ''}</sup></span>
            <span class="phi-rain">${rain > 0 ? rain.toFixed(1) + 'mm' : (prob > 0 ? prob + '%' : '')}</span>`;
        container.appendChild(item);
    }
    if (window.lucide) lucide.createIcons();
}

/* ================= Windy-style: 7-Day Daily Forecast ================= */
function renderDaily7(daily) {
    const container = document.getElementById('ppDailyForecast');
    container.innerHTML = '';
    if (!daily || !daily.time) return;
    const diaSem = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'S\u00E1b'];
    for (let i = 0; i < Math.min(7, daily.time.length); i++) {
        const dt = new Date(daily.time[i] + 'T12:00:00');
        const [, icon] = WMO_ICONS[daily.weather_code?.[i]] || ['—', 'cloud'];
        const tmax = Math.round(daily.temperature_2m_max?.[i] ?? 0);
        const tmin = Math.round(daily.temperature_2m_min?.[i] ?? 0);
        const rain = (daily.precipitation_sum?.[i] ?? 0).toFixed(1);
        const windMax = Math.round(daily.wind_speed_10m_max?.[i] ?? 0);
        const isToday = dt.toDateString() === new Date().toDateString();
        const row = document.createElement('div');
        row.className = 'pp-day-row';
        row.innerHTML = `
            <span class="pp-day-name">${isToday ? 'Hoje' : diaSem[dt.getDay()]}</span>
            <span class="pp-day-icon"><i data-lucide="${icon}"></i></span>
            <span class="pp-day-temps"><span class="pp-day-tmax">${tmax}\u00B0</span><span class="pp-day-tmin">${tmin}\u00B0</span></span>
            <span class="pp-day-rain"><i data-lucide="droplet" style="font-size:8px;"></i> ${rain}mm</span>
            <span class="pp-day-wind"><i data-lucide="wind" style="font-size:8px;"></i> ${windMax}</span>`;
        container.appendChild(row);
    }
    if (window.lucide) lucide.createIcons();
}

/* ================= Windy-style: Wind Rose (SVG) ================= */
function renderWindRose(dir, speed) {
    const container = document.getElementById('ppWindRose');
    if (dir == null) { container.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">Sem dados</span>'; return; }
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const roseAngle = ((dir % 360) + 360) % 360;
    const speedKmh = Math.round(speed ?? 0);
    const beaufort = speedKmh < 2 ? 0 : speedKmh < 6 ? 1 : speedKmh < 12 ? 2 : speedKmh < 20 ? 3 : speedKmh < 29 ? 4 : speedKmh < 39 ? 5 : speedKmh < 50 ? 6 : speedKmh < 62 ? 7 : 8;
    const dirLabel = dirs[Math.round(roseAngle / 45) % 8];
    const arrowColor = speedKmh > 40 ? '#ef4444' : speedKmh > 25 ? '#f9731c' : speedKmh > 15 ? '#fbbf24' : '#38bdf8';

    container.innerHTML = `
        <div class="wr-compass">
            <svg viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="1"/>
                <circle cx="50" cy="50" r="30" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="1"/>
                <circle cx="50" cy="50" r="16" fill="none" stroke="rgba(255,255,255,.04)" stroke-width="1"/>
                <text x="50" y="8" text-anchor="middle" fill="#94a3b8" font-size="7" font-weight="700">N</text>
                <text x="93" y="53" text-anchor="middle" fill="#94a3b8" font-size="6">E</text>
                <text x="50" y="98" text-anchor="middle" fill="#94a3b8" font-size="6">S</text>
                <text x="7" y="53" text-anchor="middle" fill="#94a3b8" font-size="6">W</text>
                <line x1="50" y1="50" x2="${50 + 36 * Math.sin(roseAngle * Math.PI / 180)}" y2="${50 - 36 * Math.cos(roseAngle * Math.PI / 180)}"
                    stroke="${arrowColor}" stroke-width="2.5" stroke-linecap="round"/>
                <circle cx="${50 + 36 * Math.sin(roseAngle * Math.PI / 180)}" cy="${50 - 36 * Math.cos(roseAngle * Math.PI / 180)}"
                    r="3" fill="${arrowColor}"/>
            </svg>
        </div>
        <div class="wr-info">
            <b>Dire\u00E7\u00E3o:</b> ${dirLabel} (${Math.round(roseAngle)}\u00B0)<br>
            <b>Velocidade:</b> ${speedKmh} km/h<br>
            <b>Escala Beaufort:</b> ${beaufort}<br>
            <b>Rajadas:</b> ${Math.round(speed * 1.3)} km/h
        </div>`;
}

/* ================= Windy-style: Risk Assessment ================= */
function renderRiskCards(current, daily) {
    const container = document.getElementById('ppRiskGrid');
    const temp = current.temperature_2m;
    const hum = current.relative_humidity_2m;
    const wind = current.wind_speed_10m;
    const uv = current.uv_index ?? 0;
    const chuvaHoje = daily?.precipitation_sum?.[0] ?? 0;

    let fireRisk = 0;
    if (hum < 20) fireRisk += 35; else if (hum < 30) fireRisk += 25; else if (hum < 50) fireRisk += 12;
    if (wind > 30) fireRisk += 30; else if (wind > 20) fireRisk += 20; else if (wind > 10) fireRisk += 8;
    if (chuvaHoje > 5) fireRisk = Math.max(0, fireRisk - 20);
    fireRisk = Math.min(100, fireRisk);
    const fireSev = fireRisk >= 70 ? 'critico' : fireRisk >= 50 ? 'alto' : fireRisk >= 30 ? 'moderado' : 'baixo';
    const fireLabel = fireSev === 'critico' ? 'Cr\u00EDtico' : fireSev === 'alto' ? 'Alto' : fireSev === 'moderado' ? 'Moderado' : 'Baixo';
    const fireColor = fireSev === 'critico' ? '#ef4444' : fireSev === 'alto' ? '#f9731c' : fireSev === 'moderado' ? '#fbbf24' : '#22c55e';

    const stormRisk = current.weather_code >= 95 ? 90 : current.weather_code >= 80 ? 60 : current.weather_code >= 61 ? 40 : 10;
    const stormSev = stormRisk >= 80 ? 'critico' : stormRisk >= 50 ? 'alto' : stormRisk >= 30 ? 'moderado' : 'baixo';
    const stormLabel = stormSev === 'critico' ? 'Cr\u00EDtico' : stormSev === 'alto' ? 'Alto' : stormSev === 'moderado' ? 'Moderado' : 'Baixo';
    const stormColor = stormSev === 'critico' ? '#ef4444' : stormSev === 'alto' ? '#f9731c' : stormSev === 'moderado' ? '#fbbf24' : '#22c55e';

    const heatSev = temp >= 40 ? 'critico' : temp >= 35 ? 'alto' : temp >= 32 ? 'moderado' : 'baixo';
    const heatLabel = heatSev === 'critico' ? 'Cr\u00EDtico' : heatSev === 'alto' ? 'Alto' : heatSev === 'moderado' ? 'Moderado' : 'Baixo';
    const heatColor = heatSev === 'critico' ? '#ef4444' : heatSev === 'alto' ? '#f9731c' : heatSev === 'moderado' ? '#fbbf24' : '#22c55e';

    container.innerHTML = `
        <div class="pp-risk-card ${fireSev}">
            <div class="prc-icon" style="color:${fireColor};"><i data-lucide="flame"></i></div>
            <div class="prc-val" style="color:${fireColor};">${fireRisk}%</div>
            <div class="prc-lbl">Risco Fogo</div>
        </div>
        <div class="pp-risk-card ${stormSev}">
            <div class="prc-icon" style="color:${stormColor};"><i data-lucide="cloud-lightning"></i></div>
            <div class="prc-val" style="color:${stormColor};">${stormLabel}</div>
            <div class="prc-lbl">Tempestade</div>
        </div>
        <div class="pp-risk-card ${heatSev}">
            <div class="prc-icon" style="color:${heatColor};"><i data-lucide="thermometer-sun"></i></div>
            <div class="prc-val" style="color:${heatColor};">${heatLabel}</div>
            <div class="prc-lbl">Calor Extremo</div>
        </div>`;
    if (window.lucide) lucide.createIcons();
}

/* ================= Windy-style: Nearest INMET Station ================= */
function renderNearestStation(lat, lng, currentWeather) {
    const container = document.getElementById('ppNearestStation');
    if (!inmetLoaded || !inmetLayer) {
        container.innerHTML = '<div style="font-size:10px;color:var(--text-muted);">Ative a camada INMET para ver estações</div>';
        return;
    }
    let nearest = null, minDist = Infinity;
    inmetLayer.eachLayer(l => {
        const ll = l.getLatLng();
        const d = Math.abs(ll.lat - lat) + Math.abs(ll.lng - lng);
        if (d < minDist) { minDist = d; nearest = l; }
    });
    if (!nearest) { container.innerHTML = '<div style="font-size:10px;color:var(--text-muted);">Nenhuma estação encontrada</div>'; return; }
    const popup = nearest.getPopup()?.getContent() || '';
    const nameMatch = popup.match(/<div style="font-weight:700[^"]*">[^<]*<i[^>]*><\/i>([^<]+)<\/div>/);
    const name = nameMatch ? nameMatch[1].trim() : 'Estação INMET';
    const distKm = (minDist * 111).toFixed(0);
    container.innerHTML = `
        <div class="pp-station">
            <div class="pp-station-dot" style="background:#22d3ee;"></div>
            <span class="pp-station-name">${name}</span>
            <span class="pp-station-val" style="color:#22d3ee;font-size:9px;">${distKm} km</span>
        </div>`;
}

/* ================= Modal de fontes ================= */
document.getElementById('portalsList').innerHTML = PORTAIS_OFICIAIS.map(p => `
    <a class="portal-item" href="${p.url}" target="_blank" rel="noopener">
        <div><b>${p.nome}</b><span>${p.uso}</span></div>
        <i data-lucide="external-link"></i>
    </a>`).join('');
if (window.lucide) lucide.createIcons();
document.getElementById('btnSources').addEventListener('click', () =>
    document.getElementById('sourcesModal').classList.add('open'));
document.getElementById('closeSources').addEventListener('click', () =>
    document.getElementById('sourcesModal').classList.remove('open'));
document.getElementById('sourcesModal').addEventListener('click', e => {
    if (e.target.id === 'sourcesModal') e.target.classList.remove('open');
});
document.getElementById('mpClose').addEventListener('click', () =>
    document.getElementById('munPanel').classList.remove('open'));

/* ================= Inicialização ================= */
/* Controle de acesso por perfil:
   - sem sessão → mapa público, sem restrição (a API protege a escrita)
   - comum → alertas e orientações (comportamento anterior)
   - municipal → restrição de navegação ao próprio município */
const sessaoAtual = dcGetSession();
if (sessaoAtual && sessaoAtual.perfil === 'comum') {
    location.replace('alertas.html');
}
let restricaoMun = null;
function aplicarRestricaoMunicipio() {
    const s = dcGetSession();
    if (!s || s.perfil !== 'municipal' || !s.municipio) return;
    const cod = codByNomeNormalizado[normalizarNome(s.municipio)];
    if (!cod) return;
    const alvo = (munLayer.getLayers() || []).find(l =>
        String(l.feature && l.feature.properties && l.feature.properties.codarea) === cod);
    if (!alvo) return;
    const b = alvo.getBounds();
    restricaoMun = { cod, nome: s.municipio, layer: alvo };
    alvo.setStyle({ weight: 3.2, opacity: 1, color: '#f9731c', fillColor: '#f9731c', fillOpacity: .28 });
    alvo.bringToFront();
    map.setMaxBounds(b.pad(0.22));
    map.setMinZoom(9);
    map.fitBounds(b.pad(-0.03), { maxZoom: 11 });
    window.__dcRestricao = { cod, nome: s.municipio, minZoom: map.getMinZoom(), maxBounds: !!(map.options && map.options.maxBounds), zoom: map.getZoom() };
    if (!document.getElementById('restricaoMunChip')) {
        const chip = document.createElement('div');
        chip.id = 'restricaoMunChip';
        chip.innerHTML = `<i data-lucide="lock" style="color:#f9731c;width:15px;height:15px;"></i><span>Visão restrita a <b>${s.municipio}</b></span>`;
        chip.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:9999;display:flex;align-items:center;gap:9px;background:rgba(11,19,41,.94);border:1px solid rgba(249,115,22,.6);color:#f1f5f9;font-size:12px;font-weight:600;padding:10px 15px;border-radius:10px;backdrop-filter:blur(6px);box-shadow:0 10px 26px rgba(0,0,0,.5);';
        document.body.appendChild(chip);
        if (window.lucide) lucide.createIcons();
    }
}
loadUCs();
loadTerritorio();
loadWeather();
rainBindModal();
checkRainAlerts();
setInterval(checkRainAlerts, 10 * 60 * 1000);
renderAreas();
applyChecks();

// Renderiza ícones Lucide do DOM inicial e após cada popup do Leaflet ser aberto
if (window.lucide) lucide.createIcons();
map.on('popupopen', () => { if (window.lucide) lucide.createIcons(); });

// Foco por hash vindo de outras páginas: #lat,lng[,zoom]
(function focusFromHash() {
    const m = location.hash.replace('#', '').match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d{1,2}))?$/);
    if (m) {
        map.setView([+m[1], +m[2]], +(m[3] || 10));
    }
})();

setTimeout(() => map.invalidateSize(), 300);

/* ================= Painel Climático em Tempo Real ================= */
(function climatePanel() {
    const el = {
        time: document.getElementById('cpTime'),
        temp: document.getElementById('cpTemp'),
        hum: document.getElementById('cpHum'),
        wind: document.getElementById('cpWind'),
        fogos: document.getElementById('cpFogos'),
        chuva: document.getElementById('cpChuva'),
        uv: document.getElementById('cpUV'),
    };
    if (!el.temp) return;

    function fmt() { return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }

    // Open-Meteo: Cuiabá (capital) — temperatura, umidade, vento, chuva, UV
    async function loadOpenMeteo() {
        try {
            const r = await dcProxyFetch('https://api.open-meteo.com/v1/forecast?latitude=-15.588&longitude=-56.097&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,uv_index&timezone=America/Cuiaba');
            if (!r.ok) throw 0;
            const d = await r.json();
            const c = d.current;
            el.temp.textContent = Math.round(c.temperature_2m) + '°C';
            el.hum.textContent = c.relative_humidity_2m + '%';
            el.wind.textContent = Math.round(c.wind_speed_10m) + ' km/h';
            el.chuva.textContent = (c.precipitation ?? 0) + ' mm';
            el.uv.textContent = Math.round(c.uv_index ?? 0);
        } catch { el.temp.textContent = '—'; }
    }

    // INPE: contagem de focos (UF selecionada ou Brasil)
    async function loadFogos() {
        try {
            const iso = new Date().toISOString().slice(0, 10).replaceAll('-', '');
            const r = await dcProxyFetch(`https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/focos_diario_br_${iso}.csv`);
            if (!r.ok) throw 0;
            const txt = await r.text();
            const lines = txt.split('\n');
            const h = lines[0].split(',').map(x => x.trim());
            const iUF = h.indexOf('estado');
            const nomeUF = (typeof ufNomeCorrente === 'function' && ufNomeCorrente()) || null;
            const n = lines.slice(1).filter(l => {
                if (l.trim().length < 10) return false;
                if (!nomeUF) return true;
                const c = l.split(',');
                return (c[iUF] || '').trim().toUpperCase() === nomeUF;
            }).length;
            el.fogos.textContent = n.toLocaleString('pt-BR');
        } catch { el.fogos.textContent = '—'; }
    }

    function refresh() {
        loadOpenMeteo();
        loadFogos();
        el.time.textContent = fmt();
    }

    refresh();
    setInterval(refresh, 10 * 60 * 1000);
})();

