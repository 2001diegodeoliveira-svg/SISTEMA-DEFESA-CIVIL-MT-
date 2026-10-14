/* SGI PROTEGE - Mapa Integrado (12/14): mapa-tabela. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= INPE — Dados brutos e filtros ================= */
let focosRawData = [];
let focosFilteredData = [];

function parseFocosCSV(csvText) {
    const lines = csvText.split('\n');
    if (lines.length < 2) return [];
    const header = lines[0].split(',').map(h => h.trim());
    const idx = {};
    ['lat','lon','data_hora_gmt','satelite','municipio','estado','bioma','risco_fogo','frp','precipitacao','numero_dias_sem_chuva'].forEach(k => {
        idx[k] = header.indexOf(k);
    });
    const result = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        if (cols.length < header.length - 2) continue;
        const lat = parseFloat(cols[idx.lat]);
        const lon = parseFloat(cols[idx.lon]);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const riscoRaw = parseFloat(cols[idx.risco_fogo]);
        const frpRaw = parseFloat(cols[idx.frp]);
        result.push({
            lat, lon,
            data: (cols[idx.data_hora_gmt] || '').trim(),
            satelite: (cols[idx.satelite] || '').trim(),
            municipio: (cols[idx.municipio] || '').trim(),
            estado: (cols[idx.estado] || '').trim(),
            bioma: (cols[idx.bioma] || '').trim(),
            risco_fogo: isNaN(riscoRaw) ? 0 : riscoRaw,
            frp: isNaN(frpRaw) ? 0 : frpRaw,
            precipitacao: parseFloat(cols[idx.precipitacao]) || 0,
            dias_sc: parseInt(cols[idx.numero_dias_sem_chuva]) || 0
        });
    }
    return result;
}

function focosFiltrosAtivos() {
    return !!(
        document.getElementById('filterSatelite').value ||
        document.getElementById('filterBioma').value ||
        parseInt(document.getElementById('filterRisco').value) > 0 ||
        parseInt(document.getElementById('filterFrp').value) > 0
    );
}
function focosFiltroTest(f) {
    const satFilter = document.getElementById('filterSatelite').value;
    const bioFilter = document.getElementById('filterBioma').value;
    const riscoMin = (parseInt(document.getElementById('filterRisco').value) || 0) / 100;
    const frpMin = parseInt(document.getElementById('filterFrp').value) || 0;
    if (satFilter && f.satelite !== satFilter) return false;
    if (bioFilter && f.bioma !== bioFilter) return false;
    if (f.risco_fogo < riscoMin) return false;
    if (f.frp < frpMin) return false;
    return true;
}
function applyFocosFilters() {
    focosFilteredData = focosRawData.filter(focosFiltroTest);
    renderFocosFiltered();
    renderDataTable();
    refreshLegend();
}

function renderFocosFiltered() {
    if (focosFilteredLayer) { try { map.removeLayer(focosFilteredLayer); } catch {} }
    focosFilteredLayer = L.layerGroup({ renderer: canvasRenderer });
    const MAX = FOCO_MAX_PONTOS;
    const data = focosFilteredData.slice(0, MAX);
    const useFlame = data.length <= FOCO_FLAME_LIMIT;
    data.forEach(f => {
        const cor = focoRiscoCor(f.risco_fogo);
        const raio = focoRaio(f.frp);
        const popup = `
            <div style="min-width:200px;">
                <div style="display:flex;align-items:center;gap:6px;font-weight:700;font-size:12px;color:${cor};margin-bottom:4px;">
                    <i data-lucide="flame"></i> Foco de calor
                </div>
                <span class="foco-sat-badge"><i data-lucide="satellite"></i> ${f.satelite || '—'}</span>
                <div style="color:#94a3b8;font-size:10px;margin-bottom:6px;">${f.municipio} · ${f.estado}</div>
                <div style="font-size:10.5px;line-height:1.7;">
                    <div><b>Data (GMT):</b> ${f.data}</div>
                    <div><b>Bioma:</b> ${f.bioma}</div>
                    <div><b>Risco de fogo:</b> <span style="color:${cor};font-weight:700;">${(f.risco_fogo * 100).toFixed(0)}%</span></div>
                    <div><b>FRP:</b> ${f.frp.toFixed(1)} MW</div>
                    <div><b>Precipitação:</b> ${f.precipitacao} mm</div>
                    <div><b>Dias sem chuva:</b> ${f.dias_sc}</div>
                    <div><b>Coords:</b> ${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}</div>
                </div>
            </div>`;
        const mk = useFlame
            ? L.marker([f.lat, f.lon], { icon: focoFlameIcon(f.risco_fogo, f.frp, (f.satelite || 'Satélite') + ' · ' + (f.municipio || '')) })
            : L.circleMarker([f.lat, f.lon], {
                renderer: canvasRenderer, radius: raio,
                color: cor, weight: .45, fillColor: cor, fillOpacity: .5
              });
        mk.bindPopup(popup).addTo(focosFilteredLayer);
    });
    if (checkState.focos) {
        if (focosLayer) map.removeLayer(focosLayer);
        focosFilteredLayer.addTo(map);
    }
}

/* ================= INPE — Tabela de dados ================= */
function renderDataTable() {
    const body = document.getElementById('dtBody');
    const count = document.getElementById('dtCount');
    const data = focosFilteredData.length ? focosFilteredData : focosRawData;
    count.textContent = `— ${data.length.toLocaleString('pt-BR')} registros (todos)`;
    const show = data.slice(0, FOCO_MAX_PONTOS);
    body.innerHTML = show.map(f => {
        const cor = focoRiscoCor(f.risco_fogo);
        return `<tr>
            <td>${f.data}</td>
            <td>${f.satelite}</td>
            <td>${f.municipio}</td>
            <td>${f.bioma}</td>
            <td><span class="risk-dot" style="background:${cor};"></span>${(f.risco_fogo * 100).toFixed(0)}%</td>
            <td>${f.frp.toFixed(1)}</td>
            <td>${f.precipitacao}</td>
            <td>${f.dias_sc}</td>
            <td>${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}</td>
        </tr>`;
    }).join('');
}

function exportFocosCSV() {
    const data = focosFilteredData.length ? focosFilteredData : focosRawData;
    if (!data.length) { toast('Sem dados de focos para exportar.'); return; }
    const cols = ['lat', 'lon', 'data', 'satelite', 'municipio', 'estado', 'bioma', 'risco_fogo', 'frp', 'precipitacao', 'dias_sc'];
    const cab = cols.join(';');
    const linhas = data.map(f => cols.map(c => (f[c] === undefined || f[c] === null ? '' : String(f[c])).replace(/;/g, ',')).join(';'));
    const csv = '\uFEFF' + cab + '\n' + linhas.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const hoje = new Date().toISOString().slice(0, 10);
    a.href = URL.createObjectURL(blob);
    a.download = `focos_mt_inpe_${hoje}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
    toast(`CSV exportado: ${data.length.toLocaleString('pt-BR')} focos.`);
}

/* ================= INPE — Wiring dos filtros e controles ================= */
document.getElementById('applyFiltersBtn').addEventListener('click', applyFocosFilters);
document.getElementById('filterRisco').addEventListener('input', e => {
    document.getElementById('riskFilterVal').textContent = (e.target.value / 100).toFixed(1);
});
document.getElementById('filterFrp').addEventListener('input', e => {
    document.getElementById('frpFilterVal').textContent = e.target.value;
});
document.querySelectorAll('#filterPeriodo .filter-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        const ativo = btn.classList.contains('active');
        document.querySelectorAll('#filterPeriodo .filter-btn').forEach(b => b.classList.remove('active'));
        if (ativo) { btn.classList.add('active'); return; }
        btn.classList.add('active');
        const dias = parseInt(btn.dataset.dias) || 1;
        focosPeriodoDias = dias;
        await loadFocosPeriodo(dias);
        if (window.lucide) lucide.createIcons();
    });
});
document.getElementById('exportFocosBtn').addEventListener('click', exportFocosCSV);
const exportCsvBtn = document.getElementById('exportCsvBtn');
if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportFocosCSV);

// Tabela toggle
const dtPanel = document.getElementById('dataTablePanel');
const toggleBtn = document.getElementById('toggleTableBtn');
const openTableBtn = document.getElementById('openTableBtn');

function setTablePanelState(visible) {
    dtPanel.classList.toggle('show', visible);
    toggleBtn.classList.toggle('show', visible);
}

document.getElementById('dtClose').addEventListener('click', () => {
    setTablePanelState(false);
});
openTableBtn.addEventListener('click', () => {
    if (focosRawData.length) {
        renderDataTable();
        setTablePanelState(true);
    } else {
        toast('Carregue a camada de focos primeiro.');
    }
});
toggleBtn.addEventListener('click', () => {
    const nextState = !dtPanel.classList.contains('show');
    setTablePanelState(nextState);
});

// WMS toggle
document.getElementById('applyChecks')?.addEventListener?.('click', () => {});
const _setCheck = setCheck;
setCheck = function(key, val) {
    _setCheck(key, val);
    if (key === 'wmsFocos48h' && val) loadWmsFocos48h();
    if (key === 'focos' && val && focosRawData.length) {
        renderFocosFiltered();
    }
};

