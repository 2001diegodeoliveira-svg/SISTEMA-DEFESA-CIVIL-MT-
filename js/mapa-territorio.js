/* SGI PROTEGE - Mapa Integrado (2/14): mapa-territorio. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= Território: IBGE ================= */
function ringAreaKm2(ring) {
    const R = 6371; let s = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        s += (x2 - x1) * Math.PI / 180 * (2 + Math.sin(y1 * Math.PI / 180) + Math.sin(y2 * Math.PI / 180));
    }
    return Math.abs(s * R * R / 2);
}
function geomAreaKm2(geom) {
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    let total = 0;
    polys.forEach(p => {
        total += ringAreaKm2(p[0]);
        for (let i = 1; i < p.length; i++) total -= ringAreaKm2(p[i]);
    });
    return total;
}

async function loadTerritorio() {
    try {
        const [estados, malhaEstados] = await Promise.all([
            DC_ORGANIZACAO.obterEstados(),
            DC_ORGANIZACAO.obterMalhaEstados()
        ]);
        if (!estados.length || !malhaEstados.features.length) {
            throw new Error('O IBGE não retornou estados ou malhas territoriais.');
        }

        ibgeStates = estados;
        ibgeLoadedAt = new Date();
        const ufSelect = document.getElementById('territoryUf');
        ufSelect.innerHTML = '<option value="">Brasil</option>' + estados.map(estado =>
            `<option value="${String(estado.id).padStart(2, '0')}">${estado.sigla} — ${estado.nome}</option>`
        ).join('');

        const meta = document.getElementById('metaMt');
        if (meta) meta.textContent =
            '· carregado ' + ibgeLoadedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        mtLayer = L.geoJSON(malhaEstados, {
            style: {
                color: '#f9731c', weight: 3, fill: true,
                fillColor: '#f9731c', fillOpacity: 0.04,
                dashArray: '', opacity: 0.9
            },
            attribution: 'IBGE · Malhas Territoriais',
            onEachFeature: (feature, layer) => {
                const code = String(feature.properties && (feature.properties.codarea ||
                    feature.properties.CD_UF || feature.properties.cd_uf) || '').padStart(2, '0');
                const state = estados.find(item => String(item.id).padStart(2, '0') === code);
                if (!state) return;
                layer.bindTooltip(state.nome, { sticky: true, className: 'mun-tooltip' });
                layer.on('click', () => selecionarUf(code));
            }
        }).addTo(map);

        const initialUf = DC_ORGANIZACAO.obterUfInicial();
        const initialState = estados.find(state =>
            String(state.id).padStart(2, '0') === initialUf ||
            String(state.sigla).toUpperCase() === initialUf
        );
        await selecionarUf(initialState ? String(initialState.id).padStart(2, '0') : '', false);

        DC_ORGANIZACAO.obterTotalMunicipios().then(total => {
            const currentCount = document.getElementById('municipalityLayerLabel');
            if (!selectedUfCode && currentCount) {
                currentCount.textContent = 'Municípios no Brasil (' + total.toLocaleString('pt-BR') + ')';
            }
        }).catch(error => {
            console.error('[territorio] não foi possível contar municípios no catálogo nacional do IBGE:', error);
            atualizarStatusTerritorio('Contagem nacional indisponível; os limites estaduais do IBGE estão carregados.');
        });

        ufSelect.addEventListener('change', () => selecionarUf(ufSelect.value));
        document.getElementById('territoryMunicipio').addEventListener('change', evento => {
            focarMunicipioPorCodigo(evento.target.value);
            if (typeof loadCptec === 'function') loadCptec();
        });
        document.getElementById('territoryStatus').textContent =
            'Fonte: IBGE · malhas territoriais oficiais. Selecione uma UF para carregar seus municípios.';

        if (wmsFocos48hLayer && !map.getPane('wmsPane')) {
            const ativo = checkState.wmsFocos48h;
            map.removeLayer(wmsFocos48hLayer);
            wmsFocos48hLayer = null;
            if (ativo) loadWmsFocos48h();
        }
    } catch (e) {
        console.error('[territorio] falha ao carregar dados oficiais do IBGE:', e);
        atualizarStatusTerritorio('O IBGE está indisponível. Não foi carregado um catálogo territorial estimado; tente novamente mais tarde.');
        toast('Falha ao carregar malha territorial do IBGE.');
        setCheck('mtOutline', false);
        setCheck('municipios', false);
    }
}

function atualizarStatusTerritorio(texto) {
    const status = document.getElementById('territoryStatus');
    if (status) status.textContent = texto;
}

function atualizarContextoOrganizacao(codigoUf) {
    selectedUfCode = codigoUf || '';
    const organizacao = DC_ORGANIZACAO.organizacaoPorUf(selectedUfCode, ibgeStates);
    DC_ORGANIZACAO.aplicarIdentidade(document, organizacao);
    const ufSelect = document.getElementById('territoryUf');
    const scopeLabel = document.getElementById('mapScopeLabel');
    const title = document.querySelector('title');
    if (ufSelect) ufSelect.value = selectedUfCode;
    if (scopeLabel) scopeLabel.textContent = 'MAPA INTEGRADO · ' + (organizacao.uf || 'BRASIL');
    if (title) title.textContent = 'Mapa Integrado — SGI PROTEGE | ' + (organizacao.uf || 'Brasil');
    const stateLayerLabel = document.querySelector('.check-row[data-check="mtOutline"] label');
    if (stateLayerLabel) {
        stateLayerLabel.innerHTML = '<span class="swatch" style="background:#f9631c;"></span><i data-lucide="expand"></i>' +
            (selectedUfCode ? 'Limite de ' + organizacao.nome : 'Unidades da Federação');
        if (window.lucide) lucide.createIcons();
    }
}

function aplicarDisponibilidadeRegional(codigoUf) {
    // Fase 3+: só o que é intrinsecamente MT fica restrito à UF.
    // Camadas nacionais (focos, barragens, ANA, INMET, chuva, WMS,
    // reports, DETER, qualidade do ar) ficam sempre visíveis.
    const somenteMT = new Set(['vigiaMais', 'camsSinfra', 'abrigos', 'sipam']);
    const disponivel = Boolean(codigoUf);
    // Fase 3+: overlays de grade (temp/fire) são nacionais por viewport.
    somenteMT.forEach(key => {
        const row = document.querySelector('.check-row[data-check="' + key + '"]');
        if (row) row.hidden = !disponivel;
        if (!disponivel && checkState[key]) {
            checkState[key] = false;
            const layer = checks[key] && checks[key]();
            if (layer && map.hasLayer(layer)) map.removeLayer(layer);
            if (row) row.querySelector('.toggle').classList.remove('on');
        }
    });
    if (disponivel) {
        ['reports', 'abrigos', 'camsSinfra'].forEach(key => {
            checkState[key] = true;
            const row = document.querySelector('.check-row[data-check="' + key + '"]');
            if (row) row.querySelector('.toggle').classList.add('on');
        });
        if (!reportsLoaded && !reportsLoading) loadReports();
        if (!abrigosLoaded && !abrigosLoading) loadAbrigos();
        if (!camSinfraLoaded && !camSinfraLoading) loadCamerasSinfra();
    } else {
        const activeRegionalOverlay = document.querySelector('.ov-btn.active[data-ov="temp"], .ov-btn.active[data-ov="fire"]');
        if (activeRegionalOverlay) {
            const offButton = document.querySelector('.ov-btn[data-ov="none"]');
            if (offButton) offButton.click();
        }
    }
    applyChecks();
}

async function selecionarUf(codigoUf, atualizarUrl = true) {
    const codigo = String(codigoUf || '').padStart(2, '0');
    const estado = ibgeStates.find(item => String(item.id).padStart(2, '0') === codigo);
    if (codigoUf && !estado) return;

    atualizarContextoOrganizacao(estado ? codigo : '');
    aplicarDisponibilidadeRegional(estado ? codigo : '');
    const cidadeSelect = document.getElementById('territoryMunicipio');
    cidadeSelect.disabled = !estado;
    cidadeSelect.innerHTML = estado
        ? '<option value="">Todos os municípios de ' + estado.sigla + '</option>'
        : '<option value="">Selecione uma UF primeiro</option>';

    if (atualizarUrl && window.history && window.history.replaceState) {
        const url = new URL(window.location.href);
        if (estado) url.searchParams.set('uf', codigo);
        else url.searchParams.delete('uf');
        window.history.replaceState(null, '', url);
    }
    window.dispatchEvent(new Event('dc:organization-scope'));

    if (!estado) {
        ibgeMunicipiosDaUf = [];
        munNomeByCod = {};
        if (munLayer) {
            map.removeLayer(munLayer);
            munLayer = null;
        }
        map.setView(DC_ORGANIZACAO.nacional.mapa.centro, DC_ORGANIZACAO.nacional.mapa.zoom);
        const label = document.getElementById('municipalityLayerLabel');
        if (label) label.textContent = 'Municípios no Brasil';
        atualizarStatusTerritorio('Fonte: IBGE · limites estaduais nacionais. Selecione uma UF para carregar seus municípios.');
        MT_GEOM = [];
        MT_BBOX = null;
        return;
    }

    atualizarStatusTerritorio('Carregando municípios e malha territorial de ' + estado.nome + ' no IBGE...');
    try {
        const [municipios, malhaMunicipal] = await Promise.all([
            DC_ORGANIZACAO.obterMunicipios(codigo),
            DC_ORGANIZACAO.obterMalhaMunicipios(codigo)
        ]);
        ibgeMunicipiosDaUf = municipios;
        munNomeByCod = {};
        municipios.forEach(municipio => { munNomeByCod[String(municipio.id)] = municipio.nome; });
        cidadeSelect.innerHTML = '<option value="">Todos os municípios de ' + estado.sigla + '</option>' +
            municipios.map(municipio => `<option value="${municipio.id}">${municipio.nome}</option>`).join('');

        if (munLayer) map.removeLayer(munLayer);
        munLayer = L.geoJSON(malhaMunicipal, {
            renderer: L.canvas({ padding: 0.2 }),
            smoothFactor: 2, // simplificação (Fase 8); detalhe total volta no zoom
            style: {
                color: '#38bdf8', weight: 0.8, opacity: .45,
                fillColor: '#38bdf8', fillOpacity: .02
            },
            attribution: 'IBGE · Malhas Territoriais',
            onEachFeature: (feature, layer) => {
                const code = String(feature.properties && feature.properties.codarea || '');
                const nome = munNomeByCod[code] || 'Município';
                const centro = layer.getBounds().getCenter();
                centroidByCod[code] = { lat: centro.lat, lng: centro.lng };
                codByNomeNormalizado[normalizarNome(nome)] = code;
                layer.bindTooltip(nome, { permanent: false, direction: 'center', className: 'mun-tooltip' });
                layer.on('mouseover', () => {
                    layer.setStyle({ fillOpacity: .15, weight: 1.8, opacity: .7 });
                    layer.bringToFront();
                });
                layer.on('mouseout', () => munLayer.resetStyle(layer));
                layer.on('click', () => {
                    cidadeSelect.value = code;
                    const bounds = layer.getBounds();
                    const area = geomAreaKm2(feature.geometry);
                    const organizacao = DC_ORGANIZACAO.organizacaoPorUf(codigo, ibgeStates);
                    layer.bindPopup(`
                        <div style="min-width:210px;">
                            <div style="font-weight:700;font-size:13.5px;margin-bottom:2px;">${nome}</div>
                            <div style="color:#94a3b8;font-size:10.5px;margin-bottom:8px;">Código IBGE: ${code}</div>
                            <div style="font-size:11.5px;line-height:1.7;">Área territorial: <b>≈ ${Math.round(area).toLocaleString('pt-BR')} km²</b><br>UF: <b>${organizacao.uf}</b></div>
                            <div style="margin-top:10px;display:flex;gap:8px;">
                                <button onclick="previsaoMun('${code}')" style="flex:1;background:#f9631c;border:none;color:#fff;font-size:11px;font-weight:600;padding:7px;border-radius:6px;cursor:pointer;">
                                    <i data-lucide="cloud-sun"></i> Previsão no ponto
                                </button>
                            </div>
                            <div style="margin-top:9px;padding-top:7px;border-top:1px solid rgba(255,255,255,.08);font-size:9px;color:#94a3b8;line-height:1.5;">
                                Fonte: IBGE · Malhas Territoriais · <a href="https://www.ibge.gov.br/geociencias/organizacao-do-territorio/malhas-territoriais/15774-malhas.html" target="_blank" rel="noopener" style="color:#38bdf8;">portal oficial</a>
                            </div>
                        </div>`).openPopup();
                    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
                });
            }
        });
        if (checkState.municipios) munLayer.addTo(map);

        const stateFeature = (mtLayer.getLayers() || []).find(layer => {
            const props = layer.feature && layer.feature.properties || {};
            return String(props.codarea || props.CD_UF || props.cd_uf || '').padStart(2, '0') === codigo;
        });
        if (stateFeature) {
            const bounds = stateFeature.getBounds();
            map.fitBounds(bounds, { padding: [40, 40] });
            if (codigo === '51') {
                MT_BBOX = bounds;
                const geometry = stateFeature.feature.geometry;
                const rings = geometry.type === 'Polygon' ? [geometry.coordinates] : (geometry.coordinates || []);
                MT_GEOM = rings[0] && rings[0][0] ? rings[0][0].map(point => [point[1], point[0]]) : [];
            } else {
                MT_GEOM = [];
                MT_BBOX = null;
            }
        }
        const label = document.getElementById('municipalityLayerLabel');
        if (label) label.textContent = 'Municípios de ' + estado.sigla + ' (' + municipios.length.toLocaleString('pt-BR') + ')';
        atualizarStatusTerritorio('Fonte: IBGE · ' + municipios.length.toLocaleString('pt-BR') +
            ' municípios de ' + estado.nome + ' · carregado ' +
            new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '.');
        codByNomeNormalizado && (window.lucide && lucide.createIcons());

        if (codigo === '51') {
            focarMunicipioInicial();
            aplicarRestricaoMunicipio();
            buildVigiaMaisLayer(munNomeByCod);
            populateMsnCity();
            if (wmsFocos48hLayer && !map.getPane('wmsPane')) {
                map.removeLayer(wmsFocos48hLayer);
                wmsFocos48hLayer = null;
                if (checkState.wmsFocos48h) loadWmsFocos48h();
            }
        }
        recarregarCamadasUF();
    } catch (error) {
        console.error('[territorio] falha ao carregar municípios da UF:', error);
        if (munLayer) {
            map.removeLayer(munLayer);
            munLayer = null;
        }
        atualizarStatusTerritorio('Não foi possível carregar os municípios no IBGE. A camada municipal permanece indisponível; tente novamente.');
        toast('Falha ao carregar os municípios do IBGE.');
    }
}

/* Fase 3: ao trocar de UF, recarrega as camadas visíveis que dependem
   da UF (focos, INMET, chuva, ANA, SIPAM, barragens, previsão). */
function recarregarCamadasUF() {
    const alvos = [
        ['focos', 'loadFocos', () => { focosLoaded = false; }],
        ['anaHydrology', 'loadAnaHydrology', () => { anaHydrologyLoaded = false; }],
        ['inmetStations', 'loadInmetStations', () => { inmetLoaded = false; }],
        ['chuvaInmet', 'loadChuvaInmet', () => { chuvaInmetLoaded = false; }],
        ['sipam', 'loadSIPAM', () => { sipamLoaded = false; }],
        ['barragens', 'loadBarragens', () => { barragensLoaded = false; }],
    ];
    try {
        alvos.forEach(([check, loader, reset]) => {
            if (!checkState[check]) return;
            try { reset(); } catch (e) {}
            const fn = window[loader];
            if (typeof fn === 'function') {
                try {
                    const r = fn();
                    if (r && typeof r.catch === 'function') r.catch(() => {});
                } catch (e) {}
            }
        });
    } catch (e) {}
    try { if (typeof loadCptec === 'function') loadCptec(); } catch (e) {}
    try { if (typeof loadWmsFocos48hDetalhe === 'function') loadWmsFocos48hDetalhe(); } catch (e) {}
    try {
        if (typeof avisosLayer !== 'undefined' && avisosLayer) {
            avisosLayer.eachLayer(l => { try { avisosLayer.removeLayer(l); } catch (e2) {} });
        }
    } catch (e) {}
}

function focarMunicipioPorCodigo(codigo) {
    if (!codigo || !munLayer) return;
    const layer = (munLayer.getLayers() || []).find(item =>
        String(item.feature && item.feature.properties && item.feature.properties.codarea || '') === String(codigo)
    );
    if (!layer) return;
    map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 10 });
    layer.fire('click');
}

/* Vigia Mais MT (SESP-MT) — programa estadual de videomonitoramento com IA/
   reconhecimento facial, ativo em ~100% dos municípios de MT (Lei 11.766/2022).
   A SESP NÃO publica as coordenadas exatas dos pontos de câmera (informação de
   segurança pública) — não existe API/dado aberto com isso. Este marcador
   representa a ADESÃO do município ao programa (nível municipal, no centroide),
   não a posição real de cada câmera. */
function buildVigiaMaisLayer(nomeByCod) {
    vigiaMaisLayer = L.layerGroup();
    Object.entries(nomeByCod).forEach(([cod, nome]) => {
        const c = centroidByCod[cod];
        if (!c) return;
        L.marker([c.lat, c.lng], { icon: iconDivMarker('cctv', '#7c3aed', 22) }).bindPopup(`
            <div style="min-width:220px;">
                <div style="font-weight:700;font-size:12.5px;margin-bottom:2px;">${nome}</div>
                <div style="color:#94a3b8;font-size:10.5px;margin-bottom:8px;">Programa Vigia Mais MT · SESP-MT</div>
                <div style="font-size:11px;line-height:1.6;">Município aderiu ao videomonitoramento integrado (Lei 11.766/2022).</div>
                <div style="margin-top:9px;padding-top:7px;border-top:1px solid rgba(255,255,255,.08);font-size:9px;color:#94a3b8;line-height:1.5;">
                    A SESP-MT não divulga a localização exata de cada câmera (informação de
                    segurança pública) — marcador no centro do município, não na posição real do equipamento.<br>
                    <a href="https://www.sesp.mt.gov.br/vigia-mais-mt" target="_blank" rel="noopener" style="color:#38bdf8;">Fonte: SESP-MT — Vigia Mais MT</a>
                </div>
            </div>`).addTo(vigiaMaisLayer);
    });
    document.getElementById('metaVigiaMais').textContent = `SESP-MT · ${Object.keys(nomeByCod).length} municípios aderidos (cobertura, não são pontos reais de câmera)`;
    applyChecks();
}

/* Serviços essenciais reais (hospitais, bombeiros, polícia) próximos ao centro do
   município, via Overpass API (OpenStreetMap) — gratuito, sem chave de API. */
function distKm(lat1, lon1, lat2, lon2) {
    const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
async function loadServicosProximos(lat, lon) {
    const el = document.getElementById('mpContatos');
    const query = `[out:json][timeout:15];(node["amenity"="hospital"](around:20000,${lat},${lon});node["amenity"="fire_station"](around:20000,${lat},${lon});node["amenity"="police"](around:20000,${lat},${lon}););out center 15;`;
    try {
        const r = await dcProxyFetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        const rotulo = { hospital: 'Hospital', fire_station: 'Bombeiros', police: 'Polícia' };
        const itens = (data.elements || [])
            .map(e => ({ nome: e.tags?.name || rotulo[e.tags?.amenity] || 'Serviço', tipo: rotulo[e.tags?.amenity] || '—', dist: distKm(lat, lon, e.lat, e.lon) }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, 4);
        if (!itens.length) throw new Error('sem resultados');
        el.innerHTML = 'SGI PROTEGE: 199 · Bombeiros: 193 · SAMU: 192<br>' +
            itens.map(i => `<span style="display:inline-block;margin-top:4px;">${i.tipo}: <b>${i.nome}</b> — ${i.dist.toFixed(1)} km</span>`).join('<br>');
    } catch (e) {
        // Sem cobertura do OSM na região: mantém apenas os números gerais.
    }
}

window.previsaoMun = function (cod) {
    map.closePopup();
    const c = centroidByCod[cod];
    if (!c) return;

    const panel = document.getElementById('munPanel');
    panel.classList.add('open');

    // Reset
    ['mpNome','mpSub','mpPop','mpArea','mpDens','mpUrb','mpIdh','mpIdhR','mpIdhL','mpIdhE','mpPib','mpPibTot','mpMort','mpEscol','mpIdade','mpFogos','mpTemp','mpUmidade','mpVento','mpChuva','mpRisco'].forEach(id => {
        const el = document.getElementById(id); if (el) el.textContent = '…';
    });
    document.getElementById('mpRiskBar').innerHTML = '';
    document.getElementById('mpAtualizado').textContent = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
    document.getElementById('mpContatos').textContent = 'SGI PROTEGE: 199 · Bombeiros: 193 · SAMU: 192';
    loadServicosProximos(c.lat, c.lng);

    // ===== DADOS IBGE =====
    // Nome e localização
    dcProxyFetch(`https://servicodados.ibge.gov.br/api/v1/localidades/municipios/${cod}`)
        .then(r => r.json())
        .then(mun => {
            document.getElementById('mpNome').textContent = mun.nome;
            const meso = mun.microrregiao?.mesorregiao?.nome || '';
            const micro = mun.microrregiao?.nome || '';
            document.getElementById('mpSub').innerHTML = `${micro} · ${meso} · MT<br><span style="font-size:9px;color:#64748b;">Código IBGE: ${mun.id} · Gentílico: ${mun.microrregiao?.mesorregiao?.UF?.nome || 'Mato Grosso'}</span>`;
        })
        .catch(() => { document.getElementById('mpNome').textContent = 'Município ' + cod; });

    // População e área
    dcProxyFetch(`https://servicodados.ibge.gov.br/api/v3/agregados/6579/periodos/2022/variaveis/9324?localidades=N6[${cod}]`)
        .then(r => r.json()).then(d => {
            const v = d[0]?.resultados[0]?.series[0]?.serie?.['2022'];
            if (v) document.getElementById('mpPop').textContent = parseInt(v).toLocaleString('pt-BR');
        }).catch(() => {});

    dcProxyFetch(`https://servicodados.ibge.gov.br/api/v3/agregados/4714/periodos/2022/variaveis/4455?localidades=N6[${cod}]`)
        .then(r => r.json()).then(d => {
            const v = d[0]?.resultados[0]?.series[0]?.serie?.['2022'];
            if (v) document.getElementById('mpArea').textContent = parseFloat(v).toLocaleString('pt-BR', { maximumFractionDigits:1 });
        }).catch(() => {});

    // Densidade demográfica
    dcProxyFetch(`https://servicodados.ibge.gov.br/api/v3/agregados/3706/periodos/2022/variaveis/93?localidades=N6[${cod}]`)
        .then(r => r.json()).then(d => {
            const v = d[0]?.resultados[0]?.series[0]?.serie?.['2022'];
            if (v) document.getElementById('mpDens').textContent = parseFloat(v).toLocaleString('pt-BR', { maximumFractionDigits:1 }) + '/km²';
        }).catch(() => {});

    // IDHM (2010)
    dcProxyFetch(`https://servicodados.ibge.gov.br/api/v3/agregados/30255/periodos/2010/variaveis/30255?localidades=N6[${cod}]`)
        .then(r => r.json()).then(d => {
            const v = d[0]?.resultados[0]?.series[0]?.serie?.['2010'];
            if (v) document.getElementById('mpIdh').textContent = parseFloat(v).toFixed(3);
        }).catch(() => {});
    dcProxyFetch(`https://servicodados.ibge.gov.br/api/v3/agregados/30260/periodos/2010/variaveis/30260?localidades=N6[${cod}]`)
        .then(r => r.json()).then(d => {
            const v = d[0]?.resultados[0]?.series[0]?.serie?.['2010'];
            if (v) document.getElementById('mpIdhL').textContent = parseFloat(v).toFixed(3);
        }).catch(() => {});
    dcProxyFetch(`https://servicodados.ibge.gov.br/api/v3/agregados/30266/periodos/2010/variaveis/30266?localidades=N6[${cod}]`)
        .then(r => r.json()).then(d => {
            const v = d[0]?.resultados[0]?.series[0]?.serie?.['2010'];
            if (v) document.getElementById('mpIdhE').textContent = parseFloat(v).toFixed(3);
        }).catch(() => {});
    dcProxyFetch(`https://servicodados.ibge.gov.br/api/v3/agregados/30272/periodos/2010/variaveis/30272?localidades=N6[${cod}]`)
        .then(r => r.json()).then(d => {
            const v = d[0]?.resultados[0]?.series[0]?.serie?.['2010'];
            if (v) document.getElementById('mpIdhR').textContent = parseFloat(v).toFixed(3);
        }).catch(() => {});

    // PIB per capita (2021)
    dcProxyFetch(`https://servicodados.ibge.gov.br/api/v3/agregados/4700/periodos/2021/variaveis/3706?localidades=N6[${cod}]`)
        .then(r => r.json()).then(d => {
            const v = d[0]?.resultados[0]?.series[0]?.serie?.['2021'];
            if (v) document.getElementById('mpPib').textContent = 'R$ ' + parseFloat(v).toLocaleString('pt-BR', { maximumFractionDigits:2 });
        }).catch(() => {});
    dcProxyFetch(`https://servicodados.ibge.gov.br/api/v3/agregados/4700/periodos/2021/variaveis/3713?localidades=N6[${cod}]`)
        .then(r => r.json()).then(d => {
            const v = d[0]?.resultados[0]?.series[0]?.serie?.['2021'];
            if (v) document.getElementById('mpPibTot').textContent = 'R$ ' + (parseFloat(v) / 1e6).toFixed(1) + ' mi';
        }).catch(() => {});

    // Mortalidade infantil
    dcProxyFetch(`https://servicodados.ibge.gov.br/api/v3/agregados/4561/periodos/2022/variaveis/20712?localidades=N6[${cod}]`)
        .then(r => r.json()).then(d => {
            const v = d[0]?.resultados[0]?.series[0]?.serie?.['2022'];
            if (v) document.getElementById('mpMort').textContent = parseFloat(v).toFixed(1) + '‰';
        }).catch(() => {});

    // ===== FOCOS INPE =====
    if (focosLoaded && focosLayer) {
        const R = 0.45;
        let count = 0;
        focosLayer.eachLayer(l => {
            const ll = l.getLatLng();
            if (Math.abs(ll.lat - c.lat) < R && Math.abs(ll.lng - c.lng) < R) count++;
        });
        document.getElementById('mpFogos').textContent = count;
        document.getElementById('mpFogos').style.color = count > 10 ? '#ef4444' : count > 3 ? '#f9631c' : '#34d399';
    }

    // ===== CLIMA OPEN-METEO =====
    dcProxyFetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat.toFixed(4)}&longitude=${c.lng.toFixed(4)}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation&daily=precipitation_sum&timezone=America/Cuiaba&past_days=1&forecast_days=0`)
        .then(r => r.json())
        .then(d => {
            const cur = d.current;
            document.getElementById('mpTemp').textContent = Math.round(cur.temperature_2m) + '°C';
            document.getElementById('mpUmidade').textContent = cur.relative_humidity_2m + '%';
            document.getElementById('mpVento').textContent = Math.round(cur.wind_speed_10m) + ' km/h';
            const chuva = d.daily?.precipitation_sum?.[1] ?? d.daily?.precipitation_sum?.[0] ?? 0;
            document.getElementById('mpChuva').textContent = chuva.toFixed(1) + ' mm';

            // Cálculo de risco
            const hum = cur.relative_humidity_2m;
            const wind = cur.wind_speed_10m;
            const fogos = parseInt(document.getElementById('mpFogos').textContent) || 0;
            let risco = 0;
            if (hum < 20) risco += 35; else if (hum < 30) risco += 25; else if (hum < 50) risco += 12;
            if (wind > 30) risco += 30; else if (wind > 20) risco += 20; else if (wind > 10) risco += 8;
            risco += Math.min(40, fogos * 3);
            if (chuva > 5) risco = Math.max(0, risco - 20);
            risco = Math.min(100, risco);

            let riscoTxt = 'Baixo', riscoCor = '#34d399';
            if (risco > 70) { riscoTxt = 'Crítico'; riscoCor = '#ef4444'; }
            else if (risco > 50) { riscoTxt = 'Alto'; riscoCor = '#f9631c'; }
            else if (risco > 30) { riscoTxt = 'Moderado'; riscoCor = '#fbbf24'; }

            document.getElementById('mpRisco').textContent = riscoTxt;
            document.getElementById('mpRisco').style.color = riscoCor;
            document.getElementById('mpRiskBar').innerHTML = `<div class="fill" style="width:${risco}%;background:${riscoCor};"></div>`;
            document.getElementById('mpFontes').textContent = 'IBGE · INPE · Open-Meteo · OpenStreetMap';
        })
        .catch(() => {});
};

/* Foca (centraliza + abre o painel de detalhes) num município específico.
   Aceita código IBGE ou nome (com/sem acento). */
let focarMunicipioFeito = false;
function focarMunicipio(alvo) {
    if (!alvo) return false;
    const alvoStr = String(alvo);
    const cod = /^\d+$/.test(alvoStr) && centroidByCod[alvoStr] ? alvoStr : codByNomeNormalizado[normalizarNome(alvoStr)];
    if (!cod || !centroidByCod[cod]) { toast('Município não encontrado: ' + alvoStr); return false; }
    const c = centroidByCod[cod];
    map.flyTo([c.lat, c.lng], 10, { duration: 1 });
    setTimeout(() => window.previsaoMun(cod), 900);
    return true;
}

/* Ao abrir o mapa: foca automaticamente no município do usuário logado
   (perfil "gestor municipal") ou no informado via ?municipio= na URL —
   assim o sistema já entra "no contexto" de cada município, sem precisar
   procurar manualmente toda vez. */
function focarMunicipioInicial() {
    if (focarMunicipioFeito) return;
    const porUrl = new URLSearchParams(location.search).get('municipio');
    if (porUrl) { focarMunicipioFeito = focarMunicipio(porUrl); return; }
    try {
        const sessao = JSON.parse(localStorage.getItem('dcmt_session') || 'null');
        if (sessao && sessao.perfil === 'municipal' && sessao.municipio) {
            focarMunicipioFeito = focarMunicipio(sessao.municipio);
        }
    } catch (e) {}
}

