/* SGI PROTEGE - Mapa Integrado (9/14): mapa-areas. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= Áreas de interesse ================= */
let areas = JSON.parse(localStorage.getItem('dcmt_areas') || '[]');
let drawing = false, drawPts = [];
let drawPreview = null;

const drawBtn = document.getElementById('drawBtn');
const drawBar = document.getElementById('drawBar');

drawBtn.addEventListener('click', () => {
    if (!drawing) startDrawing();
});

function startDrawing() {
    drawing = true; drawPts = [];
    drawBtn.classList.add('active');
    map.getContainer().classList.add('drawing');
    drawBar.classList.add('show');
    document.getElementById('drawCount').textContent = '0';
    stopPlaying();
    toast('Desenhando área de interesse: clique no mapa para adicionar vértices.', true);
}

document.getElementById('drawDone').addEventListener('click', finishDrawing);
document.getElementById('drawCancel').addEventListener('click', cancelDrawing);

let wazePopup = null;
map.on('click', e => {
    if (drawing) {
        drawPts.push([e.latlng.lat, e.latlng.lng]);
        document.getElementById('drawCount').textContent = drawPts.length;
        redrawPreview();
        return;
    }
    const { lat, lng } = e.latlng;
    setTimeout(() => {
        const activePopup = map._popup;
        if (activePopup && activePopup.isOpen() && activePopup !== wazePopup) {
            if (wazePopup) { map.closePopup(wazePopup); wazePopup = null; }
            return;
        }
        if (wazePopup) { map.closePopup(wazePopup); wazePopup = null; }
        const url = `https://www.waze.com/ul?ll=${lat.toFixed(6)},${lng.toFixed(6)}&navigate=yes&zoom=17`;
        wazePopup = L.popup({ maxWidth: 240, className: 'waze-nav-popup' })
            .setLatLng(e.latlng)
            .setContent(`
                <div style="text-align:center;padding:2px 0;">
                    <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">
                        <i data-lucide="map-pin" style="color:#ef4444;"></i> ${lat.toFixed(4)}, ${lng.toFixed(4)}
                    </div>
                    <a href="${url}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;background:linear-gradient(135deg,#33ccff,#0099ff);color:#fff;font-size:12px;font-weight:700;border-radius:8px;text-decoration:none;transition:transform .15s,box-shadow .15s;" onmouseover="this.style.transform='scale(1.05)';this.style.boxShadow='0 4px 20px rgba(0,153,255,.5)';" onmouseout="this.style.transform='';this.style.boxShadow='';">
                        <i data-lucide="navigation"></i> Navegar com Waze
                    </a>
                </div>
            `)
            .openOn(map);
    }, 60);
});
map.on('dblclick', () => { if (drawing) finishDrawing(); });

function redrawPreview() {
    if (drawPreview) map.removeLayer(drawPreview);
    if (drawPts.length >= 2) {
        drawPreview = L.polygon(drawPts.length >= 3 ? drawPts : [...drawPts, drawPts[0]], {
            color: '#f9631c', weight: 2, dashArray: '6 4', fillOpacity: .12
        }).addTo(map);
    } else if (drawPts.length === 1) {
        drawPreview = L.circleMarker(drawPts[0], { radius: 4, color: '#f9631c' }).addTo(map);
    }
}

function finishDrawing() {
    if (drawPts.length < 3) { toast('Adicione pelo menos 3 vértices para formar uma área.'); return; }
    const ringGeo = [...drawPts.map(p => [p[1], p[0]]), [drawPts[0][1], drawPts[0][0]]];
    const areaKm2 = geomAreaKm2({ type: 'Polygon', coordinates: [ringGeo] });
    const estacoes = dcStations.filter(s => pointInAnyPolygon(s.lat, s.lng, drawPts)).length;
    areas.push({
        id: Date.now(),
        nome: 'Área de interesse ' + (areas.length + 1),
        coords: drawPts.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]),
        areaKm2: Math.round(areaKm2),
        estacoes
    });
    localStorage.setItem('dcmt_areas', JSON.stringify(areas));
    endDrawingState();
    renderAreas();
    toast(`<b>${areas.at(-1).nome}</b> criada — ${estacoes} estação(ões) monitorada(s) dentro dela.`, true);
}
function cancelDrawing() { endDrawingState(); }
function endDrawingState() {
    drawing = false; drawPts = [];
    drawBtn.classList.remove('active');
    map.getContainer().classList.remove('drawing');
    drawBar.classList.remove('show');
    if (drawPreview) { map.removeLayer(drawPreview); drawPreview = null; }
    if (activeOverlay !== 'none' && !playing) startPlaying();
}

function pointInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][1], yi = ring[i][0], xj = ring[j][1], yj = ring[j][0];
        if (((yi > lat) != (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
}
function pointInAnyPolygon(lat, lng, pts) {
    return pointInRing(lat, lng, pts.concat([pts[0]]));
}

function renderAreas() {
    const list = document.getElementById('areasList');
    list.innerHTML = '';
    if (!areas.length) {
        list.innerHTML = '<div class="areas-empty">Nenhuma área criada. Desenhe uma região no mapa para acompanhar estações e receber alertas relacionados.</div>';
        return;
    }
    areas.forEach(a => {
        const div = document.createElement('div');
        div.className = 'area-item';
        div.innerHTML = `
            <i data-lucide="pentagon"></i>
            <div class="ai-info">
                <b>${a.nome}</b>
                <span>${a.areaKm2.toLocaleString('pt-BR')} km² · ${a.estacoes} estação(ões)</span>
            </div>
            <button title="Centralizar" aria-label="Centralizar"><i data-lucide="crosshair"></i></button>
            <button title="Excluir" aria-label="Excluir"><i data-lucide="trash-2"></i></button>
            <button title="Monitorar no servidor" aria-label="Monitorar"><i data-lucide="bell-ring"></i></button>`;
        const [zoomBtn, delBtn, monBtn] = div.querySelectorAll('button');
        if (a.serverId) monBtn.style.cssText += ';color:#4ade80;border-color:rgba(74,222,128,.4);';
        monBtn.addEventListener('click', () => {
            if (a.serverId) desmonitorarArea(a);
            else monitorarArea(a);
        });
        zoomBtn.addEventListener('click', () => {
            const poly = L.polygon(a.coords);
            map.flyToBounds(poly.getBounds().pad(0.4), { duration: .8 });
            const shape = L.polygon(a.coords, { color: '#f9631c', fillOpacity: .1, weight: 2 })
                           .addTo(map).bindTooltip(a.nome);
            setTimeout(() => map.removeLayer(shape), 5000);
        });
        delBtn.addEventListener('click', () => {
            if (a.serverId) {
                fetch(apiUrl('/api/areas-monitoradas?id=' + encodeURIComponent(a.serverId)), {
                    method: 'DELETE',
                    headers: tokenSessao() ? { Authorization: 'Bearer ' + tokenSessao() } : {},
                }).catch(() => {});
            }
            areas = areas.filter(x => x.id !== a.id);
            localStorage.setItem('dcmt_areas', JSON.stringify(areas));
            renderAreas();
        });
        list.appendChild(div);
    });
    if (window.lucide) lucide.createIcons();
}

/* ================= Alertas ativos — áreas, eventos, push (Fase 5) ================
   Áreas desenhadas podem ser monitoradas no servidor (regras por área);
   eventos chegam na fila lateral com banner + som; Web Push via sw.js. */
function tokenSessao() {
    try { return localStorage.getItem('dcmt_token'); } catch (e) { return null; }
}
function bboxDeCoords(coords) {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    (coords || []).forEach(p => {
        const lat = +p[0], lon = +p[1];
        if (!isFinite(lat) || !isFinite(lon)) return;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
    });
    if (minLat > maxLat) return null;
    return { minLat, maxLat, minLon, maxLon };
}
async function monitorarArea(a) {
    try {
        const r = await fetch(apiUrl('/api/areas-monitoradas'), {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' },
                tokenSessao() ? { Authorization: 'Bearer ' + tokenSessao() } : {}),
            body: JSON.stringify({
                nome: a.nome, coords: a.coords, bbox: bboxDeCoords(a.coords),
                uf: (typeof ufSiglaCorrente === 'function' ? ufSiglaCorrente() : null),
            }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j && j.erro) || ('HTTP ' + r.status));
        a.serverId = j.area.id;
        localStorage.setItem('dcmt_areas', JSON.stringify(areas));
        renderAreas();
        toast('Área <b>' + a.nome + '</b> em monitoramento (foco novo + aviso INMET).', true);
    } catch (e) {
        toast('Falha ao monitorar: ' + e.message + (tokenSessao() ? '' : ' (entre com login).'));
    }
}
async function desmonitorarArea(a) {
    if (!a.serverId) return;
    try {
        await fetch(apiUrl('/api/areas-monitoradas?id=' + encodeURIComponent(a.serverId)), {
            method: 'DELETE',
            headers: tokenSessao() ? { Authorization: 'Bearer ' + tokenSessao() } : {},
        });
    } catch (e) {}
    a.serverId = null;
    localStorage.setItem('dcmt_areas', JSON.stringify(areas));
    renderAreas();
}

const SEV_COR = { medio: '#eab308', alto: '#f97316', critico: '#ef4444' };
let eventosVistos = new Set();
let eventosTimer = null;
let primeiraCargaEventos = true;
let audioCtx = null;
function beepAlerta() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        const ctx = audioCtx;
        [0, 0.25].forEach((t, i) => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination);
            o.frequency.value = i ? 660 : 880;
            o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.2);
        });
    } catch (e) {}
}
function bannerAlerta(ev) {
    const b = document.getElementById('alertaBanner');
    if (!b) return;
    b.setAttribute('style', 'display:block;background:rgba(127,29,29,.92);border:1px solid #ef4444;border-radius:10px;padding:10px 12px;margin-top:8px;font-size:12px;');
    b.innerHTML = `<b style="color:#fecaca;">${(ev.severidade || 'info').toUpperCase()} · ${ev.areaNome || ''}</b><br>${ev.titulo}<br><button class="mini-btn" id="alertaBannerOk" style="margin-top:6px;">Entendi</button>`;
    const ok = document.getElementById('alertaBannerOk');
    if (ok) ok.addEventListener('click', () => { b.style.display = 'none'; });
    beepAlerta();
}
async function carregarEventos() {
    const lista = document.getElementById('eventosLista');
    if (!lista) return;
    try {
        const uf = (document.getElementById('evFiltroUf') || {}).value || '';
        const tipo = (document.getElementById('evFiltroTipo') || {}).value || '';
        const r = await fetch(apiUrl('/api/alertas-motor/eventos?limit=30' + (uf ? '&uf=' + uf : '') + (tipo ? '&tipo=' + tipo : '')));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const evs = j.eventos || [];
        if (!evs.length) {
            lista.innerHTML = '<div style="color:#94a3b8;font-size:11px;">Sem eventos. O motor avalia a cada 15 min.</div>';
            return;
        }
        lista.innerHTML = '';
        evs.forEach(ev => {
            const div = document.createElement('div');
            const cor = SEV_COR[ev.severidade] || '#eab308';
            const ja = ev.estado === 'reconhecido';
            div.style.cssText = 'border:1px solid var(--border-color);border-left:3px solid ' + cor + ';border-radius:8px;padding:8px 10px;font-size:11.5px;' + (ja ? 'opacity:.6;' : '');
            div.innerHTML = `<b>${ev.titulo}</b><br><span style="color:#94a3b8;">${ev.areaNome} · ${new Date(ev.criadoEm).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${ev.severidade}</span>`
                + (ja ? `<br><span style="color:#4ade80;">✓ reconhecido</span>` : `<br><button class="mini-btn" data-rec="${ev.id}" style="margin-top:6px;">Reconhecer</button>`);
            lista.appendChild(div);
            if (!ja && !eventosVistos.has(ev.id)) {
                eventosVistos.add(ev.id);
                if (!primeiraCargaEventos) bannerAlerta(ev);
            }
        });
        primeiraCargaEventos = false;
        lista.querySelectorAll('[data-rec]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!tokenSessao()) { toast('Entre com login para reconhecer.'); return; }
                await fetch(apiUrl('/api/alertas-motor/reconhecer'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenSessao() },
                    body: JSON.stringify({ id: btn.getAttribute('data-rec') }),
                });
                carregarEventos();
            });
        });
        if (window.lucide) lucide.createIcons();
    } catch (e) {
        lista.innerHTML = '<div style="color:#94a3b8;font-size:11px;">Eventos indisponíveis.</div>';
    }
}
function agendaEventos() {
    if (eventosTimer) clearInterval(eventosTimer);
    eventosTimer = setInterval(() => { if (!document.hidden) carregarEventos(); }, 5 * 60 * 1000);
}
async function ativarPush() {
    try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            toast('Este navegador não suporta notificações push.'); return;
        }
        const reg = await navigator.serviceWorker.register('/sw.js');
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { toast('Permissão de notificação negada.'); return; }
        const cfg = await (await fetch(apiUrl('/api/push/config'))).json();
        if (!cfg.ativo) { toast('Push desativado no servidor (VAPID).'); return; }
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: cfg.vapidPublicKey,
        });
        const r = await fetch(apiUrl('/api/push/subscrever'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON() }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        toast('Notificações <b>ativadas</b> neste dispositivo.', true);
    } catch (e) {
        toast('Falha ao ativar: ' + e.message);
    }
}
// preenche filtro de UF com os estados carregados
let _ufTentativas = 0;
function popularFiltroUfEventos() {
    const sel = document.getElementById('evFiltroUf');
    if (!sel) return;
    if (sel.options.length > 1) return;
    try {
        const estados = (typeof ibgeStates !== 'undefined' && ibgeStates) ? ibgeStates : [];
        if (!estados.length && ++_ufTentativas < 20) {
            setTimeout(popularFiltroUfEventos, 3000);
            return;
        }
        estados.forEach(e => {
            const o = document.createElement('option');
            o.value = e.sigla; o.textContent = e.sigla;
            sel.appendChild(o);
        });
    } catch (e) {}
}
(function initAlertasUI() {
    try {
        const pushBtn = document.getElementById('pushBtn');
        if (pushBtn) pushBtn.addEventListener('click', ativarPush);
        const fUf = document.getElementById('evFiltroUf');
        const fTipo = document.getElementById('evFiltroTipo');
        if (fUf) fUf.addEventListener('change', carregarEventos);
        if (fTipo) fTipo.addEventListener('change', carregarEventos);
        popularFiltroUfEventos();
        carregarEventos();
        agendaEventos();
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) carregarEventos();
        });
    } catch (e) {}
})();

/* ================= Busca (locais + coordenada) ================= */
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
let searchTimer = null;

searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 3) { searchResults.classList.remove('open'); return; }
    searchTimer = setTimeout(() => doSearch(q), 450);
});
searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(searchTimer); const q = searchInput.value.trim(); if (q.length >= 3) doSearch(q); }
});
document.addEventListener('click', e => {
    if (!document.getElementById('searchWrap').contains(e.target)) searchResults.classList.remove('open');
});

const coordRe = /^(-?\d{1,2}(?:[.,]\d+)?)\s*[;,]\s*(-?\d{1,3}(?:[.,]\d+)?)$/;

async function doSearch(q) {
    const mc = q.match(coordRe);
    if (mc) {
        const lat = parseFloat(mc[1].replace(',', '.')), lng = parseFloat(mc[2].replace(',', '.'));
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
            searchResults.classList.remove('open');
            map.flyTo([lat, lng], 10, { duration: 1 });
            setTimeout(() => openPointPanel(lat, lng), 1050);
            return;
        }
    }
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=br&viewbox=-66.5,-9.8,-40.2,-27.5&bounded=0&q=${encodeURIComponent(q)}`;
        const res = await dcProxyFetch(url, { headers: { 'Accept-Language': 'pt-BR' } });
        renderResults(await res.json());
    } catch (e) { toast('Falha na busca de locais.'); }
}

function renderResults(places) {
    searchResults.innerHTML = '';
    if (!places.length) {
        searchResults.innerHTML = '<div class="sr-item">Nenhum local encontrado.</div>';
    } else {
        places.forEach(p => {
            const div = document.createElement('div');
            div.className = 'sr-item';
            const parts = p.display_name.split(',');
            div.innerHTML = `<i data-lucide="map-pin"></i><div><div>${parts[0]}</div><small>${parts.slice(1, 4).join(',').trim()}</small></div>`;
            div.addEventListener('click', () => {
                searchResults.classList.remove('open');
                map.flyTo([+p.lat, +p.lon], 9, { duration: 1 });
                setTimeout(() => openPointPanel(+p.lat, +p.lon), 1050);
            });
            searchResults.appendChild(div);
        });
    }
    searchResults.classList.add('open');
    if (window.lucide) lucide.createIcons();
}

/* ================= Previsão pontual (Open-Meteo) ================= */
const pp = {
    panel: document.getElementById('pointPanel'),
    status: document.getElementById('ppStatus'),
    content: document.getElementById('ppContent'),
};
map.on('click', e => { if (!drawing) openPointPanel(e.latlng.lat, e.latlng.lng); });
document.getElementById('ppClose').addEventListener('click', () => pp.panel.classList.remove('open'));

/* Tabela WMO única deste módulo: [descrição, ícone lucide]. */
const WMO_ICONS = {
    0: ['Céu limpo','sun'], 1: ['Predomínio de sol','cloud-sun'], 2: ['Parc. nublado','cloud-sun'],
    3: ['Nublado','cloud'], 45: ['Nevoeiro','cloud-fog'], 48: ['Nevoeiro c/ geada','cloud-fog'],
    51: ['Garoa fraca','cloud-drizzle'], 53: ['Garoa moderada','cloud-drizzle'], 55: ['Garoa intensa','cloud-drizzle'],
    61: ['Chuva fraca','cloud-rain'], 63: ['Chuva moderada','cloud-rain'], 65: ['Chuva forte','cloud-rain'],
    71: ['Neve fraca','snowflake'], 73: ['Neve moderada','snowflake'], 75: ['Neve forte','snowflake'],
    80: ['Pancadas isoladas','cloud-drizzle'], 81: ['Pancadas moderadas','cloud-rain'],
    82: ['Pancadas violentas','cloud-lightning'],
    95: ['Tempestade','cloud-lightning'], 96: ['Tempestade c/ granizo','cloud-lightning'], 99: ['Tempestade severa','cloud-lightning'],
};

async function openPointPanel(lat, lng, fonteExtra = '') {
    pp.panel.classList.add('open');
    pp.status.textContent = 'Carregando previsão detalhada...';
    pp.status.classList.add('show');
    pp.content.style.display = 'none';

    document.getElementById('ppCoords').textContent =
        `${Math.abs(lat).toFixed(4)}\u00B0 ${lat >= 0 ? 'S' : 'N'} \u00B7 ${Math.abs(lng).toFixed(4)}\u00B0 ${lng >= 0 ? 'W' : 'E'}`;

    try {
        const [wx, place] = await Promise.all([
            dcProxyFetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`
                + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,`
                + `wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,cloud_cover,uv_index,visibility,dew_point_2m`
                + `&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,cloud_cover,relative_humidity_2m`
                + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max`
                + `&forecast_days=7&timezone=America/Cuiaba`).then(r => r.json()),
            dcProxyFetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=pt-BR`)
                .then(r => r.json()).catch(() => null)
        ]);

        const c = wx.current;
        const [desc, iconFA] = WMO_ICONS[c.weather_code] || ['Indisponível', 'cloud'];
        const placeName = place?.address?.city || place?.address?.town || place?.address?.village || place?.address?.county || place?.name || 'Local selecionado';

        document.getElementById('ppName').textContent = placeName;
        document.getElementById('ppTemp').innerHTML = `${Math.round(c.temperature_2m)}\u00B0<sup>C</sup>`;
        document.getElementById('ppIcon').innerHTML = `<i data-lucide="${iconFA}" style="color:var(--accent-orange);"></i>`;
        if (window.lucide) lucide.createIcons();
        document.getElementById('ppDesc').textContent = desc;
        document.getElementById('ppFeels').textContent = `${Math.round(c.apparent_temperature)}\u00B0C`;
        document.getElementById('ppHum').textContent = `${c.relative_humidity_2m}%`;
        document.getElementById('ppWind').textContent = `${Math.round(c.wind_speed_10m)} km/h`;
        document.getElementById('ppWindArrow').style.transform = `rotate(${c.wind_direction_10m}deg)`;
        document.getElementById('ppPrecip').textContent = `${c.precipitation ?? 0} mm`;

        document.getElementById('ppPressure').textContent = `${Math.round(c.surface_pressure ?? 0)} hPa`;
        document.getElementById('ppVisibility').textContent = c.visibility ? `${(c.visibility / 1000).toFixed(1)} km` : '\u2014';
        document.getElementById('ppUV').textContent = c.uv_index != null ? Math.round(c.uv_index) : '\u2014';
        document.getElementById('ppCloud').textContent = `${c.cloud_cover ?? 0}%`;
        document.getElementById('ppGusts').textContent = `${Math.round(c.wind_gusts_10m ?? 0)} km/h`;
        document.getElementById('ppDew').textContent = c.dew_point_2m != null ? `${Math.round(c.dew_point_2m)}\u00B0C` : '\u2014';

        document.getElementById('ppSource').innerHTML =
            (fonteExtra ? fonteExtra + '<br>' : '')
            + `Open-Meteo \u00B7 atualizado ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

        renderWindRose(c.wind_direction_10m, c.wind_speed_10m);
        renderHourly48h(wx.hourly);
        renderDaily7(wx.daily);
        renderRiskCards(c, wx.daily);
        renderNearestStation(lat, lng, c);
        renderHourly(wx.hourly);

        pp.status.classList.remove('show');
        pp.content.style.display = '';
    } catch (e) {
        pp.status.textContent = 'N\u00E3o foi poss\u00EDvel obter a previs\u00E3o detalhada deste ponto.';
    }
}

function renderHourly(hourly) {
    const barsEl = document.getElementById('hourlyBars');
    barsEl.innerHTML = '';
    const now = new Date(); now.setMinutes(0, 0, 0);
    let startIdx = hourly.time.findIndex(t => new Date(t) >= now);
    if (startIdx < 0) startIdx = 0;
    for (let i = startIdx; i < Math.min(startIdx + 12, hourly.time.length); i++) {
        const prob = hourly.precipitation_probability[i] ?? 0;
        const col = document.createElement('div');
        col.className = 'hbar-col';
        const h = Math.max(4, prob * 0.78);
        col.innerHTML = `
            <div class="hbar-val">${prob > 0 ? prob + '%' : ''}</div>
            <div class="hbar" style="height:${h}px;"></div>
            <div class="hbar-hour">${fmtTime(Date.parse(hourly.time[i]) / 1000)}</div>`;
        barsEl.appendChild(col);
    }
}

