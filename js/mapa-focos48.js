/* SGI PROTEGE - Mapa Integrado (11/14): mapa-focos48. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= INPE BDQueimadas — Camada WMS focos 48h (recorte apenas MT) ================= */
let MT_GEOM = [];
let MT_BBOX = null;
let mtClipPath = null;
function ensureWmsClipPane() {
    if (map.getPane('wmsPane')) { updateMtClip(); return true; }
    if (!MT_GEOM.length) return false;
    const pane = map.createPane('wmsPane');
    pane.style.zIndex = '250';
    pane.style.pointerEvents = 'none';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const clp = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    clp.id = 'mtFocosClip';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    clp.appendChild(path);
    svg.appendChild(clp);
    pane.appendChild(svg);
    pane.style.clipPath = 'url(#mtFocosClip)';
    pane.style.webkitClipPath = 'url(#mtFocosClip)';
    mtClipPath = path;
    updateMtClip();
    map.on('move zoom', updateMtClip);
    return true;
}
function updateMtClip() {
    if (!mtClipPath || !MT_GEOM.length) return;
    const pts = MT_GEOM.map(([la, ln]) => {
        const p = map.latLngToContainerPoint([la, ln]);
        return p.x.toFixed(1) + ',' + p.y.toFixed(1);
    });
    mtClipPath.setAttribute('d', 'M' + pts.join(' L') + ' Z');
}
function loadWmsFocos48h() {
    if (wmsFocos48hLayer) return;
    const clipped = ensureWmsClipPane();
    const opts = {
        layers: 'focos_48h_br_todosats',
        format: 'image/png', transparent: true, version: '1.1.1',
        opacity: .8, attribution: 'INPE/TerraBrasilis · BDQueimadas',
        tileSize: 512, maxZoom: 14, keepBuffer: 2, updateWhenIdle: false
    };
    if (MT_BBOX) opts.bounds = MT_BBOX;
    if (clipped) opts.pane = 'wmsPane';
    wmsFocos48hLayer = L.tileLayer.wms('https://terrabrasilis.dpi.inpe.br/queimadas/geoserver/dados_abertos/wms', opts);
    vigiarTilesWms(wmsFocos48hLayer, 'metaWmsFocos48h', 'TerraBrasilis');
    if (checkState.wmsFocos48h) wmsFocos48hLayer.addTo(map);
    loadWmsFocos48hDetalhe();
}

/* ================= DETER — alertas de desmatamento (raster nacional) ===============
   Fase 4 (verificado ao vivo em 2026-10-13): WMS do TerraBrasilis/INPE,
   sem chave — deter-amz (Amazônia Legal) + deter-cerrado (Cerrado).
   Raster por tiles: só baixa a área visível. Vetores/detalhes ficam
   para fase futura (WFS com filtro de data). */
async function loadDeter() {
    if (deterLoading) return;
    deterLoading = true;
    const meta = document.getElementById('metaDeter');
    if (meta) meta.innerHTML = 'INPE/TerraBrasilis · <b>carregando DETER...</b>';
    try {
        if (deterLayer) { try { map.removeLayer(deterLayer); } catch {} }
        const mkWms = (base, name) => L.tileLayer.wms(base + '/wms', {
            layers: name, format: 'image/png', transparent: true, version: '1.1.1',
            opacity: .75, maxZoom: 14, keepBuffer: 2, updateWhenIdle: false,
            attribution: 'INPE/TerraBrasilis · DETER',
        });
        deterLayer = L.layerGroup([
            mkWms('https://terrabrasilis.dpi.inpe.br/geoserver/deter-amz', 'deter-amz:deter_amz'),
            mkWms('https://terrabrasilis.dpi.inpe.br/geoserver/deter-cerrado-nb', 'deter-cerrado-nb:deter_cerrado'),
        ]);
        deterLayer.eachLayer(l => vigiarTilesWms(l, 'metaDeter', 'DETER'));
        if (checkState.deter) deterLayer.addTo(map);
        deterLoaded = true;
        deterLoading = false;
        if (meta) meta.innerHTML = 'INPE/TerraBrasilis · <b>DETER Amazônia + Cerrado</b> · raster nacional';
        let leg = document.getElementById('legDeter');
        if (!leg) {
            document.getElementById('legUc').insertAdjacentHTML('afterend',
                `<div id="legDeter" class="leg-row" style="display:none;"><span style="width:10px;height:10px;background:#a16207;display:inline-block;margin-right:5px;"></span> Alertas DETER (INPE)</div>`);
        }
        if (window.lucide) lucide.createIcons();
        refreshLegend();
    } catch (e) {
        deterLoading = false;
        if (meta) meta.textContent = 'DETER indisponível — sem dados no momento';
    }
}

/* ================= Focos 48h — Camada vetorial de detalhe (WFS TerraBrasilis) ================= */
// Limite de ícones de satélite: acima disso usa círculos canvas coloridos por
// risco (clique continua abrindo o popup detalhado) para preservar performance.
const FOCO_SAT_LIMIT = 1200;

// Ícone de satélite por foco — cor por risco de fogo, escala por FRP.
// reusa o visual glass .foco-sat já existente no CSS.
const SAT_SVG_PATH = '<circle cx="9.5" cy="12" r="2.6"/><path d="M3.5 7.5a6.3 6.3 0 0 0 0 9"/><path d="M20.5 7.5a6.3 6.3 0 0 1 0 9"/><path d="M7.2 10.4a3.2 3.2 0 0 0 0 3.2"/><path d="M16.8 10.4a3.2 3.2 0 0 1 0 3.2"/><path d="M12 21c-2 0-2.5-1.6-2.5-3.5 0-1.9.5-3.5 2.5-3.5s2.5 1.6 2.5 3.5c0 1.9-.5 3.5-2.5 3.5z"/><path d="M9.3 17.6 7.5 21"/><path d="M14.7 17.6 16.5 21"/>';
function focoSatIcon(risco, frp, nome) {
    const cor = focoRiscoCor(risco);
    const fs = Math.round(13 + Math.min(10, Math.sqrt(frp || 0) * 1.1));
    const host = nome ? nome.replace(/"/g, '&quot;') : '';
    return L.divIcon({
        className: '',
        html: `<div class="foco-sat" title="${host}" style="--fc:${cor};--fs:${fs}px;">
            <span class="foco-sat-ring"></span>
            <span class="foco-sat-core">
                <svg viewBox="0 0 24 24" fill="none" stroke="${cor}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${SAT_SVG_PATH}</svg>
            </span>
        </div>`,
        iconSize: [fs * 2, fs * 2],
        iconAnchor: [fs, fs]
    });
}

// Converte "2026-09-22T00:50:00Z" para hora local de MT (America/Cuiaba)
function fmtHoraMT(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString('pt-BR', { timeZone: 'America/Cuiaba', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Popup detalhado do foco 48h
function wmsFoco48Popup(f) {
    const frp = isFinite(f.frp) ? f.frp : 0;
    const risco = isFinite(f.risco_fogo) ? f.risco_fogo : 0;
    const cor = focoRiscoCor(risco);
    return `
        <div style="min-width:230px;font-size:11px;line-height:1.7;">
            <div style="font-weight:700;font-size:12.5px;color:#ff7a45;margin-bottom:4px;">
                <i data-lucide="flame"></i> Foco de calor — 48h (todos satélites)
            </div>
            <span class="foco-sat-badge"><i data-lucide="satellite"></i> ${f.satelite || '—'}</span>
            <div style="color:#94a3b8;font-size:10.5px;margin-bottom:6px;">${f.municipio || '—'} · ${(f.estado === 'MATO GROSSO') ? 'MT' : (f.estado || '')}</div>
            Detecção: <b>${fmtHoraMT(f.data_hora_gmt)}</b><br>
            Passagem: ${fmtDataISO(f.data_pas || '')}<br>
            Risco de fogo: <b style="color:${cor};">${Math.round(risco * 100)}%</b><br>
            FRP: ${frp.toFixed(1)} MW<br>
            ${f.bioma ? 'Bioma: ' + f.bioma + '<br>' : ''}
            ${f.vegetacao ? 'Vegetação: ' + f.vegetacao + '<br>' : ''}
            Precipitação: ${f.precipitacao} mm · Dias sem chuva: ${f.dias_sc}<br>
            Grade WRS: ${f.grade_wrs || '—'}<br>
            Lat/Lng: ${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}
            <div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);font-size:9px;color:#94a3b8;">
                Fonte: INPE BDQueimadas · TerraBrasilis WFS<br>
                Foco pontual não confirma incêndio — exige validação operacional.
            </div>
            <a href="https://www.waze.com/ul?ll=${f.lat},${f.lon}&navigate=yes&zoom=17" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding:10px 12px;background:linear-gradient(135deg,#33ccff,#0099ff);color:#fff;font-size:11px;font-weight:700;border-radius:8px;text-decoration:none;" onmouseover="this.style.transform='scale(1.03)';this.style.boxShadow='0 4px 16px rgba(0,153,255,.4)';" onmouseout="this.style.transform='';this.style.boxShadow='';">
                <i data-lucide="navigation"></i> Navegar com Waze
            </a>
        </div>`;
}

function buildWmsFoco48hDetalhe(features, totalFeatures) {
    const seen = new Set();
    const rows = [];
    for (const fc of features) {
        const p = fc.properties || {};
        const geom = fc.geometry || {};
        if (geom.type !== 'Point') continue;
        const [lon, lat] = geom.coordinates;
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const k = lat.toFixed(4) + ',' + lon.toFixed(4);
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({
            lat, lon,
            data_hora_gmt: p.data_hora_gmt || '',
            data_pas: p.data_pas || '',
            satelite: p.satelite || '',
            municipio: p.municipio || '',
            estado: p.estado || '',
            bioma: p.bioma || '',
            vegetacao: p.vegetacao || '',
            risco_fogo: parseFloat(p.risco_fogo) || 0,
            frp: parseFloat(p.frp) || 0,
            precipitacao: parseFloat(p.precipitacao) || 0,
            dias_sc: parseInt(p.numero_dias_sem_chuva) || 0,
            grade_wrs: p.grade_wrs || ''
        });
        if (rows.length >= FOCO_MAX_PONTOS) break;
    }
    rows.sort((a, b) => b.risco_fogo - a.risco_fogo);
    wmsFocoDetalheData = rows;

    if (wmsFocoDetalheLayer) { try { map.removeLayer(wmsFocoDetalheLayer); } catch {} }
    wmsFocoDetalheLayer = L.layerGroup({ renderer: canvasRenderer });
    // Exibe ícones de satélite apenas para os focos de maior risco (teto de
    // performance). rows já vem ordenado por risco decrescente.
    const shown = rows.slice(0, FOCO_SAT_LIMIT);
    shown.forEach(f => {
        const mk = L.marker([f.lat, f.lon], { icon: focoSatIcon(f.risco_fogo, f.frp, (f.satelite || '') + ' · ' + (f.municipio || '')) });
        mk.bindPopup(wmsFoco48Popup(f));
        mk.addTo(wmsFocoDetalheLayer);
    });
    if (checkState.wmsFocos48h) wmsFocoDetalheLayer.addTo(map);

    // Atualiza a meta com contagem real (totalFeatures) mostrada e horário
    const meta = document.getElementById('metaWmsFocos48h');
    if (meta) {
        const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const total = Math.max(rows.length, totalFeatures || 0);
        const rot = (typeof ufSiglaCorrente === 'function' && ufSiglaCorrente()) || '';
        meta.innerHTML = `TerraBrasilis · raster + vetorial 48h · <b>${shown.length.toLocaleString('pt-BR')} exibidos de ${total.toLocaleString('pt-BR')} focos${rot ? ' em ' + rot : ' no Brasil'}</b> · todos satélites · ${hora}`;
    }
    const leg = document.getElementById('legFocosWms');
    if (leg) {
        leg.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#ff4d00" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px;">${SAT_SVG_PATH}</svg> Focos 48h por satélite (INPE/TerraBrasilis)
            <span style="font-size:9px;color:#94a3b8;margin-left:6px;">cor = risco de fogo · ${shown.length.toLocaleString('pt-BR')} focos · clique p/ detalhes</span>`;
    }
}

async function loadWmsFocos48hDetalhe() {
    if (wmsFocoDetalheLoading) return;
    wmsFocoDetalheLoading = true;
    try {
        // Fase 3: nacional por padrão + recorte pela viewport (bbox) para
        // não baixar o Brasil inteiro de uma vez.
        const siglaUF = ufSiglaCorrente();
        const nomeUF = ufNomeCorrente();
        const filtros = [];
        if (nomeUF) filtros.push(`estado='${nomeUF.replace(/'/g, "''")}'`);
        let url = 'https://terrabrasilis.dpi.inpe.br/queimadas/geoserver/dados_abertos/ows' +
            '?service=WFS&version=1.1.0&request=GetFeature' +
            '&typeName=dados_abertos:focos_48h_br_todosats' +
            '&outputFormat=application/json&srsName=EPSG:4326' +
            '&maxFeatures=' + FOCO_MAX_PONTOS;
        try {
            // WFS 1.1.0 + EPSG:4326: bbox em ordem lat,lon.
            const b = map.getBounds();
            url += '&bbox=' + [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(v => v.toFixed(3)).join(',') + ',EPSG:4326';
        } catch (e) {}
        if (filtros.length) url += '&CQL_FILTER=' + encodeURIComponent(filtros.join(' AND '));
        const res = await dcProxyFetch(url);
        if (!res.ok) return;
        const j = await res.json();
        if (j && Array.isArray(j.features)) buildWmsFoco48hDetalhe(j.features, j.totalFeatures);
    } catch (e) { /* mantém só o raster */ }
    finally { wmsFocoDetalheLoading = false; }
    clearTimeout(wmsFocoDetalheTimer);
    wmsFocoDetalheTimer = setTimeout(loadWmsFocos48hDetalhe, 10 * 60 * 1000);
}

/* ================= INPE — Estilo avançado dos focos ================= */
function focoRiscoCor(risco) {
    if (risco >= 0.8) return '#dc2626';
    if (risco >= 0.6) return '#ef4444';
    if (risco >= 0.4) return '#f97316';
    if (risco >= 0.2) return '#fbbf24';
    return '#22c55e';
}
function focoRaio(frp) {
    if (!frp || frp <= 0) return 3;
    return Math.min(10, 2.5 + Math.sqrt(frp) / 3);
}

