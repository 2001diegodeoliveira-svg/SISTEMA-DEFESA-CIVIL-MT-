/* SGI PROTEGE - Mapa Integrado (7/14): mapa-chuva. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= Popup central: alertas de chuva + câmeras próximas =================
   Fase 3: nacional via /api/avisos (INMET CAP oficial, com polígonos).
   Varre os avisos vigentes de chuva/tempestade em todo o Brasil, desenha
   os polígonos no mapa e abre o modal central para avisos ainda não
   exibidos nesta sessão (com câmeras SINFRA próximas quando houver). */
const RAIN_RSS_URL = 'https://apiprevmet3.inmet.gov.br/avisos/rss';
let avisosLayer = null;
const RAIN_MESO_CENTROID = {
    'Centro-Sul Mato-grossense': [-15.60, -55.80],
    'Norte Mato-grossense': [-11.20, -55.50],
    'Nordeste Mato-grossense': [-12.60, -52.30],
    'Sudeste Mato-grossense': [-15.60, -53.60],
    'Centro-Oeste de Mato Grosso': [-14.20, -57.70],
    'Sudoeste Mato-grossense': [-15.70, -58.90],
};
// (Legado MT: mantido para compatibilidade; o fluxo nacional usa polígonos CAP.)
const RAIN_AVISO_KEYWORDS = /chuvas?\s+intensas|acumulado\s+de\s+chuva|tempestade|granizo|vendaval/i;
const RAIN_SEV_INFO = {
    'Grande Perigo': { lbl: 'Grande Perigo', cor: '#ef4444', peso: 0, icon: 'cloud-lightning' },
    'Perigo': { lbl: 'Perigo', cor: '#f97316', peso: 1, icon: 'cloud-rain' },
    'Perigo Potencial': { lbl: 'Atenção', cor: '#eab308', peso: 2, icon: 'cloud-drizzle' },
};
let rainAlertQueue = [];
let rainAlertShown = {};
let rainAlertShowing = false;
let rainCurAlert = null;

function rainCampo(html, rotulo) {
    const re = new RegExp('<th[^>]*>' + rotulo + '</th>[\\s\\S]*?<td>([\\s\\S]*?)</td>', 'i');
    const m = html.match(re);
    return m ? m[1].replace(/<[^>]+>/g, '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim() : '';
}
function rainFmtDh(str) {
    const d = new Date(String(str).replace(' ', 'T'));
    if (isNaN(d)) return '—';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '');
}
function haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371;
    const dLat = (bLat - aLat) * Math.PI / 180, dLng = (bLng - aLng) * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}
function rainCamsProximas(lat, lng, n) {
    const cands = (camSinfraData || []).filter(c => c.online === true)
        .map(c => ({ ...c, km: haversineKm(lat, lng, Number(c.lat), Number(c.lng)) }))
        .sort((a, b) => a.km - b.km);
    return cands.slice(0, n || 3);
}
function centroidePoligono(anel) {
    if (!anel || !anel.length) return null;
    let la = 0, lo = 0;
    anel.forEach(p => { la += p[0]; lo += p[1]; });
    return { lat: la / anel.length, lng: lo / anel.length };
}
function desenharPoligonoAviso(aviso) {
    if (!aviso.poligono || !aviso.poligono.length) return;
    try {
        if (!avisosLayer) {
            avisosLayer = L.layerGroup();
            avisosLayer.addTo(map);
        }
        const cor = (aviso.sev && aviso.sev.cor) || '#eab308';
        L.polygon(aviso.poligono, {
            color: cor, weight: 2, opacity: .9,
            fillColor: cor, fillOpacity: .15,
        }).bindTooltip(`${aviso.evento} · ${aviso.severidade}`, { sticky: true }).addTo(avisosLayer);
    } catch (e) {}
}
async function checkRainAlerts() {
    try {
        const r = await fetch(apiUrl('/api/avisos'));
        if (!r.ok) return;
        const j = await r.json();
        const vigentes = (j.avisos || []).filter(a => a.vigente && RAIN_AVISO_KEYWORDS.test(a.evento || ''));
        if (!vigentes.length) return;
        // Detalhe CAP (polígono) só para avisos novos, com teto por ciclo.
        const novos = vigentes.filter(a => !(a.id in rainAlertShown)).slice(0, 8);
        const alerts = [];
        for (const item of vigentes) {
            const jaVisto = (item.id in rainAlertShown);
            let poligono = null, centro = null;
            if (!jaVisto && novos.includes(item)) {
                try {
                    const rd = await fetch(apiUrl('/api/avisos?id=' + encodeURIComponent(item.id)));
                    if (rd.ok) {
                        const det = await rd.json();
                        poligono = det.poligono || null;
                        centro = centroidePoligono(poligono);
                    }
                } catch (e) {}
            }
            alerts.push({
                id: item.id, evento: item.evento, severidade: item.severidade,
                inicio: item.inicio, fim: item.fim, descricao: item.descricao,
                areas: item.areas, poligono, centro,
                link: 'https://apiprevmet3.inmet.gov.br/avisos/rss/' + item.id,
                sev: RAIN_SEV_INFO[item.severidade] || { peso: 2, cor: '#eab308', lbl: 'Atenção', icon: 'cloud-drizzle' },
            });
        }
        alerts.sort((a, b) => a.sev.peso - b.sev.peso);
        const mostrar = alerts.filter(a => !(a.id in rainAlertShown));
        if (!mostrar.length) return;
        mostrar.forEach(a => {
            rainAlertShown[a.id] = Date.now();
            desenharPoligonoAviso(a);
            rainAlertQueue.push(a);
        });
        rainAlertShowNext();
    } catch (e) {}
}
function rainAlertShowNext() {
    if (rainAlertShowing || !rainAlertQueue.length) return;
    const alert = rainAlertQueue.shift();
    rainAlertShowing = true;
    rainCurAlert = alert;
    const modal = document.getElementById('rainAlertModal');
    const card = document.getElementById('rainCard');
    card.style.setProperty('--rain-c', alert.sev.cor);
    document.getElementById('rainIcon').innerHTML = `<i data-lucide="${alert.sev.icon}"></i>`;
    document.getElementById('rainTitle').textContent = 'Aviso de ' + alert.evento;
    document.getElementById('rainSev').textContent = alert.sev.lbl;
    document.getElementById('rainKicker').textContent = 'Alerta meteorológico · INMET · ' + alturaSeveridade(alert.sev);
    document.getElementById('rainDesc').textContent = alert.descricao || 'Aviso meteorológico do INMET. SGI PROTEGE recomenda atenção e acompanhamento.';
    document.getElementById('rainMeta').innerHTML = `
        <span><b>Início:</b> ${rainFmtDh(alert.inicio)}</span>
        <span><b>Válido até:</b> ${rainFmtDh(alert.fim)}</span>
        <span><b>ID:</b> ${alert.id}</span>`;
    const areasTxt = alert.areas ? String(alert.areas).replace(/^Aviso para as Áreas:\s*/i, '') : '';
    document.getElementById('rainRegioes').innerHTML = areasTxt
        ? `<b>Áreas afetadas:</b> ${areasTxt}`
        : '<b>Áreas afetadas:</b> ver polígono no mapa';
    if (alert.centro) rainPintarCams(alert.centro.lat, alert.centro.lng, 'do centro do aviso');
    else {
        const grid = document.getElementById('rainCamsGrid');
        if (grid) grid.innerHTML = '<div class="rain-empty-cams">Sem polígono — sem referência para câmeras próximas.</div>';
    }
    if (window.lucide) lucide.createIcons();
    modal.classList.add('open');
}

/* Renderiza as câmeras SINFRA ao vivo mais próximas de um ponto.
   Compartilhado entre o aviso INMET e o alerta de pluviômetro. */
function rainPintarCams(lat, lng, rotuloDist) {
    const grid = document.getElementById('rainCamsGrid');
    if (!grid) return;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
        grid.innerHTML = '<div class="rain-empty-cams">Ponto sem coordenadas — sem câmeras próximas.</div>';
        return;
    }
    const cams = rainCamsProximas(Number(lat), Number(lng), 3);
    if (!cams.length) {
        grid.innerHTML = '<div class="rain-empty-cams">Sem câmeras SINFRA ao vivo nas proximidades desta área no momento.</div>';
        return;
    }
    grid.innerHTML = cams.map(cam => {
        // Fase 9 (mixed content): http:// em página https:// não incorpora.
        const bloqueado = /^http:\/\//i.test(cam.link || '') && location.protocol === 'https:';
        const video = bloqueado
            ? `<div style="padding:10px;font-size:10px;color:#94a3b8;">Stream HTTP — <a href="${cam.link}" target="_blank" rel="noopener" style="color:#38bdf8;">abrir em nova aba</a></div>`
            : `<iframe src="${cam.link}" title="${cam.localizacao || cam.slug}" allow="autoplay; encrypted-media; fullscreen" loading="lazy"></iframe>`;
        return `
        <div class="rain-cam">
            <div class="rain-cam-video">
                ${video}
                <span class="rain-cam-tag">AO VIVO</span>
            </div>
            <div class="rain-cam-cap">
                <b>${cam.localizacao || cam.slug}</b>
                <span>${[cam.obra, cam.municipio].filter(Boolean).join(' · ') || 'SINFRA-MT'}</span>
                <div class="rain-cam-dist">≈ ${Math.round(cam.km).toLocaleString('pt-BR')} km ${rotuloDist || 'do ponto'}</div>
            </div>
            <div class="rain-cam-actions">
                <a href="${cam.link}" target="_blank" rel="noopener">Abrir monitor</a>
                <button type="button" onclick="rainFlyToCam(${cam.lat}, ${cam.lng})">Ver no mapa</button>
            </div>
        </div>`;
    }).join('');
}
function alturaSeveridade(sev) { return { 'Grande Perigo': 'Perigo extremo', 'Perigo': 'Atenção alta', 'Perigo Potencial': 'Nível de atenção' }[sev.lbl] || 'Atenção'; }
function rainCloseModal() {
    /* O modal serve a dois alertas: aviso INMET (RSS) e limiar de
       pluviômetro. O popup de pluviômetro tem fila própria. */
    if (pluvAlertaAtual) { pluvAlertaFechar(); return; }
    document.getElementById('rainAlertModal').classList.remove('open');
    rainAlertShowing = false;
    rainCurAlert = null;
    setTimeout(rainAlertShowNext, 250);
}
function rainCenterMap() {
    if (pluvAlertaAtual) { pluvAlertaCentralizar(); return; }
    if (rainCurAlert && rainCurAlert.centro) {
        map.setView([rainCurAlert.centro.lat, rainCurAlert.centro.lng], 7);
        if (camSinfraLayer && checkState.camsSinfra) { try { camSinfraLayer.addTo(map); } catch (e) {} }
    }
    rainCloseModal();
}
function rainFlyToCam(lat, lng) {
    map.setView([lat, lng], 14);
    if (camSinfraLayer && checkState.camsSinfra) { try { camSinfraLayer.addTo(map); } catch (e) {} }
    rainCloseModal();
}
function rainBindModal() {
    document.getElementById('rainClose').addEventListener('click', rainCloseModal);
    document.getElementById('rainCenter').addEventListener('click', rainCenterMap);
    document.getElementById('rainBackdrop').addEventListener('click', rainCloseModal);
    const modal = document.getElementById('rainAlertModal');
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') rainCloseModal(); });
}

/* ================= Qualidade do ar / fumaça (CAMS via Open-Meteo) ===============
   Fase 4 (verificado ao vivo em 2026-10-13, sem chave): PM2.5/PM10/AQI
   nos pontos das estacoes INMET da UF selecionada (lotes de 40, como o
   pluviometro). É saída de modelo (CAMS), NÃO medição em solo. */
function aqiCor(aqi) {
    if (aqi == null || !isFinite(aqi)) return '#64748b';
    if (aqi <= 50) return '#22c55e';
    if (aqi <= 100) return '#eab308';
    if (aqi <= 150) return '#f97316';
    if (aqi <= 200) return '#ef4444';
    if (aqi <= 300) return '#a855f7';
    return '#7f1d1d';
}
async function loadQualidadeAr() {
    if (qualidadeArLoading) return;
    qualidadeArLoading = true;
    const meta = document.getElementById('metaQualidadeAr');
    if (meta) meta.innerHTML = 'CAMS via Open-Meteo · <b>carregando...</b>';
    try {
        const siglaUF = ufSiglaCorrente() || 'BR';
        const res = await dcProxyFetch('https://apitempo.inmet.gov.br/estacoes/T');
        const data = await res.json();
        const pontos = (siglaUF
            ? data.filter(s => (s.SG_ESTADO || '').toUpperCase() === siglaUF)
            : data.slice())
            .map(s => ({ lat: parseFloat(s.VL_LATITUDE), lon: parseFloat(s.VL_LONGITUDE), nome: s.DC_NOME, codigo: s.CD_ESTACAO }))
            .filter(pt => pt.lat && pt.lon);
        if (!pontos.length) throw new Error('Sem estações de referência.');
        const resultados = [];
        for (let i = 0; i < pontos.length; i += 40) {
            const lote = pontos.slice(i, i + 40);
            const url = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude='
                + lote.map(pt => pt.lat.toFixed(4)).join(',')
                + '&longitude=' + lote.map(pt => pt.lon.toFixed(4)).join(',')
                + '&hourly=pm2_5,pm10,us_aqi&forecast_days=2&timezone=auto';
            try {
                const r = await dcProxyFetch(url);
                const j = await r.json();
                (Array.isArray(j) ? j : [j]).forEach((o, k) => { resultados[i + k] = o; });
            } catch (e) { /* lote falhou; demais seguem */ }
        }
        const agora = Date.now();
        if (qualidadeArLayer) { try { map.removeLayer(qualidadeArLayer); } catch (e) {} }
        qualidadeArLayer = L.layerGroup();
        let maxAqi = 0, n = 0;
        pontos.forEach((pt, idx) => {
            const h = resultados[idx] && resultados[idx].hourly;
            if (!h || !h.time || !h.time.length) return;
            let k = h.time.length - 1;
            for (let t = 0; t < h.time.length; t++) {
                if (Date.parse(h.time[t]) <= agora) k = t; else break;
            }
            const pm25 = h.pm2_5 ? h.pm2_5[k] : null;
            const pm10 = h.pm10 ? h.pm10[k] : null;
            const aqi = h.us_aqi ? h.us_aqi[k] : null;
            if (aqi == null) return;
            n++;
            if (aqi > maxAqi) maxAqi = aqi;
            const cor = aqiCor(aqi);
            L.circleMarker([pt.lat, pt.lon], {
                radius: 7 + Math.min(10, (aqi || 0) / 25),
                color: '#fff', weight: 1.5, fillColor: cor, fillOpacity: .8,
                title: pt.nome + ' · AQI ' + Math.round(aqi),
            }).bindPopup(
                '<div style="min-width:210px;">'
                + '<div style="font-weight:700;font-size:13px;margin-bottom:2px;">' + (pt.nome || 'Estação') + '</div>'
                + '<div style="color:#94a3b8;font-size:9.5px;margin-bottom:8px;">' + (pt.codigo || '') + ' · ' + siglaUF + '</div>'
                + '<div style="font-size:11px;line-height:1.75;">'
                + '<div><b>AQI (EUA):</b> <b style="color:' + cor + ';">' + Math.round(aqi) + '</b></div>'
                + '<div><b>PM2.5:</b> ' + (pm25 != null ? pm25 + ' µg/m³' : '-') + '</div>'
                + '<div><b>PM10:</b> ' + (pm10 != null ? pm10 + ' µg/m³' : '-') + '</div>'
                + '</div>'
                + '<div style="margin-top:6px;font-size:9px;color:#94a3b8;line-height:1.5;">'
                + 'Modelo CAMS (Open-Meteo), não medição em solo · hora ' + (h.time[k] || '-') + '</div>'
                + '</div>').addTo(qualidadeArLayer);
        });
        if (!n) throw new Error('Sem dados de qualidade do ar.');
        if (checkState.qualidadeAr) qualidadeArLayer.addTo(map);
        qualidadeArLoaded = true;
        qualidadeArLoading = false;
        if (meta) meta.innerHTML = 'CAMS via Open-Meteo · <b>' + n + '</b> pontos em ' + siglaUF + ' · AQI max <b>' + Math.round(maxAqi) + '</b>';
        let leg = document.getElementById('legQualidadeAr');
        if (!leg) {
            document.getElementById('legUc').insertAdjacentHTML('afterend',
                '<div id="legQualidadeAr" class="leg-row" style="display:none;"><span style="width:10px;height:10px;border-radius:50%;background:#a855f7;display:inline-block;margin-right:5px;"></span> Qualidade do ar (AQI)</div>');
        }
        if (window.lucide) lucide.createIcons();
        refreshLegend();
    } catch (e) {
        qualidadeArLoading = false;
        if (meta) meta.textContent = 'Qualidade do ar indisponível — sem dados no momento';
    }
}


/* ================= Previsão 6 dias — Open-Meteo (nacional) =================
   Substitui o CPTEC via BrasilAPI (fora do ar — HTTP 500): previsão por
   coordenada, válida para qualquer município do Brasil. Usa o município
   selecionado ou, sem seleção, o centro do mapa. */
const WMO_INFO = {
    0: ['sun', 'Limpo'], 1: ['cloud-sun', 'Quase limpo'], 2: ['cloud-sun', 'Parcial nublado'],
    3: ['cloud', 'Nublado'], 45: ['cloud-fog', 'Nevoeiro'], 48: ['cloud-fog', 'Nevoeiro'],
    51: ['cloud-drizzle', 'Garoa leve'], 53: ['cloud-drizzle', 'Garoa'], 55: ['cloud-drizzle', 'Garoa forte'],
    56: ['cloud-drizzle', 'Garoa congelante'], 57: ['cloud-drizzle', 'Garoa congelante'],
    61: ['cloud-rain', 'Chuva fraca'], 63: ['cloud-rain', 'Chuva'], 65: ['cloud-rain', 'Chuva forte'],
    66: ['cloud-rain', 'Chuva congelante'], 67: ['cloud-rain', 'Chuva congelante'],
    71: ['snowflake', 'Neve fraca'], 73: ['snowflake', 'Neve'], 75: ['snowflake', 'Neve forte'],
    77: ['snowflake', 'Granizo'], 80: ['cloud-rain', 'Pancadas fracas'], 81: ['cloud-rain', 'Pancadas'],
    82: ['cloud-rain', 'Pancadas fortes'], 95: ['cloud-lightning', 'Tempestade'],
    96: ['cloud-lightning', 'Tempestade'], 99: ['cloud-lightning', 'Tempestade com granizo'],
};
const CPTEC_CIDADES = [
    { nome: 'Cuiabá', id: 226 },
    { nome: 'Rondonópolis', id: 5251 },
    { nome: 'Sinop', id: 5247 },
    { nome: 'Sorriso', id: 5251 },
    { nome: 'Cáceres', id: 218 }
];
// (Legado: códigos CPTEC/BrasilAPI, fora do ar — mantidos para referência.)
const CPTEC_ICONE = {
    'ci': 'sun', 'cv': 'cloud-sun', 'ec': 'cloud-lightning', 'eq': 'zap', 'er': 'cloud-rain',
    'os': 'cloud', 'pc': 'cloud-drizzle', 'pp': 'cloud-rain', 'ps': 'cloud-sun', 'pn': 'cloud',
    'rb': 'cloud-rain', 'rc': 'cloud-rain', 'rr': 'cloud-rain', 'rs': 'cloud-lightning', 'sc': 'snowflake',
    'ch': 'cloud-rain', 'ct': 'cloud', 'np': 'cloud', 'lc': 'cloud', 'vc': 'cloud-sun',
    'pm': 'cloud-sun', 'nc': 'cloud'
};

let cpTecGlobal = [];
function previsaoAlvo() {
    try {
        const sel = document.getElementById('territoryMunicipio');
        const cod = sel && sel.value;
        const c = cod && centroidByCod[cod];
        if (c && isFinite(c.lat) && isFinite(c.lng)) {
            const nome = (sel.options[sel.selectedIndex] || {}).text || 'Município';
            return { lat: c.lat, lng: c.lng, nome };
        }
    } catch (e) {}
    try {
        const centro = map.getCenter();
        return { lat: centro.lat, lng: centro.lng, nome: 'Centro do mapa' };
    } catch (e) {
        return { lat: -15.588, lng: -56.097, nome: 'Cuiabá' };
    }
}
async function loadCptec() {
    const container = document.getElementById('cptecCards');
    if (!container) return;
    container.innerHTML = '<div style="color:#94a3b8;font-size:10.5px;padding:6px;">Carregando...</div>';
    try {
        const alvo = previsaoAlvo();
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${alvo.lat.toFixed(4)}&longitude=${alvo.lng.toFixed(4)}`
            + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=6&timezone=auto`;
        const res = await dcProxyFetch(url);
        const data = await res.json();
        const dias = (data.daily && data.daily.time) || [];
        if (!dias.length) { container.innerHTML = '<div style="color:#94a3b8;font-size:10.5px;">Sem dados</div>'; return; }
        const diaSem = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
        cpTecGlobal = dias.map((iso, i) => {
            const dt = new Date(iso + 'T12:00:00');
            const info = WMO_INFO[(data.daily.weather_code || [])[i]] || ['cloud-sun', '—'];
            return {
                dia: diaSem[dt.getDay()], data: `${dt.getDate()}/${dt.getMonth() + 1}`,
                icone: info[0], desc: info[1],
                tmax: Math.round((data.daily.temperature_2m_max || [])[i]),
                tmin: Math.round((data.daily.temperature_2m_min || [])[i]),
                chuva: (data.daily.precipitation_sum || [])[i] ?? 0,
            };
        });
        const fonte = document.getElementById('cptecFonte');
        if (fonte) fonte.innerHTML = `<i data-lucide="link" style="font-size:9px;"></i> Fonte: Open-Meteo · ${alvo.nome}`;
        container.innerHTML = cpTecGlobal.map(c =>
            `<div class="cptec-card">
                <span class="dia">${c.dia}<br><span style="font-weight:400;font-size:9px;color:var(--text-muted);">${c.data}</span></span>
                <span class="icone"><i data-lucide="${c.icone}"></i></span>
                <span class="desc">${c.desc}${c.chuva > 0 ? ' · ' + c.chuva + ' mm' : ''}</span>
                <span class="temps"><span class="tmax">${c.tmax}°</span><span class="tmin">${c.tmin}°</span></span>
            </div>`
        ).join('');
        if (window.lucide) lucide.createIcons();
        loadChuvaTimeline();
    } catch (e) {
        container.innerHTML = '<div style="color:#94a3b8;font-size:10.5px;">Erro ao carregar previsão</div>';
    }
}
loadCptec();
setInterval(loadCptec, 60 * 60 * 1000);

/* ================= Chuva hora a hora — 24h observadas + 6h previstas ===============
   Fase 6: animação da precipitação horária (Open-Meteo, já verificado) para
   o mesmo alvo da previsão (município selecionado ou centro do mapa).
   Barras sólidas = observado; hachuradas claras = previsão. */
let chuvaHoras = [], chuvaIdx = 0, chuvaTimer = null, chuvaTocando = false;
async function loadChuvaTimeline() {
    const box = document.getElementById('chuvaBars');
    const lbl = document.getElementById('chuvaHora');
    if (!box) return;
    try {
        const alvo = previsaoAlvo();
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${alvo.lat.toFixed(4)}&longitude=${alvo.lng.toFixed(4)}`
            + `&hourly=precipitation&past_days=1&forecast_days=2&timezone=auto`;
        const res = await dcProxyFetch(url);
        const data = await res.json();
        const times = (data.hourly && data.daily !== undefined && data.hourly.time) || [];
        const vals = (data.hourly && data.hourly.precipitation) || [];
        if (!times.length) throw new Error('sem série horária');
        const agora = Date.now();
        let ini = 0;
        for (let i = 0; i < times.length; i++) {
            if (Date.parse(times[i]) <= agora - 24 * 3600000) ini = i;
            else break;
        }
        chuvaHoras = [];
        for (let i = ini; i < Math.min(times.length, ini + 30); i++) {
            chuvaHoras.push({
                t: times[i],
                mm: Number(vals[i]) || 0,
                futuro: Date.parse(times[i]) > agora,
            });
        }
        chuvaIdx = Math.min(chuvaHoras.findIndex(h => h.futuro), chuvaHoras.length - 1);
        if (chuvaIdx < 0) chuvaIdx = chuvaHoras.length - 1;
        pararChuva();
        desenharChuva();
    } catch (e) {
        if (lbl) lbl.textContent = 'Chuva hora a hora indisponível';
    }
}
function desenharChuva() {
    const box = document.getElementById('chuvaBars');
    const lbl = document.getElementById('chuvaHora');
    if (!box || !chuvaHoras.length) return;
    const max = Math.max(1, ...chuvaHoras.map(h => h.mm));
    box.innerHTML = chuvaHoras.map((h, i) => {
        const alt = Math.max(2, Math.round((h.mm / max) * 52));
        const base = h.futuro
            ? 'background:repeating-linear-gradient(45deg,rgba(125,211,252,.35) 0 2px,transparent 2px 5px);border:1px dashed rgba(125,211,252,.5);'
            : 'background:#38bdf8;';
        const borda = i === chuvaIdx ? 'outline:2px solid #fff;outline-offset:1px;' : '';
        return `<div title="${h.t} · ${h.mm} mm${h.futuro ? ' (prev.)' : ''}" style="flex:1;min-width:3px;height:${alt}px;${base}${borda}border-radius:2px;"></div>`;
    }).join('');
    const h = chuvaHoras[chuvaIdx];
    if (lbl && h) {
        const dt = new Date(h.t);
        lbl.textContent = `${dt.toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${h.mm} mm${h.futuro ? ' (previsão)' : ' (observado)'}`;
    }
    const btn = document.getElementById('chuvaPlayBtn');
    if (btn) btn.innerHTML = `<i data-lucide="${chuvaTocando ? 'pause' : 'play'}"></i>`;
    if (window.lucide) lucide.createIcons();
}
function tocarChuva() {
    pararChuva();
    chuvaTocando = true;
    chuvaTimer = setInterval(() => {
        if (!chuvaHoras.length) return;
        chuvaIdx = (chuvaIdx + 1) % chuvaHoras.length;
        desenharChuva();
    }, 700);
    desenharChuva();
}
function pararChuva() {
    chuvaTocando = false;
    if (chuvaTimer) clearInterval(chuvaTimer);
    chuvaTimer = null;
}

/* ================= Estações INMET (EAM) — API pública ================= */
async function loadInmetStations() {
    inmetLoading = true;
    const meta = document.getElementById('metaInmet');
    meta.innerHTML = 'INMET · <b>carregando...</b>';
    try {
        const res = await dcProxyFetch('https://apitempo.inmet.gov.br/estacoes/T');
        const data = await res.json();
        // Fase 3+: nacional — filtra pela UF ou mostra o Brasil todo.
        const siglaUF = ufSiglaCorrente() || 'BR';
        const ufStations = ufSiglaCorrente()
            ? data.filter(s => (s.SG_ESTADO || '').toUpperCase() === siglaUF && s.VL_LATITUDE && s.VL_LONGITUDE)
            : data.filter(s => s.VL_LATITUDE && s.VL_LONGITUDE);
        inmetLayer = L.layerGroup();
        let nOper = 0, nPane = 0;
        ufStations.forEach(s => {
            const lat = parseFloat(s.VL_LATITUDE);
            const lon = parseFloat(s.VL_LONGITUDE);
            if (!lat || !lon) return;
            const codigo = s.CD_ESTACAO;
            const operante = String(s.CD_SITUACAO || '').toLowerCase() === 'operante';
            if (operante) nOper++; else nPane++;
            const cor = operante ? '#22d3ee' : '#64748b';
            const tipo = s.TP_ESTACAO || '—';
            const situacao = s.CD_SITUACAO || '—';
            const ini = s.DT_INICIO_OPERACAO ? new Date(s.DT_INICIO_OPERACAO).toLocaleDateString('pt-BR') : '—';
            const fim = s.DT_FIM_OPERACAO ? new Date(s.DT_FIM_OPERACAO).toLocaleDateString('pt-BR') : null;
            const isCapital = String(s.FL_CAPITAL || 'N').toUpperCase() === 'S';
            const mk = L.marker([lat, lon], {
                icon: iconDivMarker('radio-tower', cor, 24),
                title: s.DC_NOME + ' · ' + codigo
            });
            mk.bindTooltip(`${s.DC_NOME} <span style="color:#22d3ee;">(${codigo})</span>`, { direction: 'top', offset: [0, -14], className: 'inmet-tooltip' });
            const capBadge = isCapital ? `<div class="bar-grid"><div><span>Capital</span><b>Sim</b></div></div>` : '';
            mk.bindPopup(`
                <div style="min-width:230px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                        <span style="width:32px;height:32px;border-radius:50%;background:linear-gradient(160deg,rgba(34,211,238,.25),rgba(34,211,238,.08));border:1px solid rgba(34,211,238,.5);display:flex;align-items:center;justify-content:center;"><i data-lucide="radio-tower" style="color:#22d3ee;width:16px;height:16px;"></i></span>
                        <div>
                            <div style="font-weight:700;font-size:13px;color:#fff;line-height:1.2;">${s.DC_NOME}</div>
                            <div style="color:#94a3b8;font-size:9.5px;">Estação Meteorológica Automática · ${siglaUF || 'BR'}</div>
                        </div>
                    </div>
                    <div style="display:flex;gap:5px;margin-bottom:7px;">
                        <span class="bar-badge" style="background:rgba(74,222,128,.14);border:1px solid rgba(74,222,128,.35);color:#4ade80;"><i data-lucide="activity"></i> ${situacao}</span>
                        <span class="bar-badge" style="background:rgba(56,189,248,.12);border:1px solid rgba(56,189,248,.3);color:#38bdf8;"><i data-lucide="cpu"></i> ${tipo}</span>
                        ${isCapital ? '<span class="bar-badge" style="background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.3);color:#fbbf24;"><i data-lucide="landmark"></i> Capital</span>' : ''}
                    </div>
                    <div class="bar-grid" style="grid-template-columns:repeat(2,1fr);">
                        <div><span>Código</span><b>${codigo}</b></div>
                        <div><span>Altitude</span><b>${s.VL_ALTITUDE ? s.VL_ALTITUDE + ' m' : '—'}</b></div>
                        <div><span>Latitude</span><b>${lat.toFixed(4)}</b></div>
                        <div><span>Longitude</span><b>${lon.toFixed(4)}</b></div>
                        <div><span>WIGOS / OSCAR</span><b>${s.CD_OSCAR || '—'}</b></div>
                        <div><span>WSI</span><b>${s.CD_WSI || '—'}</b></div>
                        <div><span>Distrito</span><b>${String(s.CD_DISTRITO || '—').trim()}</b></div>
                        <div><span>Entidade</span><b>${s.SG_ENTIDADE || '—'}</b></div>
                        <div><span>Operando desde</span><b>${ini}</b></div>
                        <div><span>Término</span><b>${fim || '—'}</b></div>
                    </div>
                    ${capBadge}
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;">
                        <a href="https://tempo.inmet.gov.br/TabelaEstacoes/${codigo}" target="_blank" rel="noopener" class="bar-act" style="color:#38bdf8;border-color:rgba(56,189,248,.4);"><i data-lucide="table"></i> Dados no INMET</a>
                        <a href="https://tempo.inmet.gov.br/Graficos/${codigo}" target="_blank" rel="noopener" class="bar-act" style="color:#38bdf8;border-color:rgba(56,189,248,.4);"><i data-lucide="chart-line"></i> Gráficos</a>
                    </div>
                    <div style="margin-top:6px;">${reportMarkerBtn(lat, lon)}</div>
                    <div style="margin-top:6px;font-size:9px;color:#94a3b8;line-height:1.5;">
                        Fonte: <b>INMET</b> — https://apitempo.inmet.gov.br · dados cadastrais; meteorológicos exigem token oficial.
                    </div>
                </div>`).addTo(inmetLayer);
        });
        inmetLayer.addTo(map);
        inmetLoaded = true;
        inmetLoading = false;
        meta.innerHTML = `INMET · <b>${ufStations.length}</b> EAM ${siglaUF === 'BR' ? 'no Brasil' : 'em ' + siglaUF} · <b style="color:#4ade80;">${nOper} operantes</b> · <b style="color:#94a3b8;">${nPane} em pane</b>`;
    } catch (e) {
        inmetLoading = false;
        meta.textContent = 'INMET · indisponível';
    }
}

/* ================= Chuva INMET 24h/7d — BDMEP (zip oficial anual) =================
   Consome o endpoint próprio /api/inmet-chuva (?uf=), que baixa o zip de dados
   históricos do INMET, extrai as estações automáticas da UF e calcula os
   acumulados das últimas 24h e 7 dias por estação. */
async function loadChuvaInmet() {
    if (chuvaInmetLoading) return;
    chuvaInmetLoading = true;
    const meta = document.getElementById('metaChuvaInmet');
    meta.innerHTML = 'INMET BDMEP · <b>carregando acumulados...</b>';
    try {
        const baseUrl = apiBase();
        const ano = new Date().getUTCFullYear();
        const siglaUF = ufSiglaCorrente() || 'BR';
        const res = await fetch(baseUrl + '/api/inmet-chuva?ano=' + ano + '&uf=' + siglaUF);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!Array.isArray(data.estacoes)) throw new Error('Resposta inválida');
        if (chuvaInmetLayer) { try { map.removeLayer(chuvaInmetLayer); } catch {} }
        chuvaInmetLayer = L.layerGroup();
        data.estacoes.forEach(s => {
            if (!s.lat || !s.lon) return;
            const cor = RAIN_COR(s.chuva24h || 0);
            const r24 = 8 + Math.min(18, Math.sqrt(s.chuva24h || 0) * 4);
            const mk = L.circleMarker([s.lat, s.lon], {
                radius: r24,
                color: '#fff',
                weight: 1.5,
                fillColor: cor,
                fillOpacity: .75,
                title: s.nome + ' · ' + s.codigo + ' · 24h: ' + (s.chuva24h ?? 0) + ' mm'
            });
            mk.bindTooltip(`${s.nome} <span style="color:#22d3ee;">(${s.codigo})</span> · 24h <b>${pluvChip(s.chuva24h)}</b> mm · 7d <b>${pluvChip(s.chuva7d)}</b> mm`, { direction: 'top', offset: [0, -8], className: 'inmet-tooltip' });
            const serie = (s.serie7d || []).map(d => `<div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:#94a3b8;">${d.dia}</span><b>${d.mm}</b></div>`).join('');
            mk.bindPopup(`
                <div style="min-width:210px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                        <span style="width:32px;height:32px;border-radius:50%;background:linear-gradient(160deg,rgba(14,165,233,.25),rgba(14,165,233,.08));border:1px solid rgba(14,165,233,.5);display:flex;align-items:center;justify-content:center;"><i data-lucide="cloud-rain" style="color:#0ea5e9;width:16px;height:16px;"></i></span>
                        <div>
                            <div style="font-weight:700;font-size:13px;color:#fff;line-height:1.2;">${s.nome}</div>
                            <div style="color:#94a3b8;font-size:9.5px;">${s.codigo} · INMET BDMEP · ${siglaUF}</div>
                        </div>
                    </div>
                    <div class="bar-grid" style="grid-template-columns:repeat(2,1fr);margin-top:4px;">
                        <div><span>Chuva 24h</span><b style="color:${RAIN_COR(s.chuva24h || 0)};">${pluvChip(s.chuva24h)} mm</b></div>
                        <div><span>Chuva 7 dias</span><b style="color:${RAIN_COR(s.chuva7d || 0)};">${pluvChip(s.chuva7d)} mm</b></div>
                    </div>
                    ${serie ? `<div style="margin-top:8px;font-size:10px;line-height:1.6;border-top:1px solid rgba(148,163,184,.15);padding-top:6px;">
                        <div style="color:#94a3b8;font-size:9px;margin-bottom:2px;">Acumulado diário (7d)</div>${serie}</div>` : ''}
                    <div style="margin-top:6px;font-size:9px;color:#94a3b8;line-height:1.5;">
                        Cobertura zip INMET: <b>${data.cobertura ? data.cobertura.slice(0, 10) : '—'}</b> · dados observados.
                    </div>
                </div>`);
            mk.addTo(chuvaInmetLayer);
        });
        chuvaInmetLayer.addTo(map);
        chuvaInmetLoaded = true;
        const topS = data.estacoes[0];
        meta.innerHTML = `INMET BDMEP · <b>${data.totalEstacoes}</b> estações · máx 24h <b style="color:#dc2626;">${pluvChip(topS && topS.chuva24h)} mm</b> · cobertura ${data.cobertura ? data.cobertura.slice(0, 10) : '—'}`;
        if (window.lucide) lucide.createIcons();
    } catch (e) {
        meta.textContent = 'INMET BDMEP · indisponível';
    } finally {
        chuvaInmetLoading = false;
    }
}

/* ================= Estações INMET — Pluviômetro (estado todo) ================= */
let pluvLayer = null, pluvStations = [], pluvLoading = false;
const RAIN_COR = p => p <= 0 ? '#22d3ee' : p < 2 ? '#34d399' : p < 10 ? '#fbbf24' : p < 25 ? '#f97316' : '#dc2626';

function rainIconDiv(p, size) {
    size = size || 26;
    const inner = Math.round(size * 0.5);
    const cor = RAIN_COR(p || 0);
    const lbl = (p === undefined || p === null) ? '–' : (p.toFixed(1) + '');
    return L.divIcon({
        className: 'pluv-marker',
        html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${cor};border:2px solid #fff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:9px;text-shadow:0 1px 2px rgba(0,0,0,.6);box-shadow:0 2px 8px ${cor}88;">${lbl}</div>`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2]
    });
}

function pluvChip(v, suffix) {
    if (v === undefined || v === null || v === '') return '<span style="color:#64748b;">—</span>';
    return v.toFixed(v < 10 ? 1 : 0) + (suffix || '');
}

/* ================= Alerta de pluviômetro — 30% do limite =================
   O SERVIDOR é a fonte da verdade do limiar: /api/pluv-alerta devolve
   { limiteMm, percentual, limiarMm }. O front nunca calcula sozinho o
   que dispara — ele lê limiarMm e só decide a quem mostrar o popup.

   Dispara pelo acumulado de 24h (c24), não pela intensidade instantânea:
   é o mesmo critério do aviso de chuva intensa do INMET e evita alarme
   falso em pancada passageira.

   Uma sessão = um aviso por estação. Ao fechar o popup a estação sai
   do "já avisado"; se normalizar e cruzar o limiar de novo, avisa
   outra vez.                                                       */
const PLUV_CFG = {
    limiteMm: 100,
    percentual: 30,
    limiarMm: 30,
    metrica: 'c24',
    carregado: false,
    ativo: true,
    origem: 'padrao',
};
const pluvJaAvisado = Object.create(null);   /* codigo -> {pct, c24, ts} */
let pluvAlertaFila = [];
let pluvAlertaAberto = false;
let pluvAlertaAtual = null;
/* Códigos que o SERVIDOR marcou como acima do limiar. A tabela usa
   este set, não um cálculo próprio, para não divergir do popup. */
let pluvAcimaSet = new Set();

/* ---------- Config: sempre perguntando ao servidor ---------- */
function pluvCfgAplicar(j, origemPadrao) {
    PLUV_CFG.limiteMm = Number(j.limiteMm) || PLUV_CFG.limiteMm;
    PLUV_CFG.percentual = Number(j.percentual) || PLUV_CFG.percentual;
    PLUV_CFG.limiarMm = Number(j.limiarMm) || PLUV_CFG.limiteMm * (PLUV_CFG.percentual / 100);
    PLUV_CFG.metrica = j.metrica || 'c24';
    /* A ativação vem do servidor, não de um flag local. */
    PLUV_CFG.ativo = j.ativo !== false;
    PLUV_CFG.origem = j.origem || origemPadrao;
    PLUV_CFG.carregado = true;
    pluvCfgPintar();
}

async function pluvCfgCarregar() {
    try {
        if (!window.dcApi) throw new Error('cliente da API ausente');
        const r = await window.dcApi.pluvAlertaConfig();
        if (!r.ok) throw new Error('HTTP ' + r.status);
        pluvCfgAplicar(r.data || {});
    } catch (e) {
        /* Sem servidor: mantém o padrão local. O aviso fica degradado
           (limiar padrão 30 mm), nunca some de vez. */
        PLUV_CFG.origem = 'offline';
        pluvCfgPintar();
    }
    return PLUV_CFG;
}

function pluvCfgPintar() {
    const pct = document.getElementById('pcfPct');
    const lim = document.getElementById('pcfLim');
    const limiar = document.getElementById('pcfLimiar');
    const on = document.getElementById('pcfOn');
    if (pct) pct.value = PLUV_CFG.percentual;
    if (lim) lim.value = PLUV_CFG.limiteMm;
    if (on) on.checked = PLUV_CFG.ativo;
    if (limiar) {
        const v = PLUV_CFG.limiarMm;
        limiar.textContent = (v < 10 ? v.toFixed(1) : Math.round(v)) + ' mm';
    }
}

function pluvCfgStatus(msg, tipo) {
    const el = document.getElementById('pcfStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'pcf-status' + (tipo ? ' pcf-' + tipo : '');
}

function pluvCfgNum(input, min, max, dflt) {
    const n = Math.round(Number(input.value));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}

async function pluvCfgSalvar() {
    const pct = pluvCfgNum(document.getElementById('pcfPct'), 1, 100, PLUV_CFG.percentual);
    const lim = pluvCfgNum(document.getElementById('pcfLim'), 1, 1000, PLUV_CFG.limiteMm);
    const btn = document.getElementById('pcfSave');
    if (btn) btn.disabled = true;
    pluvCfgStatus('Salvando...');
    try {
        if (!window.dcApi) throw new Error('cliente da API ausente');
        /* dcApi envia o token de sessão; um fetch cru levaria 401. */
        const r = await window.dcApi.pluvAlertaSalvar({ limiteMm: lim, percentual: pct });
        if (!r.ok) {
            pluvCfgStatus(r.status === 401 ? 'Faça login para alterar o alerta' : (r.data.erro || 'Falha ao salvar'), 'err');
            return;
        }
        pluvCfgAplicar(r.data || {}, 'store');
        pluvCfgStatus('Salvo no servidor', 'ok');
        await pluvAlertaReavaliar();
    } catch (e) {
        pluvCfgStatus('Servidor indisponível', 'err');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function pluvCfgResetar() {
    const btn = document.getElementById('pcfReset');
    if (btn) btn.disabled = true;
    pluvCfgStatus('Restaurando padrão...');
    try {
        if (!window.dcApi) throw new Error('cliente da API ausente');
        const r = await window.dcApi.pluvAlertaResetar();
        if (!r.ok) {
            pluvCfgStatus(r.status === 401 ? 'Faça login para restaurar' : (r.data.erro || 'Falha ao restaurar'), 'err');
            return;
        }
        pluvCfgAplicar(r.data || {}, 'env');
        pluvCfgStatus('Padrão do servidor', 'ok');
        await pluvAlertaReavaliar();
    } catch (e) {
        pluvCfgStatus('Servidor indisponível', 'err');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* ---------- Avaliação + fila ----------
   O SERVIDOR decide o que cruzou o limiar. O front só transforma a
   resposta em popup e fila. Existe um caminho local apenas para o
   caso do servidor estar fora do ar — degradado, nunca mentindo:
   ele usa o mesmo limiar que o servidor devolveu por último.       */

/* Só o necessário para a avaliação — o resto da estação já está no
   mapa e ir no corpo mantém a requisição pequena. */
function pluvEstacaoCompacta(st) {
    return {
        codigo: st.codigo,
        nome: st.nome,
        lat: st.lat,
        lon: st.lon,
        c24: st.c24,
    };
}

function pluvCruzarLocal(limiar) {
    const saida = [];
    for (const st of pluvStations) {
        const c24 = Number(st.c24);
        /* Estação sem leitura não entra: Number(null) seria 0 e geraria
           alerta falso (ou esconderia uma estação que voltou a chover). */
        if (!Number.isFinite(c24) || c24 <= 0) continue;
        if (c24 < limiar) continue;
        saida.push({
            codigo: st.codigo, nome: st.nome, lat: st.lat, lon: st.lon,
            c24, percentual: PLUV_CFG.limiteMm > 0 ? (c24 / PLUV_CFG.limiteMm) * 100 : 0,
        });
    }
    return saida;
}

async function pluvAlertaReavaliar() {
    if (!PLUV_CFG.ativo) { pluvAlertaLimpar(); return; }

    let cruzadas = null;
    let limiar = Number(PLUV_CFG.limiarMm) || 0;
    let viaServidor = false;
    try {
        if (!window.dcApi) throw new Error('cliente da API ausente');
        const r = await window.dcApi.pluvAlertaAvaliar(pluvStations.map(pluvEstacaoCompacta));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = r.data || {};
        limiar = Number(j.limiarMm);
        /* O limiar autoritativo é o do servidor, não o que está na tela. */
        if (Number.isFinite(limiar) && limiar > 0 && limiar !== PLUV_CFG.limiarMm) {
            PLUV_CFG.limiarMm = limiar;
            pluvCfgPintar();
        }
        /* O servidor também decide se o alerta está ligado. Com ativo=false
           ele devolve "acima" vazio, e o mapa respeita isso. */
        PLUV_CFG.ativo = j.ativo !== false;
        cruzadas = PLUV_CFG.ativo && Array.isArray(j.acima) ? j.acima : [];
        viaServidor = true;
    } catch (e) {
        cruzadas = limiar > 0 && PLUV_CFG.ativo ? pluvCruzarLocal(limiar) : null;
    }

    if (limiar <= 0 || !cruzadas) { pluvAlertaLimpar(); return; }

    const acimaCodigos = new Set(cruzadas.map(e => String(e.codigo || '')));
    pluvAcimaSet = new Set(acimaCodigos);
    PLUV_CFG.origem = viaServidor ? 'servidor' : 'cache local';

    /* Libera quem NÃO está mais acima do limiar. Precisa ser um passo
       separado: o servidor devolve só quem cruzou, então uma estação que
       normalizou simplesmente desaparece da lista e nunca passaria pelo
       laço abaixo — ficaria travada como "já avisada" para sempre. */
    const conhecidos = Object.keys(pluvJaAvisado).concat(pluvAlertaFila.map(x => x.codigo));
    for (const codigo of conhecidos) {
        if (acimaCodigos.has(codigo)) continue;
        delete pluvJaAvisado[codigo];
        pluvAlertaFila = pluvAlertaFila.filter(x => x.codigo !== codigo);
    }

    for (const est of cruzadas) {
        const c24 = Number(est.c24);
        if (!Number.isFinite(c24) || c24 < limiar) continue;
        const codigo = String(est.codigo || '');
        if (pluvJaAvisado[codigo]) continue;   // já avisou nesta sessão

        const fila = pluvAlertaFila.find(x => x.codigo === codigo);
        if (fila) { fila.c24 = c24; fila.percent = est.percentual; continue; }
        pluvAlertaFila.push({
            codigo, nome: est.nome, lat: est.lat, lon: est.lon,
            c24, percent: Number(est.percentual) || 0,
        });
    }
    /* Pior primeiro: quem mais se aproximou do limite abre o popup primeiro. */
    pluvAlertaFila.sort((a, b) => b.c24 - a.c24);
    renderPluvTable();
    pluvAlertaAbrirProximo();
}

function pluvAlertaLimpar() {
    pluvAlertaFila = [];
    pluvAcimaSet = new Set();
    document.getElementById('rainAlertModal')?.classList.remove('open');
    pluvAlertaAberto = false;
    pluvAlertaAtual = null;
}

function pluvAlertaAbrirProximo() {
    if (pluvAlertaAberto || !pluvAlertaFila.length) return;
    const est = pluvAlertaFila.shift();
    pluvJaAvisado[est.codigo] = { pct: +est.percent.toFixed(1), c24: est.c24, ts: Date.now() };
    pluvAlertaMostrar(est);
    return;
}

function pluvAlertaMostrar(est) {
    const modal = document.getElementById('rainAlertModal');
    const card = document.getElementById('rainCard');
    if (!modal || !card) return;
    pluvAlertaAberto = true;
    pluvAlertaAtual = est;

    const pct = Math.round(est.percent);
    const cor = pct >= 100 ? '#dc2626' : pct >= 60 ? '#f97316' : '#eab308';
    const nivel = pct >= 100 ? 'Crítico' : pct >= 60 ? 'Alto' : 'Atenção';

    card.style.setProperty('--rain-c', cor);
    const icone = document.getElementById('rainIcon');
    if (icone) icone.innerHTML = `<i data-lucide="${pct >= 100 ? 'cloud-lightning' : 'cloud-rain'}"></i>`;
    const kicker = document.getElementById('rainKicker');
    if (kicker) kicker.textContent = 'Alerta de pluviômetro · INMET · ' + nivel;
    const titulo = document.getElementById('rainTitle');
    if (titulo) titulo.textContent = est.nome;
    const sev = document.getElementById('rainSev');
    if (sev) sev.textContent = pct + '% do limite';
    const desc = document.getElementById('rainDesc');
    if (desc) {
        desc.innerHTML = `A estação <b>${est.nome}</b> (${est.codigo}) acumulou `
            + `<b style="color:${cor};">${est.c24.toFixed(1)} mm em 24h</b>, equivalente a `
            + `<b>${pct}%</b> do limite configurado de <b>${PLUV_CFG.limiteMm} mm</b> `
            + `(dispara a partir de ${(+PLUV_CFG.limiarMm).toFixed(1)} mm). `
            + `Avalie risco de alagamento e deslizamento na área e acione a equipe se necessário.`;
    }
    const meta = document.getElementById('rainMeta');
    if (meta) {
        meta.innerHTML = `
            <span><b>Acumulado 24h:</b> ${est.c24.toFixed(1)} mm</span>
            <span><b>Limiar:</b> ${(+PLUV_CFG.limiarMm).toFixed(1)} mm</span>
            <span><b>Estação:</b> ${est.codigo}</span>
            <span><b>Origem do limite:</b> ${PLUV_CFG.origem}</span>`;
    }
    const regioes = document.getElementById('rainRegioes');
    if (regioes) {
        regioes.innerHTML = `<b>Regra:</b> popup dispara quando o acumulado 24h atinge `
            + `<b>${PLUV_CFG.percentual}%</b> de <b>${PLUV_CFG.limiteMm} mm</b>. `
            + `Uma sessão = um aviso por estação.`;
    }
    pluvAlertaCams(est);
    if (window.lucide) lucide.createIcons();
    modal.classList.add('open');
}

/* Câmeras SINFRA ao vivo mais próximas da estação que disparou. */
function pluvAlertaCams(est) {
    rainPintarCams(est.lat, est.lon, 'da estação');
}

/* Fechar: libera a fila para o próximo aviso. */
function pluvAlertaFechar() {
    document.getElementById('rainAlertModal').classList.remove('open');
    pluvAlertaAberto = false;
    pluvAlertaAtual = null;
    setTimeout(pluvAlertaAbrirProximo, 300);
}

/* Centraliza na estação que disparou. */
function pluvAlertaCentralizar() {
    const est = pluvAlertaAtual;
    pluvAlertaFechar();
    if (!est || !Number.isFinite(Number(est.lat)) || !Number.isFinite(Number(est.lon))) return;
    map.setView([Number(est.lat), Number(est.lon)], 11);
    if (camSinfraLayer && checkState.camsSinfra) { try { camSinfraLayer.addTo(map); } catch (e) {} }
    setTimeout(() => {
        if (pluvLayer) {
            const alvo = pluvStations.find(s => s.codigo === est.codigo);
            if (alvo) {
                for (const layer of Object.values(pluvLayer._layers || {})) {
                    const m = layer instanceof L.Marker ? layer : null;
                    if (!m) continue;
                    const p = m.getLatLng();
                    if (Math.abs(p.lat - alvo.lat) < 1e-6 && Math.abs(p.lng - alvo.lon) < 1e-6) {
                        m.openPopup();
                        break;
                    }
                }
            }
        }
    }, 400);
}

pluvCfgCarregar();

async function loadInmetPluvio() {
    if (pluvLoading) return;
    pluvLoading = true;
    const btn = document.getElementById('pluvRefresh');
    const empty = document.getElementById('pluvEmpty');
    const tbl = document.getElementById('pluvTable');
    if (btn) btn.disabled = true;
    empty.style.display = 'block';
    empty.textContent = 'Carregando estações INMET do estado todo...';
    tbl.style.display = 'none';
    try {
        const res = await dcProxyFetch('https://apitempo.inmet.gov.br/estacoes/T');
        const data = await res.json();
        // Fase 3+: nacional — mesma base de estações da camada INMET.
        const siglaUF = ufSiglaCorrente() || 'BR';
        const ufStations = ufSiglaCorrente()
            ? data.filter(s => (s.SG_ESTADO || '').toUpperCase() === siglaUF && s.VL_LATITUDE && s.VL_LONGITUDE)
            : data.filter(s => s.VL_LATITUDE && s.VL_LONGITUDE);
        // Agrupa em lotes (Open-Meteo aceita até ~50 pontos por chamada)
        const chunks = [];
        for (let i = 0; i < ufStations.length; i += 40) chunks.push(ufStations.slice(i, i + 40));
        const meteor = [];
        for (const chunk of chunks) {
            const lats = chunk.map(s => parseFloat(s.VL_LATITUDE)).join(',');
            const lons = chunk.map(s => parseFloat(s.VL_LONGITUDE)).join(',');
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=precipitation,relative_humidity_2m,temperature_2m&daily=precipitation_sum&timezone=America/Cuiaba&past_days=7&forecast_days=3`;
            try {
                const r = await dcProxyFetch(url);
                const j = await r.json();
                // Multi-ponto retorna um ARRAY de objetos; ponto único retorna objeto.
                if (Array.isArray(j)) meteor.push(j);
                else if (j && j.daily) meteor.push([j]);
            } catch (e) { /* estação lote falhou */ }
        }
        // Monta mapa de leituras por índice de estação
        const leituras = {};
        let idx = 0;
        for (let ci = 0; ci < chunks.length; ci++) {
            const arrLoc = meteor[ci] || [];
            for (let k = 0; k < chunks[ci].length; k++) {
                const globalIdx = idx++;
                const m = arrLoc[k];
                if (!m || !m.current) continue;
                const cur = m.current;
                const daily = m.daily;
                let sum7 = 0, c24 = 0;
                if (daily && daily.precipitation_sum && daily.time) {
                    const arr = daily.precipitation_sum;
                    const times = daily.time;
                    const today = new Date().toISOString().slice(0, 10);
                    // "c24" = acumulado até hoje; "sum7" = últimos 7 dias observados (até hoje)
                    const lastIdx = Math.min(arr.length, times.length);
                    for (let d = 0; d < lastIdx; d++) {
                        const v = parseFloat(arr[d]) || 0;
                        if (times[d] <= today) sum7 += v;
                        if (times[d] === today) c24 += v;
                    }
                } else if (daily && daily.precipitation_sum) {
                    const arr = daily.precipitation_sum;
                    const lastIdx = arr.length;
                    for (let d = Math.max(0, lastIdx - 7); d < lastIdx; d++) sum7 += (parseFloat(arr[d]) || 0);
                    c24 = parseFloat(arr[lastIdx - 1]) || 0;
                }
                leituras[globalIdx] = {
                    chuva: (cur.precipitation !== undefined ? cur.precipitation : 0),
                    c24: c24,
                    c7: sum7,
                    umid: (cur.relative_humidity_2m !== undefined ? cur.relative_humidity_2m : null),
                    temp: (cur.temperature_2m !== undefined ? cur.temperature_2m : null),
                };
            }
        }
        // Monta array de estações enriquecidas
        pluvStations = [];
        idx = 0;
        for (const s of ufStations) {
            const lat = parseFloat(s.VL_LATITUDE);
            const lon = parseFloat(s.VL_LONGITUDE);
            const leg = leituras[idx] || {};
            idx++;
            pluvStations.push({
                codigo: s.CD_ESTACAO,
                nome: s.DC_NOME,
                lat, lon,
                alt: s.VL_ALTITUDE,
                sit: s.CD_SITUACAO,
                chuva: leg.chuva ?? 0,
                c24: leg.c24 ?? 0,
                c7: leg.c7 ?? 0,
                umid: leg.umid,
                temp: leg.temp,
            });
        }

        // Camada de marcadores coloridos por intensidade de chuva
        if (pluvLayer) { try { map.removeLayer(pluvLayer); } catch {} }
        pluvLayer = L.layerGroup();
        pluvStations.forEach(st => {
            if (!st.lat || !st.lon) return;
            const m = L.marker([st.lat, st.lon], { icon: rainIconDiv(st.chuva, 24) });
            m.bindPopup(`
                <div style="min-width:190px;">
                    <div style="font-weight:700;font-size:12px;margin-bottom:2px;"><i data-lucide="droplets" style="color:#22d3ee;margin-right:4px;"></i>${st.nome}</div>
                    <div style="color:#94a3b8;font-size:10px;margin-bottom:7px;">${st.codigo} · INMET · ${(typeof ufSiglaCorrente === 'function' && ufSiglaCorrente()) || 'BR'}</div>
                    <div style="font-size:11px;line-height:1.7;">
                        <div><b style="color:${RAIN_COR(st.chuva)};">☔ Chuva agora:</b> ${st.chuva} mm/h</div>
                        <div><b>Chuva 24h:</b> ${st.c24} mm · <b>7d:</b> ${st.c7} mm</div>
                        <div><b>Temperatura:</b> ${st.temp !== null ? st.temp + ' °C' : '—'} · <b>Umid.:</b> ${st.umid !== null ? st.umid + '%' : '—'}</div>
                        <div><b>Altitude:</b> ${st.alt} m</div>
                        <div><b>Situação:</b> ${st.sit}</div>
                    </div>
                </div>`);
            m.addTo(pluvLayer);
        });
        pluvLayer.addTo(map);

        renderPluvTable();
        /* O limiar e o veredito vêm do servidor; só avaliamos depois que a
           configuração chegou, para não decidir com o padrão local. */
        if (!PLUV_CFG.carregado) await pluvCfgCarregar();
        await pluvAlertaReavaliar();
        empty.style.display = 'none';
        tbl.style.display = 'table';
        if (window.lucide) lucide.createIcons();
    } catch (e) {
        empty.style.display = 'block';
        empty.textContent = 'Falha ao carregar estações INMET.';
    } finally {
        if (btn) btn.disabled = false;
        pluvLoading = false;
    }
}

let pluvSortKey = 'codigo', pluvSortDir = 1, pluvLastFn = null;
function renderPluvTable() {
    const body = document.getElementById('pluvBody');
    const total = document.getElementById('psTotal');
    const oper = document.getElementById('psOper');
    const pane = document.getElementById('psPane');
    const top = document.getElementById('psTop');
    const q = (document.getElementById('pluvSearch')?.value || '').toLowerCase().trim();
    const f = document.getElementById('pluvFilter')?.value || 'all';
    let rows = pluvStations.filter(st => {
        if (q && !(st.nome.toLowerCase().includes(q) || String(st.codigo).toLowerCase().includes(q))) return false;
        if (f === 'op' && st.sit !== 'Operante') return false;
        if (f === 'pane' && st.sit === 'Operante') return false;
        if (f === 'chuva' && !(st.chuva > 0)) return false;
        return true;
    });
    rows.sort((a, b) => {
        const va = a[pluvSortKey], vb = b[pluvSortKey];
        const na = (va === null || va === undefined) ? -Infinity : (typeof va === 'string' ? va : va);
        const nb = (vb === null || vb === undefined) ? -Infinity : (typeof vb === 'string' ? vb : vb);
        if (na < nb) return -1 * pluvSortDir;
        if (na > nb) return 1 * pluvSortDir;
        return 0;
    });
    total.textContent = pluvStations.length;
    const pluvUfEl = document.getElementById('pluvUf');
    if (pluvUfEl) pluvUfEl.textContent = '— ' + ((typeof ufSiglaCorrente === 'function' && ufSiglaCorrente()) || 'BR');
    oper.textContent = pluvStations.filter(s => s.sit === 'Operante').length;
    pane.textContent = pluvStations.filter(s => s.sit !== 'Operante').length;
    const max24 = pluvStations.reduce((m, s) => (s.c24 > m) ? s.c24 : m, 0);
    top.textContent = max24 > 0 ? max24.toFixed(1) + ' mm' : '0 mm';
    document.querySelectorAll('#pluvTable th .arr').forEach(el => el.textContent = '');
    const th = document.querySelector(`#pluvTable th[data-sort="${pluvSortKey}"]`);
    if (th) th.querySelector('.arr').textContent = pluvSortDir > 0 ? '▲' : '▼';
    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="8" class="pluv-empty">Nenhuma estação encontrada.</td></tr>`;
        return;
    }
    const limiar = Number(PLUV_CFG.limiarMm) || 0;
    body.innerHTML = rows.map(st => {
        /* O destaque vem do veredito do servidor (pluvAcimaSet), não de
           uma conta feita aqui — a linha e o popup não podem divergir. */
        const cruzou = pluvAcimaSet.has(String(st.codigo));
        const pct = limiar > 0 && PLUV_CFG.limiteMm > 0 && Number.isFinite(Number(st.c24))
            ? (Number(st.c24) / PLUV_CFG.limiteMm) * 100 : null;
        const flag = cruzou
            ? `<span class="pluv-flag" title="Acumulado 24h acima do limiar de ${(+PLUV_CFG.limiarMm).toFixed(1)} mm"><i data-lucide="triangle-alert"></i>${pct >= 0 && Number.isFinite(pct) ? Math.round(pct) + '%' : ''}</span>`
            : '';
        return `
        <tr class="${st.sit === 'Operante' ? 'op' : 'pane'}${cruzou ? ' pluv-alerta' : ''}">
            <td style="font-weight:700;">${st.codigo}</td>
            <td>${st.nome}</td>
            <td><span class="pluv-rain-dot" style="background:${RAIN_COR(st.chuva)};"></span><b style="color:${RAIN_COR(st.chuva)};">${st.chuva}</b> mm/h</td>
            <td style="${cruzou ? 'color:#f97316;font-weight:700;' : ''}">${pluvChip(st.c24)} mm${flag}</td>
            <td>${pluvChip(st.c7)} mm</td>
            <td>${st.umid != null ? st.umid + '%' : '—'}</td>
            <td>${st.temp != null ? st.temp.toFixed(1) + '°' : '—'}</td>
            <td><span class="pluv-badge ${st.sit === 'Operante' ? 'op' : 'pane'}">${st.sit === 'Operante' ? 'OPERANTE' : 'PANE'}</span></td>
        </tr>`;
    }).join('');
    if (window.lucide) lucide.createIcons();
}

document.querySelectorAll('#pluvTable th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (pluvSortKey === key) pluvSortDir *= -1; else { pluvSortKey = key; pluvSortDir = 1; }
        renderPluvTable();
    });
});
document.getElementById('pluvSearch')?.addEventListener('input', renderPluvTable);
document.getElementById('pluvFilter')?.addEventListener('change', renderPluvTable);
document.getElementById('pluvRefresh')?.addEventListener('click', loadInmetPluvio);

/* --- Alerta de pluviômetro: config e liga/desliga --- */
document.getElementById('pcfSave')?.addEventListener('click', pluvCfgSalvar);
document.getElementById('pcfReset')?.addEventListener('click', pluvCfgResetar);
document.getElementById('pcfPct')?.addEventListener('input', e => {
    const p = pluvCfgNum(e.target, 1, 100, PLUV_CFG.percentual);
    const l = pluvCfgNum(document.getElementById('pcfLim'), 1, 1000, PLUV_CFG.limiteMm);
    const el = document.getElementById('pcfLimiar');
    if (el) el.textContent = (l * p / 100 < 10 ? (l * p / 100).toFixed(1) : Math.round(l * p / 100)) + ' mm';
});
document.getElementById('pcfLim')?.addEventListener('input', e => {
    const l = pluvCfgNum(e.target, 1, 1000, PLUV_CFG.limiteMm);
    const p = pluvCfgNum(document.getElementById('pcfPct'), 1, 100, PLUV_CFG.percentual);
    const el = document.getElementById('pcfLimiar');
    if (el) el.textContent = (l * p / 100 < 10 ? (l * p / 100).toFixed(1) : Math.round(l * p / 100)) + ' mm';
});
/* Liga/desliga o alerta. A ativação é gravada NO SERVIDOR — o mapa não
   decide sozinho o que fica ativo, e sim obedece ao que o servidor
   responde no GET seguinte. */
document.getElementById('pcfOn')?.addEventListener('change', async e => {
    const desired = !!e.target.checked;
    const cb = e.target;
    cb.disabled = true;
    try {
        if (!window.dcApi) throw new Error('cliente da API ausente');
        const r = await window.dcApi.pluvAlertaSalvar({ ativo: desired });
        if (!r.ok) {
            cb.checked = !desired;   // volta ao que o servidor manda
            pluvCfgStatus(r.status === 401 ? 'Faça login para ativar/desativar' : (r.data.erro || 'Falha ao alterar'), 'err');
            return;
        }
        pluvCfgAplicar(r.data || {}, 'store');
        pluvCfgStatus(desired ? 'Alerta ativado' : 'Alerta desativado', 'ok');
        if (PLUV_CFG.ativo) {
            document.getElementById('rainAlertModal')?.classList.remove('open');
            pluvAlertaAberto = false;
            pluvAlertaAtual = null;
            await pluvAlertaReavaliar();
        } else {
            pluvAlertaLimpar();
            renderPluvTable();
        }
    } catch (e) {
        cb.checked = !desired;
        pluvCfgStatus('Servidor indisponível', 'err');
    } finally {
        cb.disabled = false;
    }
});

document.getElementById('pluvClose')?.addEventListener('click', () => {
    document.getElementById('pluvPanel').classList.add('hidden-panel');
});
document.getElementById('pluvToggle')?.addEventListener('click', () => {
    const p = document.getElementById('pluvPanel');
    const opening = p.classList.contains('hidden-panel');
    p.classList.toggle('hidden-panel', !opening);
    if (opening && !pluvStations.length && !pluvLoading) loadInmetPluvio();
});
document.getElementById('pluvHead')?.addEventListener('click', (e) => {
    if (e.target.closest('.ph-close')) return;
    document.getElementById('pluvPanel').classList.toggle('collapsed');
});


