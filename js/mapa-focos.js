/* SGI PROTEGE - Mapa Integrado (4/14): mapa-focos. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= Focos de calor reais — INPE BDQueimadas ================= */
const canvasRenderer = L.canvas({ padding: 0.3 });
const FOCO_FLAME_LIMIT = 150;      // acima disso usa círculos canvas (performance; DOM só p/ poucos)
const FOCO_MAX_PONTOS = 6000;      // teto de pontos (mapa + tabela)
const FOCO_MAX_DIAS = 30;          // máximo de dias buscados por período
let focosPeriodoDias = 1;          // 1 = hoje (24h)

function fmtDataISO(iso) { if (!iso) return ''; const p = iso.slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

// Marcador de foco (detectado por satélite): chip glass com chama, cor por risco, escala por FRP
function focoFlameIcon(risco, frp, nome) {
    const cor = focoRiscoCor(risco);
    const fs = Math.round(14 + Math.min(10, Math.sqrt(frp || 0) * 1.1));
    const host = nome ? nome.replace(/"/g, '&quot;') : '';
    return L.divIcon({
        className: '',
        html: `<div class="foco-sat" title="${host}" style="--fc:${cor};--fs:${fs}px;">
            <span class="foco-sat-ring"></span>
            <span class="foco-sat-core">
                <svg viewBox="0 0 24 24" fill="${cor}" stroke="${cor}" stroke-width="1.1" stroke-linejoin="round">
                    <path d="M12 3c1.2 3.3 4.4 5.2 5.6 7.9A7.7 7.7 0 0 1 12 20.7 7.7 7.7 0 0 1 4.4 10.8c-.6-2.5 1-3.9 1.6-6 2.8 1.6 4.9 4 6 1.8z"/>
                </svg>
            </span>
        </div>`,
        iconSize: [fs * 2, fs * 2],
        iconAnchor: [fs, fs]
    });
}

// Popup dos focos (camada simples)
function focoPopupSimples(f, dataEst) {
    const frp = isFinite(f.frp) ? f.frp : NaN;
    return `
        <div style="min-width:200px;">
            <div style="font-weight:700;font-size:12.5px;color:#ff7a45;margin-bottom:4px;">
                <i data-lucide="flame"></i> Foco de calor detectado
            </div>
            <span class="foco-sat-badge"><i data-lucide="satellite"></i> ${f.satelite || '—'}</span>
            <div style="color:#94a3b8;font-size:10.5px;margin-bottom:6px;">${f.municipio || '—'} · ${f.estado === 'MATO GROSSO' ? 'MT' : (f.estado || '')}</div>
            <div style="font-size:11px;line-height:1.75;">
                Detecção (GMT): ${f.data || '—'}<br>
                ${f.bioma ? 'Bioma: ' + f.bioma + '<br>' : ''}
                ${isFinite(frp) ? 'FRP: ' + frp + ' MW<br>' : ''}
                Lat/Lng: ${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}
            </div>
            <div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);font-size:9px;color:#94a3b8;line-height:1.5;">
                Fonte: INPE BDQueimadas ${dataEst ? '· ' + dataEst : ''}<br>
                Foco pontual não confirma incêndio — exige validação operacional.
                <a href="https://data.inpe.br/queimadas/bdqueimadas/" target="_blank" rel="noopener" style="color:#38bdf8;">portal oficial</a>
            </div>
            <a href="https://www.waze.com/ul?ll=${f.lat},${f.lon}&navigate=yes&zoom=17" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding:7px 12px;background:linear-gradient(135deg,#33ccff,#0099ff);color:#fff;font-size:11px;font-weight:700;border-radius:8px;text-decoration:none;transition:transform .15s,box-shadow .15s;" onmouseover="this.style.transform='scale(1.03)';this.style.boxShadow='0 4px 16px rgba(0,153,255,.4)';" onmouseout="this.style.transform='';this.style.boxShadow='';">
                <i data-lucide="navigation"></i> Navegar com Waze
            </a>
        </div>`;
}

// Monta a camada simples de focos (chamas para poucos pontos, círculos p/ muitos)
function buildFocosLayer(rows, dataEst) {
    focosLayer = L.layerGroup({ renderer: canvasRenderer });
    const useFlame = rows.length <= FOCO_FLAME_LIMIT;
    rows.forEach(f => {
        const popup = focoPopupSimples(f, dataEst);
        if (useFlame) {
            L.marker([f.lat, f.lon], { icon: focoFlameIcon(f.risco_fogo, f.frp, (f.satelite || 'Satélite') + ' · ' + (f.municipio || '')) }).bindPopup(popup).addTo(focosLayer);
        } else {
            L.circleMarker([f.lat, f.lon], {
                renderer: canvasRenderer,
                radius: focoRaio(f.frp),
                color: '#ffb08a', weight: .4, fillColor: '#ff4d00', fillOpacity: .45
            }).bindPopup(popup).addTo(focosLayer);
        }
    });
    return focosLayer;
}

// Baixa o CSV diário do Brasil e devolve { iso, rows } (só MT) ou null
async function fetchFocosDia(iso) {
    try {
        const res = await dcProxyFetch(`https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/focos_diario_br_${iso}.csv`);
        if (!res.ok) return null;
        let txt = await res.text();
        if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
        if (txt.length < 101) return null;
        return { iso, rows: parseFocosCSV(txt) };
    } catch (e) { return null; }
}

async function loadFocos() {
    return loadFocosPeriodo(focosPeriodoDias);
}

async function loadFocosPeriodo(dias) {
    focosLoading = true;
    const meta = document.getElementById('metaFocos');
    meta.innerHTML = 'INPE BDQueimadas · <b>carregando...</b>';

    if (focosLayer) { try { map.removeLayer(focosLayer); } catch {} }
    focosLayer = null;
    if (focosFilteredLayer) { try { map.removeLayer(focosFilteredLayer); } catch {} }
    focosFilteredLayer = null;

    const diasArr = [];
    const nDias = Math.max(1, Math.min(Math.round(dias) || 1, FOCO_MAX_DIAS));
    for (let i = 0; i < nDias; i++) {
        const d = new Date(Date.now() - i * 86400000);
        diasArr.push(d.toISOString().slice(0, 10).replaceAll('-', ''));
    }

    const collect = [];
    const LOTE = 3;
    for (let i = 0; i < diasArr.length; i += LOTE) {
        const lote = diasArr.slice(i, i + LOTE);
        const resps = await Promise.all(lote.map(iso => fetchFocosDia(iso)));
        resps.forEach(r => { if (r) collect.push(...r.rows); });
        meta.innerHTML = `INPE BDQueimadas · <b>carregando ${nDias}d</b> (${Math.min(i + LOTE, diasArr.length)}/${diasArr.length})...`;
    }

    if (!collect.length) {
        meta.textContent = 'INPE indisponível — sem dados no momento (tente recarregar a camada)';
        toast('Não foi possível obter os focos do INPE agora.');
        focosLoading = false;
        return;
    }

    // Remove duplicados, filtra pela UF selecionada e aplica teto de pontos.
    // Sem UF (visão Brasil): cobertura nacional até o teto.
    const siglaUF = ufSiglaCorrente();
    const nomeUF = ufNomeCorrente();
    const base = nomeUF
        ? collect.filter(f => (f.estado || '').trim().toUpperCase() === nomeUF)
        : collect;
    const rotuloUF = siglaUF ? ' em ' + siglaUF : ' no Brasil';
    const seen = new Set();
    const rows = [];
    for (const f of base) {
        const k = f.lat.toFixed(4) + ',' + f.lon.toFixed(4) + ',' + f.data;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push(f);
        if (rows.length >= FOCO_MAX_PONTOS) break;
    }
    rows.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : b.risco_fogo - a.risco_fogo));

    const dataEst = rows.length ? fmtDataISO(rows[0].data) + ' → ' + fmtDataISO(rows[rows.length - 1].data) : '';
    buildFocosLayer(rows, dataEst);
    focosCount = rows.length;
    focosLoaded = true;
    focosLoading = false;
    focosRawData = rows;
    focosFilteredData = focosFiltrosAtivos() ? rows.filter(focosFiltroTest) : [...rows];

    const rotulo = nDias <= 1 ? '24h' : (nDias === 2 ? '48h' : nDias + 'd');
    const horaCsv = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    meta.innerHTML = `INPE BDQueimadas · <b>${rows.length.toLocaleString('pt-BR')} focos${rotuloUF}</b> · ${rotulo} · ${horaCsv}`;
    const lbl = document.querySelector('.check-row[data-check="focos"] label');
    if (lbl) lbl.innerHTML =
        `<span class="swatch" style="background:#ff4d00;border-radius:50%;"></span><i data-lucide="flame"></i>Focos de calor ${rotulo} <b style="color:#ff7a45;">(${rows.length.toLocaleString('pt-BR')})</b> <span style="font-size:9px;color:#94a3b8;font-weight:400;">· ${horaCsv}</span>`;
    if (window.lucide) lucide.createIcons();
    let leg = document.getElementById('legFocos');
    if (!leg) {
        document.getElementById('legUc').insertAdjacentHTML('beforebegin',
            `<div id="legFocos" class="leg-row" style="display:none;"><span style="width:10px;height:10px;border-radius:50%;background:#ff4d00;display:inline-block;"></span> Focos de calor (INPE)</div>`);
    }
    refreshLegend();

    if (checkState.focos) {
        if (focosFiltrosAtivos()) renderFocosFiltered();
        else focosLayer.addTo(map);
    }
    clearTimeout(focosReloadTimer);
    focosReloadTimer = setTimeout(loadFocos, 10 * 60 * 1000);
}

// Atualiza legenda de focos junto com as demais
const _refreshLegend = refreshLegend;
refreshLegend = function () {
    _refreshLegend();
    const lf = document.getElementById('legFocos');
    if (lf) lf.style.display = checkState.focos && focosLoaded ? '' : 'none';
};

