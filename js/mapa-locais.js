/* SGI PROTEGE - Mapa Integrado (6/14): mapa-locais. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= Abrigos temporários =================
   Sem cadastro oficial publicado em API, não exibimos lista fixa
   no front (dados estáticos sem fonte verificável). A camada
   permanece desativada até existir fonte oficial.        */
async function loadAbrigos() {
    const meta = document.getElementById('metaAbrigos');
    if (abrigosLayer) { try { map.removeLayer(abrigosLayer); } catch (e) {} abrigosLayer = null; }
    abrigosLoaded = true;
    abrigosLoading = false;
    if (meta) meta.textContent = 'Abrigos · sem cadastro oficial em API — camada indisponível';
    if (typeof refreshLegend === 'function') refreshLegend();
}

/* ================= Monitoramento por câmera — SINFRA Obras ao Vivo =================
   Fonte: ArcGIS FeatureServer do portal SINFRA-MT (mapas.sinfra.mt.gov.br), camada
   "Vídeo Monitoramento Obras". Cada câmera aponta para uma página web em
   obrasaovivo.sinfra.mt.gov.br que reproduz o stream HLS ((streams/<slug>/index.m3u8).
   Snapshot de contingência local: js/cameras_sinfra.json (mesmo formato).        */
function cameraSlug(link) {
    if (!link) return '';
    try { const u = new URL(link); return u.pathname.split('/').pop().replace(/\.html?$/i, ''); }
    catch { return ''; }
}
function cameraStatusBase(slug) { return CAMERA_BASE + '/streams/' + slug + '/index.m3u8'; }
async function probeCamerasStatus(data) {
    await Promise.allSettled(data.map(async cam => {
        try {
            const r = await dcProxyFetch(cameraStatusBase(cam.slug));
            cam.online = !!r.ok;
        } catch (e) { cam.online = false; }
    }));
}
function camStatusBadge(on) {
    return on
        ? '<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:10px;font-weight:700;background:rgba(52,211,153,.14);border:1px solid rgba(52,211,153,.45);color:#34d399;"><span style="width:7px;height:7px;border-radius:50%;background:#34d399;animation:damPulse 1.6s infinite;"></span> AO VIVO</span>'
        : '<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:10px;font-weight:700;background:rgba(148,163,184,.14);border:1px solid rgba(148,163,184,.4);color:#94a3b8;">OFFLINE</span>';
}
function cameraPopupHTML(cam) {
    const endereco = [cam.endereco, cam.municipio].filter(Boolean).join(' · ') || '—';
    const titulo = cam.localizacao || cam.slug || 'Câmera';
    // Fase 9 (mixed content): stream http:// em página https:// é bloqueado
    // pelo navegador — nesse caso mostra fallback com link externo.
    const inseguro = /^http:\/\//i.test(cam.link || '') && location.protocol === 'https:';
    const videoHtml = inseguro
        ? `<div style="padding:14px 12px;font-size:11px;color:#94a3b8;line-height:1.6;">Stream em HTTP puro — o navegador bloqueia a incorporação em página HTTPS. <a href="${cam.link}" target="_blank" rel="noopener" style="color:#38bdf8;">Abrir monitor em nova aba</a></div>`
        : `<iframe src="${cam.link}" title="${titulo}" style="display:block;width:430px;height:300px;border:0;background:transparent;" allow="autoplay; encrypted-media; fullscreen" loading="lazy"></iframe>`;
    return `
        <div style="min-width:300px;width:450px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px;">
                <div style="font-weight:700;font-size:13px;display:flex;align-items:center;gap:6px;"><i data-lucide="camera" style="color:#38bdf8;"></i>${titulo}</div>
                ${camStatusBadge(cam.online === true)}
            </div>
            <div style="color:#94a3b8;font-size:10px;margin-bottom:8px;">${cam.obra ? 'Obra: ' + cam.obra : 'SINFRA-MT'}${cam.municipio ? ' · ' + cam.municipio : ''}</div>
            <div style="position:relative;border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,.09);background:#000;box-shadow:0 6px 24px rgba(0,0,0,.35);">
                ${videoHtml}
                <div style="position:absolute;left:0;bottom:0;right:0;padding:4px 9px;font-size:9px;color:rgba(255,255,255,.7);background:linear-gradient(transparent, rgba(0,0,0,.6));">SINFRA-MT · obrasaovivo.sinfra.mt.gov.br</div>
            </div>
            <div style="font-size:10.5px;line-height:1.7;margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;">
                <div><b>Local:</b> ${cam.localizacao || '—'}</div>
                <div><b>Município:</b> ${cam.municipio || '—'}</div>
                <div style="grid-column:1/-1;"><b>Endereço:</b> ${endereco}</div>
                <div><b>Placa/Ref.:</b> ${cam.slug || '—'}</div>
                <div><b>Código:</b> ${cam.codigo || '—'}</div>
            </div>
            <div style="margin-top:7px;display:flex;gap:6px;">
                <a href="${cam.link}" target="_blank" rel="noopener" style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:7px 10px;background:linear-gradient(135deg,#33ccff,#0099ff);color:#fff;font-size:11px;font-weight:700;border-radius:8px;text-decoration:none;" onmouseover="this.style.transform='scale(1.03)';this.style.boxShadow='0 4px 16px rgba(0,153,255,.4)';" onmouseout="this.style.transform='';this.style.boxShadow='';"><i data-lucide="monitor-play"></i> Abrir monitor</a>
                ${reportMarkerBtn(cam.lat, cam.lng)}
            </div>
        </div>`;
}
async function fetchCamerasSinfraApi() {
    const url = 'https://mapas.sinfra.mt.gov.br/server/rest/services/monitoramento_cameras/FeatureServer/0/query?where=1%3D1&outFields=codigo,n_placa,tipoobra,municipio,endereco,localizacao,latitude,longitude,linkvideomonitoramento&returnGeometry=false&orderByFields=n_placa&f=pjson';
    const r = await dcProxyFetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !Array.isArray(j.features)) throw new Error('resposta sem features');
    return j.features.map(f => {
        const a = f.attributes || {};
        return {
            id: a.objectid, codigo: a.codigo, placa: a.n_placa,
            obra: String(a.tipoobra || '').trim(), municipio: String(a.municipio || '').trim(),
            endereco: String(a.endereco || '').trim(), localizacao: String(a.localizacao || '').trim(),
            lat: Number(a.latitude), lng: Number(a.longitude),
            link: String(a.linkvideomonitoramento || '').trim() || null
        };
    }).filter(c => isFinite(c.lat) && isFinite(c.lng) && c.link && c.link !== 'null');
}
async function loadCamerasSinfra() {
    if (camSinfraLoading) return;
    camSinfraLoading = true;
    const meta = document.getElementById('metaCamsSinfra');
    if (meta && !camSinfraLoaded) meta.innerHTML = 'SINFRA MT · <b>carregando câmeras...</b>';
    try {
        let data = null;
        try { data = await fetchCamerasSinfraApi(); } catch (e) { data = null; }
        if (!data || !data.length) {
            const res = await fetch('js/cameras_sinfra.json');
            data = await res.json();
        }
        data = data.map(c => ({ ...c, slug: cameraSlug(c.link) }))
            .filter(c => c.slug && isFinite(Number(c.lat)) && isFinite(Number(c.lng)) &&
                registroNoEscopo(c.municipio, c.lat, c.lng));
        camSinfraData = data;
        await probeCamerasStatus(data);
        if (!camSinfraLayer) camSinfraLayer = L.layerGroup();
        camSinfraLayer.clearLayers();
        data.forEach(cam => {
            const cor = cam.online === true ? '#38bdf8' : '#64748b';
            L.marker([cam.lat, cam.lng], {
                icon: iconDivMarker('camera', cor, 26),
                title: (cam.localizacao || cam.slug) + ' — ' + cam.municipio,
                riseOnHover: true
            }).bindPopup(cameraPopupHTML(cam), { maxWidth: 520 }).addTo(camSinfraLayer);
        });
        if (checkState.camsSinfra) camSinfraLayer.addTo(map);
        camSinfraLoaded = true;
        camSinfraLoading = false;
        const live = data.filter(c => c.online).length;
        if (meta) meta.innerHTML = `SINFRA MT · <b>${data.length.toLocaleString('pt-BR')}</b> câmeras${selectedMunCod ? ' em ' + selectedMunNome : ''} · <b style="color:#34d399;">${live} ao vivo</b> · <b style="color:#94a3b8;">${data.length - live} offline</b>`;
        if (window.lucide) lucide.createIcons();
        refreshLegend();
    } catch (e) {
        camSinfraLoading = false;
        if (meta) meta.textContent = 'Câmeras SINFRA · erro ao carregar';
    }
    clearTimeout(camSinfraTimer);
    camSinfraTimer = setTimeout(loadCamerasSinfra, 5 * 60 * 1000);
}

