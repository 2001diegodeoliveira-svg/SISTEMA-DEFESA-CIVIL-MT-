/* SGI PROTEGE - Mapa Integrado (3/14): mapa-camadas. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= Ambiente: UCs via WMS CNUC ================= */
map.createPane('ambiente');
map.getPane('ambiente').style.zIndex = 350;
/* Fase 9: tiles WMS que falham avisam na meta-linha (1 aviso a cada 5 min). */
const wmsErroFlags = {};
function vigiarTilesWms(layer, metaId, nome) {
    if (!layer || !layer.on) return;
    layer.on('tileerror', () => {
        if (wmsErroFlags[metaId]) return;
        wmsErroFlags[metaId] = true;
        const meta = document.getElementById(metaId);
        if (meta && !/falhas de tiles/i.test(meta.textContent || '')) {
            meta.innerHTML += ` · <b style="color:#f87171;">${nome}: falhas de tiles</b>`;
        }
        setTimeout(() => { wmsErroFlags[metaId] = false; }, 5 * 60 * 1000);
    });
}
function loadUCs() {
    ucWms = L.tileLayer.wms('https://geoservicos.inde.gov.br/geoserver/ows', {
        layers: 'MMA:cnuc_2026_03',
        format: 'image/png', transparent: true, version: '1.3.0',
        pane: 'ambiente', opacity: .85,
        attribution: 'CNUC/MMA · INDE'
    });
}

/* ================= Delimitações: Biomas (IBGE) ================= */
function loadBiomas() {
    biomasWms = L.tileLayer.wms('https://geoservicos.ibge.gov.br/geoserver/ows', {
        layers: 'CREN:lm_bioma_250',
        format: 'image/png', transparent: true, version: '1.3.0',
        pane: 'ambiente', opacity: .7,
        attribution: 'IBGE · Biomas 1:250.000'
    });
}

/* ================= Delimitações: Terras Indígenas (FUNAI) ================= */
function loadTerrasIndigenas() {
    tiWms = L.tileLayer.wms('https://cmr.funai.gov.br/geoserver/ows', {
        layers: 'CMR-PUBLICO:lim_terra_indigena_a',
        format: 'image/png', transparent: true, version: '1.3.0',
        pane: 'ambiente', opacity: .75,
        attribution: 'FUNAI · Terras Indígenas'
    });
}

/* ================= Delimitações: UCs federais (ICMBio) ================= */
function loadUCsIcmbio() {
    ucIcmbioWms = L.tileLayer.wms('https://geoservicos.inde.gov.br/geoserver/ICMBio/ows', {
        layers: 'ICMBio:limiteucsfederais_a',
        format: 'image/png', transparent: true, version: '1.3.0',
        pane: 'ambiente', opacity: .8,
        attribution: 'ICMBio · Unidades de Conservação Federais'
    });
}

/* ================= Toggles de camadas (checkbox) ================= */
const checks = { mtOutline: () => mtLayer, municipios: () => munLayer, ucs: () => ucWms, biomas: () => biomasWms, terrasIndigenas: () => tiWms, ucsIcmbio: () => ucIcmbioWms, focos: () => focosLayer, barragens: () => barragensLayer, anaHydrology: () => anaHydrologyLayer, inmetStations: () => inmetLayer, sipam: () => sipamLayer, deter: () => deterLayer, qualidadeAr: () => qualidadeArLayer, wmsFocos48h: () => wmsFocos48hLayer, reports: () => reportsLayer, vigiaMais: () => vigiaMaisLayer, abrigos: () => abrigosLayer, camsSinfra: () => camSinfraLayer, chuvaInmet: () => chuvaInmetLayer, tempestadePotencial: () => avisosLayer };
const checkState = { mtOutline: true, municipios: true, ucs: false, biomas: false, terrasIndigenas: false, ucsIcmbio: false, deter: false, qualidadeAr: false, focos: false, barragens: false,
anaHydrology: false, inmetStations: false, sipam: false, wmsFocos48h: false, reports: true, vigiaMais: false, abrigos: true,
camsSinfra: true, chuvaInmet: false, tempestadePotencial: true };
let barragensLayer = null, barragensLoaded = false, barragensLoading = false;
let anaHydrologyLayer = null, anaHydrologyLoaded = false, anaHydrologyLoading = false;
let inmetLayer = null, inmetLoaded = false, inmetLoading = false;
let chuvaInmetLayer = null, chuvaInmetLoaded = false, chuvaInmetLoading = false;
        let sipamLayer = null, sipamLoaded = false, sipamLoading = false;
let deterLayer = null, deterLoaded = false, deterLoading = false;
let qualidadeArLayer = null, qualidadeArLoaded = false, qualidadeArLoading = false;
        let sipamData = [];
let wmsFocos48hLayer = null;
let wmsFocoDetalheLayer = null;
let wmsFocoDetalheData = [];
let wmsFocoDetalheLoading = false;
let wmsFocoDetalheTimer = null;
let reportsLayer = null, reportsLoaded = false, reportsLoading = false;
let reportSeenIds = new Set(), reportMarkerIds = new Map(), reportsTimer = null;
let selectedUfCode = '';
let ibgeStates = [];
/* UF corrente a partir do seletor de território (Fase 3+ nacional).
   Sem UF selecionada (visão Brasil) devolve null = sem filtro.
   Chamadas que exigem UF (fontes só-MT/AMZ) usam 'MT' como padrão. */
function apiBase() {
    try {
        return (typeof BACKEND_BASE !== 'undefined' && BACKEND_BASE) ? BACKEND_BASE : '';
    } catch (e) { return ''; }
}
function apiUrl(path) {
    return apiBase() + (path.startsWith('/') ? path : '/' + path);
}
function ufSiglaCorrente() {
    if (!selectedUfCode) return null;
    const cod = String(selectedUfCode).padStart(2, '0');
    const e = (ibgeStates || []).find(x => String(x.id).padStart(2, '0') === cod);
    return (e && e.sigla) ? String(e.sigla).toUpperCase() : null;
}
function ufNomeCorrente() {
    if (!selectedUfCode) return null;
    const cod = String(selectedUfCode).padStart(2, '0');
    const e = (ibgeStates || []).find(x => String(x.id).padStart(2, '0') === cod);
    return (e && e.nome) ? String(e.nome).toUpperCase() : null;
}
let ibgeMunicipiosDaUf = [];
let vigiaMaisLayer = null;
let abrigosLayer = null, abrigosLoaded = false, abrigosLoading = false;
let camSinfraLayer = null, camSinfraLoaded = false, camSinfraLoading = false;
let camSinfraData = [], camSinfraTimer = null;
/* Câmeras abertas — fontes atuais e futuras de videomonitoramento */
const CAMERA_BASE = 'https://obrasaovivo.sinfra.mt.gov.br';

function setCheck(key, val) {
    checkState[key] = val;
    const row = document.querySelector(`.check-row[data-check="${key}"]`);
    if (row) {
        row.querySelector('.toggle').classList.toggle('on', val);
        row.setAttribute('aria-checked', val ? 'true' : 'false');
    }
    if (key === 'focos' && val && !focosLoaded && !focosLoading) loadFocos();
    if (key === 'barragens' && val && !barragensLoaded && !barragensLoading) loadBarragens();
    if (key === 'anaHydrology' && val && !anaHydrologyLoaded && !anaHydrologyLoading) loadAnaHydrology();
    if (key === 'inmetStations' && val && !inmetLoaded && !inmetLoading) loadInmetStations();
    if (key === 'chuvaInmet' && val && !chuvaInmetLoaded && !chuvaInmetLoading) loadChuvaInmet();
    if (key === 'sipam' && val && !sipamLoaded && !sipamLoading) loadSIPAM();
    if (key === 'deter' && val && !deterLoaded && !deterLoading) loadDeter();
    if (key === 'qualidadeAr' && val && !qualidadeArLoaded && !qualidadeArLoading) loadQualidadeAr();
    if (key === 'reports' && val && !reportsLoaded && !reportsLoading) loadReports();
    if (key === 'abrigos' && val && !abrigosLoaded && !abrigosLoading) loadAbrigos();
    if (key === 'camsSinfra' && val && !camSinfraLoaded && !camSinfraLoading) loadCamerasSinfra();
    if (key === 'biomas' && val && !biomasWms) loadBiomas();
    if (key === 'terrasIndigenas' && val && !tiWms) loadTerrasIndigenas();
    if (key === 'ucsIcmbio' && val && !ucIcmbioWms) loadUCsIcmbio();
    if (key === 'tempestadePotencial') {
        avisosSeverityFilter = val ? 'Perigo Potencial' : null;
        refreshAvisosLayer();
    }
    applyChecks();
}
function applyChecks() {
    if (mtLayer) checkState.mtOutline ? mtLayer.addTo(map) : map.removeLayer(mtLayer);
    // Fase 8: malha municipal (centenas de paths) só a partir do zoom 7;
    // abaixo disso, só o contorno da UF — evita travar o zoom-out nacional.
    const mostraMun = checkState.municipios && map.getZoom() >= 7;
    if (munLayer) mostraMun ? munLayer.addTo(map) : map.removeLayer(munLayer);
    if (ucWms) checkState.ucs ? ucWms.addTo(map) : map.removeLayer(ucWms);
    if (biomasWms) checkState.biomas ? biomasWms.addTo(map) : map.removeLayer(biomasWms);
    if (tiWms) checkState.terrasIndigenas ? tiWms.addTo(map) : map.removeLayer(tiWms);
    if (ucIcmbioWms) checkState.ucsIcmbio ? ucIcmbioWms.addTo(map) : map.removeLayer(ucIcmbioWms);
    if (checkState.focos) {
        if (focosFiltrosAtivos() && focosFilteredLayer) {
            focosFilteredLayer.addTo(map);
            if (focosLayer) map.removeLayer(focosLayer);
        } else if (focosLayer && focosLoaded) {
            focosLayer.addTo(map);
            if (focosFilteredLayer) map.removeLayer(focosFilteredLayer);
        }
    } else {
        if (focosLayer) map.removeLayer(focosLayer);
        if (focosFilteredLayer) map.removeLayer(focosFilteredLayer);
    }
    if (barragensLayer) checkState.barragens ? barragensLayer.addTo(map) : map.removeLayer(barragensLayer);
    if (anaHydrologyLayer) checkState.anaHydrology ? anaHydrologyLayer.addTo(map) : map.removeLayer(anaHydrologyLayer);
    if (inmetLayer) checkState.inmetStations ? inmetLayer.addTo(map) : map.removeLayer(inmetLayer);
    if (chuvaInmetLayer) checkState.chuvaInmet ? chuvaInmetLayer.addTo(map) : map.removeLayer(chuvaInmetLayer);
    if (sipamLayer) checkState.sipam ? sipamLayer.addTo(map) : map.removeLayer(sipamLayer);
    if (deterLayer) checkState.deter ? deterLayer.addTo(map) : map.removeLayer(deterLayer);
    if (qualidadeArLayer) checkState.qualidadeAr ? qualidadeArLayer.addTo(map) : map.removeLayer(qualidadeArLayer);
    if (wmsFocos48hLayer) checkState.wmsFocos48h ? wmsFocos48hLayer.addTo(map) : map.removeLayer(wmsFocos48hLayer);
    if (wmsFocoDetalheLayer) checkState.wmsFocos48h ? wmsFocoDetalheLayer.addTo(map) : map.removeLayer(wmsFocoDetalheLayer);
    if (reportsLayer) checkState.reports ? reportsLayer.addTo(map) : map.removeLayer(reportsLayer);
    if (vigiaMaisLayer) checkState.vigiaMais ? vigiaMaisLayer.addTo(map) : map.removeLayer(vigiaMaisLayer);
    if (abrigosLayer) checkState.abrigos ? abrigosLayer.addTo(map) : map.removeLayer(abrigosLayer);
    if (camSinfraLayer) checkState.camsSinfra ? camSinfraLayer.addTo(map) : map.removeLayer(camSinfraLayer);
    if (checkState.tempestadePotencial) {
        if (avisosLayer) avisosLayer.addTo(map);
    } else {
        if (avisosLayer) map.removeLayer(avisosLayer);
    }
    refreshLegend();
}
document.querySelectorAll('.check-row').forEach(row => {
    row.addEventListener('click', () => {
        const key = row.dataset.check;
        setCheck(key, !checkState[key]);
    });
    // Fase 9 (a11y): toggles operáveis por teclado.
    row.setAttribute('role', 'switch');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-checked', checkState[row.dataset.check] ? 'true' : 'false');
    row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const key = row.dataset.check;
            setCheck(key, !checkState[key]);
        }
    });
});
// Fase 8: mostra/esconde a malha municipal conforme o zoom (ver applyChecks).
map.on('zoomend', () => { if (checkState.municipios) applyChecks(); });
function refreshLegend() {
    const box = document.getElementById('legendBox');
    document.getElementById('legRadar').style.display = activeOverlay === 'radar' ? '' : 'none';
    document.getElementById('legMun').style.display = (checkState.municipios && munLayer && map.getZoom() >= 7) ? '' : 'none';
    document.getElementById('legUc').style.display = checkState.ucs && ucWms ? '' : 'none';
    const legBiomas = document.getElementById('legBiomas'); if (legBiomas) legBiomas.style.display = checkState.biomas && biomasWms ? '' : 'none';
    const legTI = document.getElementById('legTI'); if (legTI) legTI.style.display = checkState.terrasIndigenas && tiWms ? '' : 'none';
    const legUcIcmbio = document.getElementById('legUcIcmbio'); if (legUcIcmbio) legUcIcmbio.style.display = checkState.ucsIcmbio && ucIcmbioWms ? '' : 'none';
    document.getElementById('legBarr').style.display = checkState.barragens && barragensLayer ? '' : 'none';
    document.getElementById('legAnaHydrology').style.display = checkState.anaHydrology && anaHydrologyLayer ? '' : 'none';
    document.getElementById('legInmet').style.display = checkState.inmetStations && inmetLayer ? '' : 'none';
    document.getElementById('legChuvaInmet').style.display = checkState.chuvaInmet && chuvaInmetLayer ? '' : 'none';
    document.getElementById('legSipam').style.display = checkState.sipam && sipamLayer ? '' : 'none';
    const legDeter = document.getElementById('legDeter');
    if (legDeter) legDeter.style.display = checkState.deter && deterLayer ? '' : 'none';
    const legAQ = document.getElementById('legQualidadeAr');
    if (legAQ) legAQ.style.display = checkState.qualidadeAr && qualidadeArLayer ? '' : 'none';
    document.getElementById('legFocosWms').style.display = checkState.wmsFocos48h && wmsFocos48hLayer ? '' : 'none';
    document.getElementById('legVigiaMais').style.display = checkState.vigiaMais && vigiaMaisLayer ? '' : 'none';
    document.getElementById('legAbrigos').style.display = checkState.abrigos && abrigosLayer ? '' : 'none';
    document.getElementById('legCamsSinfra').style.display = checkState.camsSinfra && camSinfraLayer ? '' : 'none';
    const anyVisible = activeOverlay === 'radar' || activeOverlay === 'clouds' || checkState.municipios || checkState.ucs || checkState.biomas || checkState.terrasIndigenas || checkState.ucsIcmbio || checkState.barragens || checkState.anaHydrology || checkState.inmetStations || checkState.chuvaInmet || checkState.sipam || checkState.wmsFocos48h || checkState.reports || checkState.vigiaMais || checkState.abrigos || checkState.camsSinfra;
    box.classList.toggle('show', anyVisible);
}

/* ================= Estações DC (para contagem em áreas) ================= */
const dcStations = ESTACOES_DC;

// Ícones inline (paths do Lucide) para marcadores do mapa — evita depender do
// timing de lucide.createIcons() em markers que só entram no DOM quando a
// camada é adicionada ao mapa.
const MARKER_SVG = {
    'cloud-rain': '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>',
    waves: '<path d="M2 12q2.5 2 5 0t5 0 5 0 5 0"/><path d="M2 19q2.5 2 5 0t5 0 5 0 5 0"/><path d="M2 5q2.5 2 5 0t5 0 5 0 5 0"/>',
    flame: '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>',
    home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'radio-tower': '<path d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9"/><path d="M7.8 4.7a6.14 6.14 0 0 0-.8 7.5"/><circle cx="12" cy="9" r="2"/><path d="M16.2 4.8c2 2 2.26 5.11.8 7.47"/><path d="M19.1 1.9a9.96 9.96 0 0 1 0 14.1"/><path d="M9.5 18h5"/><path d="m8 22 4-11 4 11"/>',
    cctv: '<path d="M16.75 12h3.632a1 1 0 0 1 .894 1.447l-2.034 4.069a1 1 0 0 1-1.708.134l-2.124-2.97"/><path d="M17.106 9.053a1 1 0 0 1 .447 1.341l-3.106 6.211a1 1 0 0 1-1.342.447L3.61 12.3a2.92 2.92 0 0 1-1.3-3.91L3.69 5.6a2.92 2.92 0 0 1 3.92-1.3z"/><path d="M2 19h3.76a2 2 0 0 0 1.8-1.1L9 15"/><path d="M2 21v-4"/><path d="M7 9h.01"/>',
    dam: '<path d="M8 8h8v13H8z"/><path d="M6.5 8h11"/><path d="M2 13q1.2 1 2.4 0t2.4 0"/><path d="M2 9.5c1.2 0 1.2 2 2.4 2s1.2-2 2.4-2"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
};
function iconDivMarker(iconKey, color, size) {
    size = size || 26;
    const inner = Math.round(size * 0.52);
    return L.divIcon({
        className: '',
        html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px ${color}77;"><svg xmlns="http://www.w3.org/2000/svg" width="${inner}" height="${inner}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${MARKER_SVG[iconKey] || ''}</svg></div>`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2]
    });
}

