/* SGI PROTEGE - Mapa Integrado (5/14): mapa-hidro. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= Barragens SNISB (ANA) ================= */
const RISCO_COR = { 'Alto': '#ef4444', 'Médio': '#f97316', 'M\u00e9dio': '#f97316', 'Baixo': '#3b82f6', 'Não Classificado': '#6b7280', 'Não se Aplica': '#6b7280' };
const RISCO_RAIO = { 'Alto': 7, 'Médio': 5.5, 'M\u00e9dio': 5.5, 'Baixo': 4.5 };

// Ícone de barragem: pin circular com o símbolo de represa, cor do risco;
// barragens de risco alto ganham tamanho maior e pulso de alerta.
function barragemIcon(risco) {
    const cor = RISCO_COR[risco] || '#6b7280';
    if (risco === 'Alto') {
        return L.divIcon({
            className: '',
            html: `<div class="dam-alto" style="width:30px;height:30px;border-radius:50%;background:${cor};border:2px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px ${cor}99;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${MARKER_SVG.dam}</svg></div>`,
            iconSize: [30, 30], iconAnchor: [15, 15]
        });
    }
    return iconDivMarker('dam', cor, risco === 'Médio' ? 26 : 24);
}

function barragemNum(v) {
    const n = parseFloat(v);
    if (!isFinite(n)) return '—';
    return n.toLocaleString('pt-BR', { maximumFractionDigits: n < 1 ? 3 : 1 });
}

function barragemPopupHTML(b) {
    const corRisco = RISCO_COR[b.risco] || '#6b7280';
    const corDano = RISCO_COR[b.dano] || (b.dano === 'Alto' ? '#ef4444' : b.dano === 'Médio' ? '#f97316' : '#38bdf8');
    const uso = b.uso ? b.uso.charAt(0).toUpperCase() + b.uso.slice(1) : '—';
    return `
        <div style="min-width:230px;max-width:270px;">
            <div style="display:flex;align-items:center;gap:6px;font-weight:700;font-size:12.5px;line-height:1.35;color:#fff;margin-bottom:3px;">
                <i data-lucide="waves" style="color:${corRisco};flex-shrink:0;"></i> ${b.nome}
            </div>
            <div style="color:#94a3b8;font-size:10.5px;margin-bottom:8px;">${b.mun} · MT</div>
            <div style="display:flex;gap:5px;margin-bottom:8px;">
                <span class="bar-badge" style="background:${corRisco}22;border:1px solid ${corRisco};color:${corRisco};">Risco: <b>${b.risco}</b></span>
                ${b.dano ? `<span class="bar-badge" style="background:${corDano}22;border:1px solid ${corDano};color:${corDano};">DPA: <b>${b.dano}</b></span>` : ''}
            </div>
            <div class="bar-grid">
                <div><i data-lucide="hash"></i><span>ID SNISB</span><b>${b.id}</b></div>
                <div><i data-lucide="map-pin"></i><span>Município</span><b>${b.mun}</b></div>
                <div><i data-lucide="zap"></i><span>Uso principal</span><b>${uso}</b></div>
                <div><i data-lucide="ruler"></i><span>Altura</span><b>${barragemNum(b.ht)} m</b></div>
                <div><i data-lucide="droplets"></i><span>Capacidade</span><b>${barragemNum(b.cap)} hm³</b></div>
                <div><i data-lucide="refresh-cw"></i><span>Fase</span><b>${b.fase || '—'}</b></div>
            </div>
            <div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);font-size:9px;color:#94a3b8;line-height:1.5;">
                Fonte: ANA · SNISB (Cadastro Nacional de Barragens)
            </div>
            <div style="display:flex;gap:6px;margin-top:8px;">
                <a href="https://www.snisb.gov.br/" target="_blank" rel="noopener" class="bar-act" style="background:rgba(22,78,99,.45);border:1px solid #38bdf8;color:#7dd3fc;">
                    <i data-lucide="database" style="width:11px;height:11px;"></i> SNISB
                </a>
                <a href="https://www.waze.com/ul?ll=${b.lat},${b.lon}&navigate=yes&zoom=16" target="_blank" rel="noopener" class="bar-act" style="background:linear-gradient(135deg,#33ccff,#0099ff);color:#fff;">
                    <i data-lucide="navigation" style="width:11px;height:11px;"></i> Rota (Waze)
                </a>
            </div>
        </div>`;
}

async function loadBarragens() {
    barragensLoading = true;
    const meta = document.getElementById('metaBarragens');
    meta.innerHTML = 'ANA/SNISB · <b>carregando...</b>';
    try {
        // Fase 3: SNISB nacional via /api/barragens (substitui o snapshot js/barragens_mt.json).
        const siglaUF = ufSiglaCorrente() || 'BR';
        const res = await fetch(apiUrl('/api/barragens?uf=' + siglaUF + '&limit=2000'));
        const j = await res.json();
        if (!res.ok) throw new Error((j && j.erro) || ('HTTP ' + res.status));
        const data = Array.isArray(j.barragens) ? j.barragens : [];
        barragensLayer = L.layerGroup();
        data.forEach(b => {
            if (!isFinite(b.lat) || !isFinite(b.lon)) return;
            L.marker([b.lat, b.lon], {
                icon: barragemIcon(b.risco),
                title: b.nome,
                riseOnHover: true
            }).bindPopup(barragemPopupHTML(b)).addTo(barragensLayer);
        });
        barragensLayer.addTo(map);
        barragensLoaded = true;
        barragensLoading = false;
        meta.innerHTML = `ANA/SNISB · <b>${data.length.toLocaleString('pt-BR')}</b> em ${(siglaUF || j.uf || "BR")}${j.parcial ? ' (parcial — refine a busca)' : ''} · ${j.atualizadoEm ? 'atualizado ' + new Date(j.atualizadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'dados na barragem'}`;
        if (window.lucide) lucide.createIcons();
        refreshLegend();
    } catch (e) {
        barragensLoading = false;
        meta.textContent = 'Erro ao carregar barragens';
    }
}

/* ================= Cadastro hidrométrico da ANA ================= */
function escapeAnaHtml(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

async function loadAnaHydrology() {
    anaHydrologyLoading = true;
    const meta = document.getElementById('metaAnaHydrology');
    const siglaUF = ufSiglaCorrente() || 'BR';
    if (meta) meta.textContent = `ANA/Telemetria · consultando estações de ${siglaUF}...`;
    try {
        if (!window.dcApi || typeof window.dcApi.anaHidrologia !== 'function') {
            throw new Error('Cliente da API indisponível.');
        }
        const response = await window.dcApi.anaHidrologia(false, siglaUF);
        if (!response || !response.ok) {
            throw new Error(response && response.data && response.data.erro
                ? response.data.erro
                : 'Serviço da ANA indisponível.');
        }
        const stations = response.data && Array.isArray(response.data.estacoes)
            ? response.data.estacoes
            : [];
        anaHydrologyLayer = L.layerGroup();
        stations.forEach(station => {
            const lat = Number(station.latitude), lon = Number(station.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            const name = escapeAnaHtml(station.nome || 'Estação sem nome');
            const river = escapeAnaHtml(station.rio || 'Não informado');
            const municipality = escapeAnaHtml(station.municipio || 'Não informado');
            const code = escapeAnaHtml(station.codigo || '—');
            const popup = `
                <div style="min-width:205px;font-size:11px;line-height:1.7;">
                    <div style="font-weight:700;color:#0f766e;font-size:12px;margin-bottom:4px;">${name}</div>
                    <div><b>Rio:</b> ${river}</div>
                    <div><b>Município:</b> ${municipality} · ${siglaUF}</div>
                    <div><b>Código ANA:</b> ${code}</div>
                    <div style="margin-top:6px;color:#64748b;font-size:10px;">Cadastro de estação telemétrica. O serviço de catálogo não informa nível medido.</div>
                </div>`;
            L.circleMarker([lat, lon], {
                radius: 5,
                color: '#e6fffb',
                weight: 1.5,
                fillColor: '#2dd4bf',
                fillOpacity: .9,
                title: station.nome || station.codigo,
            }).bindPopup(popup).addTo(anaHydrologyLayer);
        });
        if (checkState.anaHydrology) anaHydrologyLayer.addTo(map);
        anaHydrologyLoaded = true;
        if (meta) meta.innerHTML = `ANA/Telemetria · <b>${stations.length.toLocaleString('pt-BR')}</b> estações ativas em ${(siglaUF || "BR")} · cadastro`;
        refreshLegend();
    } catch (error) {
        if (meta) meta.textContent = `ANA/Telemetria · ${error.message || 'falha ao carregar estações'}`;
    } finally {
        anaHydrologyLoading = false;
    }
}

