/* SGI PROTEGE - Mapa El Niño (Fase 1): mapa-elnino.js
   Script clássico (sem módulos ES): depende da ordem dos <script> em el-nino.html; compartilha escopo global.
   Camadas: SST anomaly (NOAA OISST), polígono Niño 3.4, focos de calor (INPE/FIRMS), gráfico histórico Niño 3.4. */
const ELNINO = {
    sstLayer: null,
    nino34Polygon: null,
    focosLayer: null,
    focosLoaded: false,
    sstLoaded: false,
    sstLoading: false,
    focosLoading: false,
    timelineData: [],
    timelineIndex: 0,
    timelineTimer: null,
    timelinePlaying: false,
    opacity: 0.7,
};

const NINO34_BOUNDS = [[-5, -170], [5, -120]]; // [lat, lon] - Niño 3.4 region

function elninoToast(msg, info = false) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.innerHTML = msg;
    t.classList.toggle('info', info);
    t.classList.add('show');
    clearTimeout(t._to);
    t._to = setTimeout(() => t.classList.remove('show'), info ? 4200 : 3500);
}

function elninoFmtDate(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).replace('.', '');
    } catch { return String(iso); }
}

function elninoFmtDateTime(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '');
    } catch { return String(iso); }
}

function elninoSstColor(anom) {
    if (anom === null || anom === undefined || !Number.isFinite(anom)) return '#64748b';
    if (anom <= -2) return '#08306b';
    if (anom <= -1.5) return '#2171b5';
    if (anom <= -1) return '#4292c6';
    if (anom <= -0.5) return '#9ecae1';
    if (anom < 0.5) return '#f7f7f7';
    if (anom < 1) return '#fee0d2';
    if (anom < 1.5) return '#fcbba1';
    if (anom < 2) return '#fc9272';
    if (anom < 2.5) return '#fb6a4a';
    if (anom < 3) return '#ef3b2c';
    return '#cb181d';
}

async function elninoLoadSST() {
    if (ELNINO.sstLoading) return;
    ELNINO.sstLoading = true;
    const meta = document.getElementById('elninoSstMeta');
    if (meta) meta.innerHTML = 'NOAA OISST · <b>carregando...</b>';
    try {
        const res = await dcProxyFetch('/api/elnino-mapa?camada=sst');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data.geojson || !data.geojson.features?.length) throw new Error('GeoJSON vazio');

        if (ELNINO.sstLayer) {
            try { map.removeLayer(ELNINO.sstLayer); } catch {}
        }

        ELNINO.sstLayer = L.geoJSON(data.geojson, {
            style: f => ({
                fillColor: elninoSstColor(f.properties?.anom),
                fillOpacity: ELNINO.opacity,
                color: '#334155',
                weight: 0.5,
            }),
            onEachFeature: (f, layer) => {
                const anom = f.properties?.anom;
                const date = f.properties?.date;
                layer.bindTooltip(`Anomalia SST: ${anom !== null && anom !== undefined ? anom.toFixed(2) : '—'} °C<br>${date ? elninoFmtDate(date) : ''}`, {
                    sticky: true, direction: 'top', offset: [0, -8]
                });
            },
        }).addTo(map);

        ELNINO.timelineData = data.timeline || [];
        ELNINO.timelineIndex = ELNINO.timelineData.length - 1;
        ELNINO.sstLoaded = true;
        if (meta) {
            const latest = data.latest || {};
            meta.innerHTML = `NOAA OISST · <b>${elninoFmtDate(latest.date)}</b> · resolução 0.25° · anomalia vs 1991-2020`;
        }
        elninoUpdateTimelineUI();
    } catch (e) {
        if (meta) meta.innerHTML = 'NOAA OISST · <b style="color:#f87171;">indisponível</b>';
        elninoToast('Não foi possível carregar a anomalia de SST (NOAA OISST).');
    } finally {
        ELNINO.sstLoading = false;
    }
}

function elninoAddNino34Polygon() {
    if (ELNINO.nino34Polygon) {
        try { map.removeLayer(ELNINO.nino34Polygon); } catch {}
    }
    const poly = L.polygon([
        [-5, -170], [5, -170], [5, -120], [-5, -120], [-5, -170]
    ], {
        color: '#f97316',
        weight: 2,
        dashArray: '8, 6',
        fillColor: '#f97316',
        fillOpacity: 0.08,
    }).bindTooltip('Região Niño 3.4 (5°N–5°S, 170°W–120°W)', { permanent: false, direction: 'center' });
    poly.addTo(map);
    ELNINO.nino34Polygon = poly;
}

async function elninoLoadFocos() {
    if (ELNINO.focosLoading) return;
    ELNINO.focosLoading = true;
    const meta = document.getElementById('elninoFocosMeta');
    if (meta) meta.innerHTML = 'Focos de calor �� <b>carregando...</b>';
    const dias = (document.getElementById('elninoFocosDias')?.value) || '3';
    const regiao = (document.getElementById('elninoFocosRegiao')?.value) || 'mt';
    try {
        const res = await dcProxyFetch('/api/elnino-mapa?camada=focos&dias=' + encodeURIComponent(dias) + '&regiao=' + encodeURIComponent(regiao));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data.geojson || !data.geojson.features?.length) throw new Error('Sem focos');

        if (ELNINO.focosLayer) {
            try { map.removeLayer(ELNINO.focosLayer); } catch {}
        }

        const cluster = (typeof L.markerClusterGroup === 'function') ? L.markerClusterGroup() : L.layerGroup();
        data.geojson.features.forEach(f => {
            const p = f.properties || {};
            const latlng = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
            const frp = p.frp || 0;
            const radius = Math.max(4, Math.min(12, 4 + Math.log10((frp || 0) + 1) * 3));
            const marker = L.circleMarker(latlng, {
                radius,
                fillColor: frp > 50 ? '#dc2626' : frp > 20 ? '#f97316' : '#fbbf24',
                fillOpacity: 0.85,
                color: '#fff',
                weight: 1,
            });
            const conf = p.confianca ? String(p.confianca) : '-';
            const escHtml = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            marker.bindPopup(
                '<b>Foco de calor</b><br>' +
                'Data/hora: ' + escHtml(elninoFmtDateTime(p.data_hora)) + '<br>' +
                'Satelite: ' + escHtml(p.satellite || '-') + '<br>' +
                'Confianca: ' + escHtml(conf) + '<br>' +
                'FRP: ' + (Number.isFinite(frp) ? frp.toFixed(1) : '-') + ' MW'
            );
            cluster.addLayer(marker);
        });
        cluster.addTo(map);
        ELNINO.focosLayer = cluster;

        ELNINO.focosLoaded = true;
        if (meta) meta.innerHTML = 'Focos de calor (' + (data.fonte || 'NASA FIRMS') + ') �� <b>' + (data.total || 0) + '</b> focos �� atualizado em: ' + elninoFmtDateTime(data.atualizadoEm || data.updated);
    } catch (e) {
        if (meta) meta.innerHTML = 'Focos de calor �� <b style="color:#f87171;">indispon��vel</b>';
        elninoToast('Nǜo foi poss��vel carregar focos de calor.');
    } finally {
        ELNINO.focosLoading = false;
    }
}

async function elninoLoadInmetAvisos() {
    const el = document.getElementById('inmetAvisosLista');
    if (!el) return;
    try {
        const res = await dcProxyFetch('/api/inmet-avisos');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const avisos = data.avisos || [];
        if (!avisos.length) {
            el.innerHTML = '<p>Nenhum aviso ativo no momento.</p>';
            return;
        }
        el.innerHTML = avisos.slice(0, 8).map(a => {
            const tipo = a.descricao || a.tipo || 'Aviso';
            const sev = a.severidade || '';
            const fim = a.data_fim || a.dataFim || '';
            return '<div style="padding:6px 0;border-bottom:1px solid var(--border-color);">' +
                '<b>' + (tipo) + '</b> ' + (sev ? '(' + sev + ')' : '') + '<br>' +
                (fim ? 'ate ' + elninoFmtDate(fim) : '') + '</div>';
        }).join('') + (avisos.length > 8 ? '<p style="font-size:11px;">+' + (avisos.length-8) + ' avisos</p>' : '');
    } catch (e) {
        el.innerHTML = '<p style="color:#f87171;">Indisponivel.</p>';
    }
}

async function elninoLoadNino34Chart() {
    const canvas = document.getElementById('elninoNino34Chart');
    if (!canvas) return;
    try {
        const res = await dcProxyFetch('/api/elnino-mapa?camada=nino34-series');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data.series?.length) throw new Error('Série vazia');

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const width = rect.width;
        const height = rect.height;
        const padding = { top: 20, right: 60, bottom: 40, left: 50 };
        const plotW = width - padding.left - padding.right;
        const plotH = height - padding.top - padding.bottom;

        const values = data.series.map(d => d.valor);
        const dates = data.series.map(d => d.data);
        const minVal = Math.min(...values, -3);
        const maxVal = Math.max(...values, 3);
        const range = maxVal - minVal || 1;

        const x = i => padding.left + (i / (dates.length - 1)) * plotW;
        const y = v => padding.top + plotH - ((v - minVal) / range) * plotH;

        ctx.clearRect(0, 0, width, height);

        // Grid horizontal
        ctx.strokeStyle = 'rgba(148,163,184,0.15)';
        ctx.lineWidth = 1;
        [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3].forEach(v => {
            if (v < minVal || v > maxVal) return;
            const yy = y(v);
            ctx.beginPath(); ctx.moveTo(padding.left, yy); ctx.lineTo(width - padding.right, yy); ctx.stroke();
            ctx.fillStyle = '#94a3b8';
            ctx.font = '10px Inter';
            ctx.fillText(v.toFixed(1), width - padding.right + 4, yy + 3);
        });

        // Banda neutra
        ctx.fillStyle = 'rgba(148,163,184,0.1)';
        ctx.fillRect(padding.left, y(0.5), plotW, y(-0.5) - y(0.5));

        // Linha zero
        ctx.strokeStyle = 'rgba(148,163,184,0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(padding.left, y(0)); ctx.lineTo(width - padding.right, y(0)); ctx.stroke();
        ctx.setLineDash([]);

        // Série histórica
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        data.series.forEach((d, i) => {
            if (i === 0) ctx.moveTo(x(i), y(d.valor));
            else ctx.lineTo(x(i), y(d.valor));
        });
        ctx.stroke();

        // Último ponto
        const last = data.series[data.series.length - 1];
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(x(dates.length - 1), y(last.valor), 4, 0, Math.PI * 2);
        ctx.fill();

        // Legenda
        ctx.fillStyle = '#f1f5f9';
        ctx.font = '11px Inter';
        ctx.fillText(`Niño 3.4 (ONI) · último: ${last.valor.toFixed(2)}°C (${elninoFmtDate(last.data)})`, padding.left, 14);

        if (window.lucide) lucide.createIcons();
    } catch (e) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px Inter';
        ctx.fillText('Série Niño 3.4 indisponível', 20, 50);
    }
}

function elninoUpdateTimelineUI() {
    const slider = document.getElementById('elninoTimelineSlider');
    const label = document.getElementById('elninoTimelineLabel');
    const playBtn = document.getElementById('elninoPlayBtn');
    if (!slider || !ELNINO.timelineData.length) return;
    slider.max = ELNINO.timelineData.length - 1;
    slider.value = ELNINO.timelineIndex;
    const frame = ELNINO.timelineData[ELNINO.timelineIndex];
    if (label && frame) {
        label.textContent = `Anomalia SST · ${elninoFmtDate(frame.date)} ${frame.isForecast ? ' (previsão)' : ''}`;
    }
    if (playBtn) {
        playBtn.innerHTML = `<i data-lucide="${ELNINO.timelinePlaying ? 'pause' : 'play'}"></i>`;
        if (window.lucide) lucide.createIcons();
    }
}

function elninoShowTimelineFrame(idx) {
    if (!ELNINO.timelineData.length) return;
    idx = Math.max(0, Math.min(ELNINO.timelineData.length - 1, idx));
    ELNINO.timelineIndex = idx;
    const frame = ELNINO.timelineData[idx];
    if (!frame || !frame.geojson) return;

    if (ELNINO.sstLayer) {
        try { map.removeLayer(ELNINO.sstLayer); } catch {}
    }
    ELNINO.sstLayer = L.geoJSON(frame.geojson, {
        style: f => ({
            fillColor: elninoSstColor(f.properties?.anom),
            fillOpacity: ELNINO.opacity,
            color: '#334155',
            weight: 0.5,
        }),
        onEachFeature: (f, layer) => {
            const anom = f.properties?.anom;
            layer.bindTooltip(`Anomalia SST: ${anom !== null && anom !== undefined ? anom.toFixed(2) : '—'} °C`, {
                sticky: true, direction: 'top', offset: [0, -8]
            });
        },
    }).addTo(map);

    elninoUpdateTimelineUI();
}

function elninoToggleTimelinePlay() {
    if (!ELNINO.timelineData.length) return;
    ELNINO.timelinePlaying = !ELNINO.timelinePlaying;
    const playBtn = document.getElementById('elninoPlayBtn');
    if (ELNINO.timelinePlaying) {
        if (playBtn) playBtn.innerHTML = '<i data-lucide="pause"></i>';
        ELNINO.timelineTimer = setInterval(() => {
            ELNINO.timelineIndex = (ELNINO.timelineIndex + 1) % ELNINO.timelineData.length;
            elninoShowTimelineFrame(ELNINO.timelineIndex);
        }, 800);
    } else {
        if (playBtn) playBtn.innerHTML = '<i data-lucide="play"></i>';
        clearInterval(ELNINO.timelineTimer);
        ELNINO.timelineTimer = null;
    }
    if (window.lucide) lucide.createIcons();
}

function elninoSetOpacity(val) {
    ELNINO.opacity = val / 100;
    const opacityVal = document.getElementById('elninoOpacityVal');
    if (opacityVal) opacityVal.textContent = val + '%';
    if (ELNINO.sstLayer) {
        ELNINO.sstLayer.eachLayer(l => l.setStyle({ fillOpacity: ELNINO.opacity }));
    }
}

function elninoBindControls() {
    const slider = document.getElementById('elninoTimelineSlider');
    const playBtn = document.getElementById('elninoPlayBtn');
    const opacityRange = document.getElementById('elninoOpacityRange');
    const chkSst = document.getElementById('elninoChkSst');
    const chkNino34 = document.getElementById('elninoChkNino34');
    const chkFocos = document.getElementById('elninoChkFocos');
    const refreshBtn = document.getElementById('elninoRefreshBtn');

    if (slider) slider.addEventListener('input', e => {
        ELNINO.timelinePlaying = false;
        clearInterval(ELNINO.timelineTimer);
        ELNINO.timelineTimer = null;
        elninoShowTimelineFrame(+e.target.value);
    });
    if (playBtn) playBtn.addEventListener('click', elninoToggleTimelinePlay);
    if (opacityRange) opacityRange.addEventListener('input', e => elninoSetOpacity(+e.target.value));
    if (chkSst) chkSst.addEventListener('change', e => {
        if (e.target.checked) { elninoLoadSST(); }
        else if (ELNINO.sstLayer) { try { map.removeLayer(ELNINO.sstLayer); } catch {} }
    });
    if (chkNino34) chkNino34.addEventListener('change', e => {
        if (e.target.checked) { elninoAddNino34Polygon(); }
        else if (ELNINO.nino34Polygon) { try { map.removeLayer(ELNINO.nino34Polygon); } catch {} }
    });
    if (chkFocos) chkFocos.addEventListener('change', e => {
        if (e.target.checked) { elninoLoadFocos(); }
        else if (ELNINO.focosLayer) { try { map.removeLayer(ELNINO.focosLayer); } catch {} }
    });
    const focosDias = document.getElementById('elninoFocosDias');
    const focosRegiao = document.getElementById('elninoFocosRegiao');
    if (focosDias) focosDias.addEventListener('change', () => { if (document.getElementById('elninoChkFocos')?.checked) elninoLoadFocos(); });
    if (focosRegiao) focosRegiao.addEventListener('change', () => { if (document.getElementById('elninoChkFocos')?.checked) elninoLoadFocos(); });
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
        ELNINO.sstLoaded = false; ELNINO.focosLoaded = false;
        elninoLoadSST();
        elninoLoadFocos();
        elninoLoadNino34Chart();
        elninoLoadInmetAvisos();
    });
}

async function elninoInitMap() {
    if (typeof map === 'undefined' || !map) {
        console.warn('[elnino] mapa Leaflet não encontrado');
        return;
    }
    elninoBindControls();
    await Promise.all([
        elninoLoadSST(),
        elninoLoadNino34Chart(),
        elninoLoadInmetAvisos(),
    ]);
    elninoAddNino34Polygon();
    elninoLoadFocos();
    setInterval(() => { elninoLoadFocos(); }, 3 * 60 * 60 * 1000); // refresh focos a cada 3h
    setInterval(() => { elninoLoadNino34Chart(); }, 6 * 60 * 60 * 1000); // refresh gráfico a cada 6h
}

// Auto-inicializa quando a aba "mapa" for ativada
document.addEventListener('DOMContentLoaded', () => {
    const tabMapa = document.querySelector('.tabs button[data-tab="mapa"]');
    if (tabMapa) {
        tabMapa.addEventListener('click', () => {
            setTimeout(elninoInitMap, 100);
        });
    }
    // Se já estiver na aba mapa (ex.: reload)
    if (document.getElementById('view-mapa')?.classList.contains('active')) {
        setTimeout(elninoInitMap, 100);
    }
});