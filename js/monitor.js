/* ============================================================
   Monitor inteligente de alertas — Defesa Civil MT.
   Roda em qualquer página (requer js/proxy.js para dcProxyFetch).
   - Monitora clima em 8 cidades de MT, novos focos INPE e novos
     eventos SIPAM a cada 5 min.
   - "Inteligência": além de limiares fixos, cruza temperatura +
     umidade + vento num índice de risco combinado (a mesma lógica
     usada no mapa para risco de fogo), e evita repetir o mesmo
     alerta em sequência (cooldown por cidade+tipo).
   - Mostra um popup automático (canto inferior) e mantém um
     histórico local (últimos 50) acessível via window.dcMonitor.
   ============================================================ */
(function (global) {
    if (global.__dcMonitorLoaded) return; // evita duplicar se incluído 2x
    global.__dcMonitorLoaded = true;

    const MON_CITIES = [
        { nome: 'Cuiabá', lat: -15.588, lon: -56.097 },
        { nome: 'Sinop', lat: -11.860, lon: -55.510 },
        { nome: 'Rondonópolis', lat: -16.471, lon: -54.637 },
        { nome: 'Sorriso', lat: -12.545, lon: -55.727 },
        { nome: 'Cáceres', lat: -16.076, lon: -57.681 },
        { nome: 'Tangará da Serra', lat: -14.620, lon: -57.426 },
        { nome: 'Primavera do Leste', lat: -15.527, lon: -54.284 },
        { nome: 'Barra do Garças', lat: -15.891, lon: -52.262 },
    ];
    const THRESHOLDS = {
        temp: { critico: 40, alto: 35, varCritico: 6, varAlto: 4 },
        wind: { critico: 60, alto: 45, varCritico: 25, varAlto: 15 },
        humidity: { critico: 15, dropAlto: 20 },
        uv: { critico: 11, alto: 8 },
    };
    const COOLDOWN_MS = 20 * 60 * 1000; // não repete o mesmo alerta por 20 min
    const HISTORY_KEY = 'dcmt_monitor_history';
    const HISTORY_MAX = 50;

    let prevByCity = {};
    let queue = [];
    let showing = false;
    let cooldowns = {};
    let sipamIds = [];
    let focoKeys = [];
    let firstRun = true;

    /* ================= UI (injetada, sem depender do HTML da página) ================= */
    function injectStyles() {
        const css = `
        #dcm-popup { position: fixed; bottom: 18px; left: 16px; z-index: 9999;
            width: 320px; max-width: calc(100vw - 32px);
            background: rgba(30,41,59,.92); backdrop-filter: blur(16px);
            border-radius: 12px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,.5);
            opacity: 0; transform: translateY(20px); pointer-events: none;
            transition: all .35s cubic-bezier(.4,0,.2,1);
            border: 1px solid rgba(148,163,184,.15); font-family: 'Inter', sans-serif; }
        #dcm-popup.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
        #dcm-popup.sev-critico { border-left: 4px solid #ef4444; }
        #dcm-popup.sev-alto { border-left: 4px solid #f9731c; }
        #dcm-popup.sev-medio { border-left: 4px solid #fbbf24; }
        #dcm-popup.sev-info { border-left: 4px solid #38bdf8; }
        #dcm-popup.sev-critico.show { animation: dcmPulse 2s ease-in-out infinite; }
        @keyframes dcmPulse { 0%,100%{box-shadow:0 12px 40px rgba(0,0,0,.5)} 50%{box-shadow:0 12px 40px rgba(0,0,0,.5),0 0 0 3px rgba(239,68,68,.2)} }
        .dcm-head { display:flex; align-items:center; gap:10px; padding:12px 14px 8px; }
        .dcm-icon { width:36px; height:36px; border-radius:10px; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:16px; color:#f1f5f9; }
        .dcm-title { font-size:12px; font-weight:700; color:#f1f5f9; }
        .dcm-city { font-size:10px; color:#94a3b8; font-weight:500; }
        .dcm-body { padding:0 14px 10px; font-size:11px; color:#94a3b8; line-height:1.5; }
        .dcm-foot { display:flex; justify-content:space-between; align-items:center; padding:8px 14px; border-top:1px solid rgba(255,255,255,.05); }
        .dcm-time { font-size:9px; color:#94a3b8; }
        .dcm-close { background:none; border:none; color:#94a3b8; cursor:pointer; font-size:14px; padding:4px; line-height:1; }
        .dcm-close:hover { color:#f1f5f9; }
        .dcm-sev { font-size:8px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; padding:2px 6px; border-radius:4px; }
        .dcm-sev.critico { background:rgba(239,68,68,.15); color:#ef4444; }
        .dcm-sev.alto { background:rgba(249,115,22,.15); color:#f9731c; }
        .dcm-sev.medio { background:rgba(251,191,36,.15); color:#fbbf24; }
        .dcm-sev.info { background:rgba(56,189,248,.15); color:#38bdf8; }
        #dcm-bell { position:fixed; bottom:18px; left:16px; z-index:9998;
            width:38px; height:38px; border-radius:50%; background:rgba(30,41,59,.92);
            border:1px solid rgba(148,163,184,.15); color:#94a3b8; display:flex;
            align-items:center; justify-content:center; cursor:pointer; font-size:15px;
            box-shadow:0 6px 20px rgba(0,0,0,.35); }
        #dcm-bell .dcm-badge { position:absolute; top:-4px; right:-4px; background:#ef4444; color:#fff;
            font-size:9px; font-weight:800; border-radius:8px; padding:1px 5px; display:none; }
        #dcm-bell .dcm-badge.show { display:block; }
        #dcm-history { position:fixed; bottom:64px; left:16px; z-index:9998; width:320px;
            max-width:calc(100vw - 32px); max-height:340px; overflow-y:auto;
            background:rgba(15,23,42,.96); backdrop-filter:blur(16px); border-radius:12px;
            border:1px solid rgba(148,163,184,.15); box-shadow:0 12px 40px rgba(0,0,0,.5);
            display:none; padding:8px; }
        #dcm-history.show { display:block; }
        #dcm-history h5 { font-size:11px; color:#f1f5f9; font-weight:700; padding:6px 8px; }
        .dcm-hitem { padding:8px; border-radius:8px; font-size:11px; color:#cbd5e1; }
        .dcm-hitem:hover { background:rgba(255,255,255,.04); }
        .dcm-hitem b { color:#f1f5f9; }
        .dcm-hitem span { display:block; font-size:9.5px; color:#64748b; margin-top:2px; }
        .dcm-hempty { text-align:center; color:#64748b; font-size:11px; padding:18px; }
        `;
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    const ICON_SVG = {
        temp: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
        wind: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2M9.6 4.6A2 2 0 1 1 11 8H2m10.6 12.4a2 2 0 1 0 1.4-3.4H2"/>',
        rain: '<path d="M20 16.2A4.5 4.5 0 0 0 17.5 8h-1.8A7 7 0 1 0 4 14.9M16 14v6M8 14v6M12 16v6"/>',
        humidity: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5C13.5 7.3 12 4 12 2c0 2-1.5 5.3-4 7.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7Z"/>',
        fire: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1 1-2.3 2.6-2.3 4.5 0 .7.3 1.4.8 2M12 22c4 0 7-2.5 7-6.2 0-2.6-1.5-4.5-3-6.3-.5.9-1.2 1.7-2.2 2.3C13.8 8.5 12 6 12 3c-2 2-6 6-6 11.5C6 18.5 8.5 22 12 22Z"/>',
        event: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        uv: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
        pressure: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 0v-3m8-3.5A9 9 0 1 0 4 12"/>',
        risco: '<path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>',
        bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    };
    const ICON_COLOR = { temp: '#ef4444', wind: '#94a3b8', rain: '#38bdf8', humidity: '#38bdf8', fire: '#f9731c', event: '#ef4444', uv: '#fbbf24', pressure: '#94a3b8', risco: '#f9731c' };

    function svgIcon(type) {
        const path = ICON_SVG[type] || ICON_SVG.event;
        return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    }

    let els = {};
    function ensureUI() {
        if (document.getElementById('dcm-popup')) return;
        injectStyles();

        const popup = document.createElement('div');
        popup.id = 'dcm-popup';
        popup.innerHTML = `
            <div class="dcm-head">
                <div class="dcm-icon" id="dcmIcon"></div>
                <div><div class="dcm-title" id="dcmTitle">—</div><div class="dcm-city" id="dcmCity">—</div></div>
            </div>
            <div class="dcm-body" id="dcmBody">—</div>
            <div class="dcm-foot">
                <span class="dcm-sev" id="dcmSev">INFO</span>
                <span class="dcm-time" id="dcmTime">—</span>
                <button class="dcm-close" id="dcmClose">✕</button>
            </div>`;
        document.body.appendChild(popup);

        const bell = document.createElement('div');
        bell.id = 'dcm-bell';
        bell.title = 'Histórico de alertas do monitoramento inteligente';
        bell.innerHTML = svgIcon('bell') + '<span class="dcm-badge" id="dcmBadge">0</span>';
        document.body.appendChild(bell);

        const hist = document.createElement('div');
        hist.id = 'dcm-history';
        document.body.appendChild(hist);

        els = {
            popup, bell, hist,
            icon: document.getElementById('dcmIcon'),
            title: document.getElementById('dcmTitle'),
            city: document.getElementById('dcmCity'),
            body: document.getElementById('dcmBody'),
            sev: document.getElementById('dcmSev'),
            time: document.getElementById('dcmTime'),
            close: document.getElementById('dcmClose'),
            badge: document.getElementById('dcmBadge'),
        };

        els.close.addEventListener('click', () => {
            popup.classList.remove('show');
            showing = false;
            setTimeout(showNext, 300);
        });
        bell.addEventListener('click', () => {
            hist.classList.toggle('show');
            if (hist.classList.contains('show')) renderHistory();
        });
        document.addEventListener('click', (e) => {
            if (!hist.contains(e.target) && !bell.contains(e.target)) hist.classList.remove('show');
        });
    }

    /* ================= Histórico local ================= */
    function loadHistory() {
        try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { return []; }
    }
    function saveHistory(list) {
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-HISTORY_MAX))); } catch (e) {}
    }
    function pushHistory(alert) {
        const list = loadHistory();
        list.push(alert);
        saveHistory(list);
        updateBadge();
    }
    function updateBadge() {
        const list = loadHistory();
        const umaHoraAtras = Date.now() - 3600000;
        const recentes = list.filter(a => a.ts >= umaHoraAtras).length;
        if (!els.badge) return;
        els.badge.textContent = recentes > 99 ? '99+' : String(recentes);
        els.badge.classList.toggle('show', recentes > 0);
    }
    function renderHistory() {
        const list = loadHistory().slice().reverse();
        if (!list.length) {
            els.hist.innerHTML = '<div class="dcm-hempty">Nenhum alerta registrado ainda.</div>';
            return;
        }
        els.hist.innerHTML = '<h5>Histórico de alertas (últimos ' + list.length + ')</h5>' +
            list.map(a => `
                <div class="dcm-hitem">
                    <b>${a.title}</b> — ${a.city}
                    <span>${new Date(a.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${a.desc}</span>
                </div>`).join('');
    }

    /* ================= Fila / exibição ================= */
    function queueAlert(alert) {
        const key = alert.type + '|' + alert.city + '|' + alert.severity;
        const now = Date.now();
        if (cooldowns[key] && now - cooldowns[key] < COOLDOWN_MS) return; // evita repetir o mesmo alerta
        cooldowns[key] = now;
        pushHistory(alert);
        queue.push(alert);
        if (queue.length > 20) queue = queue.slice(-20);
        if (!showing) showNext();
    }

    function showNext() {
        if (!els.popup) return;
        if (!queue.length || showing) return;
        showing = true;
        const a = queue.shift();
        els.popup.className = 'sev-' + a.severity + ' show';
        els.icon.innerHTML = svgIcon(a.type);
        els.icon.style.background = (ICON_COLOR[a.type] || '#f9731c') + '26';
        els.icon.style.color = ICON_COLOR[a.type] || '#f9731c';
        els.title.textContent = a.title;
        els.city.textContent = a.city;
        els.body.textContent = a.desc;
        els.sev.className = 'dcm-sev ' + a.severity;
        els.sev.textContent = { critico: 'CRÍTICO', alto: 'ALTO', medio: 'MÉDIO' }[a.severity] || 'INFO';
        els.time.textContent = new Date(a.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        clearTimeout(els.popup._timer);
        els.popup._timer = setTimeout(() => {
            els.popup.classList.remove('show');
            showing = false;
            setTimeout(showNext, 400);
        }, 7000);
    }

    /* ================= Coleta de dados ================= */
    async function fetchCityWeather(city) {
        try {
            const r = await dcProxyFetch(`https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,precipitation,surface_pressure,uv_index&timezone=America/Cuiaba`);
            if (!r.ok) return null;
            const d = await r.json();
            const c = d.current;
            return { temp: c.temperature_2m, humidity: c.relative_humidity_2m, wind: c.wind_speed_10m, gusts: c.wind_gusts_10m || 0, rain: c.precipitation, pressure: c.surface_pressure, uv: c.uv_index };
        } catch (e) { return null; }
    }

    /* Índice de risco combinado (mesma heurística do overlay de fogo do mapa):
       cruza temperatura + umidade + vento num único score de 0-100, permitindo
       detectar condições perigosas mesmo quando nenhuma variável isolada
       ultrapassa seu limiar individual. */
    function combinedRiskScore(curr) {
        let risco = 0;
        if (curr.temp > 35) risco += 10; else if (curr.temp > 30) risco += 5;
        if (curr.humidity < 20) risco += 35; else if (curr.humidity < 30) risco += 25; else if (curr.humidity < 50) risco += 12;
        if (curr.wind > 30) risco += 30; else if (curr.wind > 20) risco += 20; else if (curr.wind > 10) risco += 8;
        if (curr.rain > 5) risco = Math.max(0, risco - 20);
        return Math.min(100, Math.max(0, risco));
    }

    function detectAlerts(city, prev, curr) {
        const alerts = [];
        const T = THRESHOLDS;
        if (prev) {
            const dTemp = curr.temp - prev.temp;
            if (Math.abs(dTemp) >= T.temp.varCritico) alerts.push({ type: 'temp', severity: 'critico', title: `Temperatura ${dTemp > 0 ? 'subiu' : 'caiu'} ${Math.abs(dTemp).toFixed(1)}°C`, desc: `De ${Math.round(prev.temp)}°C para ${Math.round(curr.temp)}°C`, city: city.nome, ts: Date.now() });
            else if (Math.abs(dTemp) >= T.temp.varAlto) alerts.push({ type: 'temp', severity: 'alto', title: `Temperatura variou ${Math.abs(dTemp).toFixed(1)}°C`, desc: `De ${Math.round(prev.temp)}°C para ${Math.round(curr.temp)}°C`, city: city.nome, ts: Date.now() });

            const dWind = curr.wind - prev.wind;
            if (Math.abs(dWind) >= T.wind.varCritico) alerts.push({ type: 'wind', severity: 'critico', title: `Vento ${dWind > 0 ? 'aumentou' : 'diminuiu'} ${Math.abs(dWind).toFixed(0)} km/h`, desc: `De ${Math.round(prev.wind)} para ${Math.round(curr.wind)} km/h`, city: city.nome, ts: Date.now() });
            else if (Math.abs(dWind) >= T.wind.varAlto) alerts.push({ type: 'wind', severity: 'alto', title: `Vento variou ${Math.abs(dWind).toFixed(0)} km/h`, desc: `De ${Math.round(prev.wind)} para ${Math.round(curr.wind)} km/h`, city: city.nome, ts: Date.now() });

            const dHum = curr.humidity - prev.humidity;
            if (dHum <= -T.humidity.dropAlto) alerts.push({ type: 'humidity', severity: 'alto', title: `Umidade caiu ${Math.abs(dHum)}%`, desc: `De ${prev.humidity}% para ${curr.humidity}%`, city: city.nome, ts: Date.now() });

            if (prev.pressure && curr.pressure) {
                const pDrop = prev.pressure - curr.pressure;
                if (pDrop >= 8) alerts.push({ type: 'pressure', severity: 'critico', title: `Pressão caiu ${pDrop.toFixed(1)} hPa`, desc: 'Tempestade possível', city: city.nome, ts: Date.now() });
                else if (pDrop >= 5) alerts.push({ type: 'pressure', severity: 'alto', title: `Pressão reduziu ${pDrop.toFixed(1)} hPa`, desc: `De ${Math.round(prev.pressure)} para ${Math.round(curr.pressure)} hPa`, city: city.nome, ts: Date.now() });
            }
            if (curr.rain > 0 && prev.rain === 0) alerts.push({ type: 'rain', severity: 'info', title: 'Precipitação iniciada', desc: `${curr.rain} mm detectado`, city: city.nome, ts: Date.now() });
            if (curr.uv >= T.uv.critico && (prev.uv == null || prev.uv < T.uv.critico)) alerts.push({ type: 'uv', severity: 'alto', title: `UV extremo: ${curr.uv}`, desc: 'Evite exposição solar', city: city.nome, ts: Date.now() });
        }

        if (curr.temp >= T.temp.critico) alerts.push({ type: 'temp', severity: 'critico', title: `Temperatura extrema: ${Math.round(curr.temp)}°C`, desc: 'Acima de 40°C — risco à saúde', city: city.nome, ts: Date.now() });
        else if (curr.temp >= T.temp.alto) alerts.push({ type: 'temp', severity: 'alto', title: `Temperatura alta: ${Math.round(curr.temp)}°C`, desc: 'Acima de 35°C', city: city.nome, ts: Date.now() });
        if (curr.gusts >= T.wind.critico + 15) alerts.push({ type: 'wind', severity: 'critico', title: `Rajadas extremas: ${Math.round(curr.gusts)} km/h`, desc: 'Perigo para estruturas e transporte', city: city.nome, ts: Date.now() });
        else if (curr.wind >= T.wind.alto) alerts.push({ type: 'wind', severity: 'alto', title: `Vento forte: ${Math.round(curr.wind)} km/h`, desc: 'Possíveis danos leves', city: city.nome, ts: Date.now() });
        if (curr.humidity <= T.humidity.critico) alerts.push({ type: 'humidity', severity: 'critico', title: `Umidade crítica: ${curr.humidity}%`, desc: 'Seca extrema — risco de incêndio', city: city.nome, ts: Date.now() });

        // Alerta "inteligente" combinado — só dispara quando nenhum limiar isolado
        // já cobriu o mesmo cenário, evitando alertas redundantes.
        const score = combinedRiskScore(curr);
        if (score >= 70 && curr.temp < T.temp.alto && curr.humidity > T.humidity.critico) {
            alerts.push({ type: 'risco', severity: 'alto', title: `Risco combinado elevado: ${score}%`, desc: `Temp ${Math.round(curr.temp)}°C + umidade ${curr.humidity}% + vento ${Math.round(curr.wind)} km/h juntos aumentam o risco de incêndio`, city: city.nome, ts: Date.now() });
        }
        return alerts;
    }

    async function detectNewFocos() {
        try {
            const iso = new Date().toISOString().slice(0, 10).replaceAll('-', '');
            const res = await dcProxyFetch(`https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/focos_diario_br_${iso}.csv`);
            if (!res.ok) return;
            const txt = await res.text();
            const lines = txt.split('\n');
            const header = lines[0].split(',').map(h => h.trim());
            const iLat = header.indexOf('lat'), iLon = header.indexOf('lon'), iUF = header.indexOf('estado');
            const current = [];
            for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',');
                if (cols.length < header.length - 2) continue;
                if ((cols[iUF] || '').trim().toUpperCase() !== 'MATO GROSSO') continue;
                const lat = parseFloat(cols[iLat]), lon = parseFloat(cols[iLon]);
                if (isFinite(lat) && isFinite(lon)) current.push(`${lat.toFixed(3)},${lon.toFixed(3)}`);
            }
            if (focoKeys.length > 0) {
                const newOnes = current.filter(k => !focoKeys.includes(k));
                if (newOnes.length > 0) {
                    queueAlert({ type: 'fire', severity: newOnes.length > 5 ? 'critico' : newOnes.length > 2 ? 'alto' : 'medio', title: `${newOnes.length} novo(s) foco(s) detectado(s)`, desc: 'INPE identificou novos pontos de calor em MT', city: 'Estado de MT', ts: Date.now() });
                }
            }
            focoKeys = current;
        } catch (e) {}
    }

    async function detectNewSipam() {
        try {
            const res = await dcProxyFetch('https://panorama.sipam.gov.br/painel-do-fogo/api/v1/eventos?sigla_estado=MT');
            if (!res.ok) return;
            const eventos = await res.json();
            if (!Array.isArray(eventos)) return;
            const ids = eventos.map(e => e.id_evento);
            if (sipamIds.length > 0) {
                eventos.filter(e => !sipamIds.includes(e.id_evento)).forEach(ev => {
                    queueAlert({ type: 'event', severity: ev.status_evento === 'Ativo' ? 'alto' : 'medio', title: `Novo evento SIPAM #${ev.id_evento}`, desc: `${ev.status_evento} — ${ev.municipio || 'MT'} — ${ev.area_total_evento ? ev.area_total_evento.toFixed(1) + ' ha' : '—'}`, city: ev.municipio || 'MT', ts: Date.now() });
                });
            }
            sipamIds = ids;
        } catch (e) {}
    }

    async function runCycle() {
        const results = await Promise.all(MON_CITIES.map(fetchCityWeather));
        MON_CITIES.forEach((city, i) => {
            const curr = results[i];
            if (!curr) return;
            const prev = prevByCity[city.nome];
            detectAlerts(city, prev, curr).forEach(queueAlert);
            prevByCity[city.nome] = curr;
        });

        await Promise.all([detectNewFocos(), detectNewSipam()]);

        if (firstRun) {
            firstRun = false;
            const okCities = MON_CITIES.filter(c => prevByCity[c.nome]).length;
            queueAlert({ type: 'event', severity: 'info', title: 'Monitoramento Ativo', desc: `${okCities} de ${MON_CITIES.length} cidades conectadas · Ciclo a cada 5 min`, city: 'Defesa Civil MT', ts: Date.now() });
        }
        setTimeout(runCycle, 5 * 60 * 1000);
    }

    function init() {
        if (typeof dcProxyFetch === 'undefined') return; // requer js/proxy.js na página
        ensureUI();
        updateBadge();
        setTimeout(runCycle, 4000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    global.dcMonitor = {
        getHistory: loadHistory,
        queueAlert,
    };
})(window);
