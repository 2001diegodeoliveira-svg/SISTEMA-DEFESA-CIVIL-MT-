/* SGI PROTEGE - Mapa Integrado (8/14): mapa-riscos. Script classico (sem modulos ES): depende da ordem dos <script> em mapa.html; compartilha o escopo global. Extraido do inline original. */
/* ================= MSN Clima — Previsão 10 dias (Foreca) =================
   A API é consumida publicamente pelo portal MSN (assets.msn.com/service/weather/overview)
   com a chave pública JS embutida na página do MSN. Dados: Foreca (previsão),
   INMET (alertas). Não é oficial — exibido como apoio, seguindo o padrão dos
   demais painéis do mapa. */
const MSN_KEYS = {
    apiKey: 'j5i4gDqHL6nGYwx5wi5kRhXjtf2c5qgFX9fzfk0TOo',
    appId: '9e21380c-ff19-4c78-b4ea-19558e93a5d3',
    user: 'm-208331813CAF66850D3D264E3D9F67AB'
};
let msnLoading = false;
const MSN_WX_ICON = {
    1:'sun',2:'sun',3:'sun',4:'cloud-sun',5:'cloud-sun',6:'cloud-sun',7:'cloud',8:'cloud',
    11:'cloud',12:'cloud-rain',13:'cloud-rain',14:'cloud-rain',15:'cloud-rain',16:'cloud-lightning',
    17:'cloud-lightning',18:'cloud-lightning',19:'cloud-rain',20:'cloud-rain',21:'cloud-rain',
    22:'cloud-rain',23:'snowflake',24:'snowflake',25:'snowflake',26:'cloud',29:'moon',30:'moon',
    31:'moon',32:'moon',33:'moon',34:'moon',35:'cloud-moon',36:'cloud-moon',37:'cloud-moon',
    38:'cloud-moon',39:'cloud-moon',40:'cloud-moon',41:'cloud-fog',42:'cloud-fog',43:'cloud-fog',
    44:'cloud-fog',45:'cloud-fog',46:'cloud-fog',47:'cloud-fog',48:'cloud-fog'
};
function msnWxIcon(code) { return MSN_WX_ICON[code] || 'cloud-sun'; }

function buildMsnOverviewUrl(lat, lon) {
    const p = new URLSearchParams({
        apiKey: MSN_KEYS.apiKey,
        appId: MSN_KEYS.appId,
        activityId: '6aa1980e-7864-406b-a40f-4e2fdf5a17b9',
        ocid: 'msftweather',
        cm: 'pt-br',
        it: 'edgeid',
        user: MSN_KEYS.user,
        scn: 'APP_ANON',
        units: 'C',
        wrapodata: 'false',
        startDate: '-1',
        endDate: '%2B9',
        discardFutureInsightTimeseries: 'true',
        distanceinkm: '0',
        regionDataCount: '20',
        orderby: 'distance',
        days: '10',
        pageOcid: 'prime-weather::weathertoday-peregrine',
        source: 'weather_csr',
        region: 'br',
        market: 'pt-br',
        locale: 'pt-br',
        lat: String(lat),
        lon: String(lon)
    });
    return 'https://assets.msn.com/service/weather/overview?' + p.toString();
}

function populateMsnCity() {
    const sel = document.getElementById('msnCity');
    const cur = sel.value;
    const src = Object.keys(munNomeByCod).length ? munNomeByCod
        : Object.fromEntries(Object.keys(centroidByCod).map(c => [c, 'Município ' + c]));
    sel.innerHTML = '';
    const list = Object.entries(src)
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([cod, nome]) => `<option value="${cod}">${nome}</option>`).join('');
    sel.innerHTML = `<option value="">Selecione o munic&iacute;pio...</option>` + list;
    if (cur) sel.value = cur;
}

async function loadMsnOverview(cod) {
    if (msnLoading) return;
    const c = centroidByCod[cod];
    if (!c) { toast('Município sem coordenadas carregadas (IBGE).'); return; }
    const nome = munNomeByCod[cod] || ('Município ' + cod);
    const empty = document.getElementById('msnEmpty');
    const content = document.getElementById('msnContent');
    const btn = document.getElementById('msnRefresh');
    msnLoading = true;
    btn.disabled = true;
    empty.style.display = 'block';
    empty.textContent = 'Carregando previsão MSN (Foreca) para ' + nome + '...';
    content.style.display = 'none';
    try {
        const res = await dcProxyFetch(buildMsnOverviewUrl(c.lat.toFixed(4), c.lng.toFixed(4)));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const w = data?.responses?.[0]?.weather?.[0];
        if (!w) throw new Error('Resposta vazia');
        renderMsnOverview(w, nome);
        empty.style.display = 'none';
        content.style.display = 'block';
    } catch (e) {
        empty.textContent = 'Não foi possível carregar a previsão MSN para ' + nome + '.';
    } finally {
        msnLoading = false;
        btn.disabled = false;
        if (window.lucide) lucide.createIcons();
    }
}

function renderMsnOverview(w, nome) {
    const cur = w.current || {};
    const src = w.source || {};
    const loc = src.location || {};
    const upd = cur.created || new Date().toISOString();
    const alerts = Array.isArray(w.alerts) ? w.alerts : [];
    const days = w.forecast?.days || [];
    const cell = (label, v, svg, cls = 'blue') => `<span class="msn-cell"><div class="mv ${cls}"><i data-lucide="${svg}" style="font-size:12px;opacity:.8;margin-right:3px;"></i>${v}</div><div class="ml">${label}</div></span>`;
    const alertsHtml = alerts.length ? alerts.map(a => `
        <div class="msn-alert">
            <div class="msn-alert-icon"><i data-lucide="triangle-alert"></i></div>
            <div style="flex:1;">
                <div class="msn-alert-title">${a.title}</div>
                <div class="msn-alert-meta">
                    ${a.credit ? '<b>' + a.credit + '</b>' : ''}
                    ${a.severity ? ' · ' + a.severity : ''}
                    ${a.statusText ? ' · ' + a.statusText : ''}
                    ${a.start ? '<br>Início: ' + new Date(a.start).toLocaleString('pt-BR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : ''}
                    ${a.end ? ' · Fim: ' + new Date(a.end).toLocaleString('pt-BR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : ''}
                    ${a.safetyGuide ? '<br>' + a.safetyGuide : ''}
                </div>
            </div>
        </div>`).join('') : '<div style="color:#4ade80;font-size:11px;padding:4px 2px;"><i data-lucide="shield-check" style="font-size:11px;margin-right:4px;"></i>Nenhum alerta meteorológico ativo.</div>';

    const timeOpts = { hour: '2-digit', minute: '2-digit', timeZone: loc.TimezoneName || 'America/Cuiaba' };
    const almanac = days[0]?.almanac;
    const sunStr = almanac ? `Nascer ${new Date(almanac.sunrise).toLocaleTimeString('pt-BR', timeOpts)} · Pôr ${new Date(almanac.sunset).toLocaleTimeString('pt-BR', timeOpts)}` : '';

    const daysHtml = days.map((d, i) => {
        const da = d.daily || {};
        const dayCap = da.day?.cap || da.pvdrCap || '—';
        const iday = msnWxIcon(da.icon);
        const label = i === 0 ? 'Hoje' : new Date(d.almanac?.valid || da.valid || Date.now()).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
        const rain = (da.rainAmount ?? 0).toFixed(1).replace('.', ',').replace(',0', '');
        const wind = da.windMax ?? da.windTh ?? 0;
        const hi = da.tempHi != null ? Math.round(da.tempHi) : '—';
        const lo = da.tempLo != null ? Math.round(da.tempLo) : '—';
        return `<div class="msn-day">
            <span class="md-day" style="${i === 0 ? 'color:#fbbf24;' : ''}">${label}</span>
            <span class="md-desc"><i data-lucide="${iday}" style="font-size:13px;"></i>${dayCap}</span>
            <span class="md-temp">${hi}° / ${lo}°</span>
            <span class="md-rain"><i data-lucide="cloud-rain" style="font-size:10px;"></i> ${rain} mm</span>
            <span class="md-wind"><i data-lucide="wind" style="font-size:10px;"></i> ${Math.round(wind)}</span>
        </div>`;
    }).join('');

    document.getElementById('msnContent').innerHTML = `
        <div class="msn-now">
            <div class="msn-temp">${Math.round(cur.temp ?? cur.feels ?? 0)}<sup>°C</sup></div>
            <div class="msn-wx">
                <div class="msn-cap"><i data-lucide="${msnWxIcon(cur.icon)}" style="font-size:15px;margin-right:5px;"></i>${cur.cap || cur.capAbbr || '—'}</div>
                <div class="msn-feels">Sensação ${Math.round(cur.feels ?? cur.temp ?? 0)}°C · ${loc.Name || nome}, MT</div>
                ${sunStr ? `<div class="msn-feels">${sunStr}</div>` : ''}
            </div>
            <div class="msn-upd">Atualizado<br>${new Date(upd).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <div class="msn-grid">
            ${cell('Temperatura', cur.temp != null ? Math.round(cur.temp) + '°' : '—', 'thermometer', 'red')}
            ${cell('Sensação', cur.feels != null ? Math.round(cur.feels) + '°' : '—', 'gauge', 'amber')}
            ${cell('Umidade', cur.rh != null ? Math.round(cur.rh) + '%' : '—', 'droplet', 'blue')}
            ${cell('Vento', cur.windSpd != null ? Math.round(cur.windSpd) + ' km/h' : '—', 'wind', 'green')}
            ${cell('Rajada', cur.windGust != null ? Math.round(cur.windGust) + ' km/h' : '—', 'wind', 'blue')}
            ${cell('UV', cur.uv != null ? cur.uv + (cur.uvDesc ? ' · ' + cur.uvDesc : '') : '—', 'sun', 'amber')}
            ${cell('Nuvens', cur.cloudCover != null ? cur.cloudCover + '%' : '—', 'cloud', 'blue')}
            ${cell('Pressão', cur.baro != null ? cur.baro + ' hPa' : '—', 'bar-chart-3', 'green')}
        </div>
        ${alerts.length ? `<div class="msn-section"><i data-lucide="triangle-alert"></i> Alertas climatológicos</div>${alertsHtml}` : ''}
        <div class="msn-section"><i data-lucide="calendar-days"></i> Previsão 10 dias (Foreca)</div>
        <div class="msn-days">${daysHtml}</div>
        <div style="margin-top:8px;font-size:9px;color:var(--text-muted);">
            Fonte do provedor: <b>${w.provider?.name || 'Foreca'}</b> · MSN Clima · Ponto ${Math.round((src.coordinates?.lat || 0) * 100) / 100}, ${Math.round((src.coordinates?.lon || 0) * 100) / 100}
        </div>`;
}

document.getElementById('msnClose')?.addEventListener('click', () => {
    document.getElementById('msnPanel').classList.add('hidden-panel');
});
document.getElementById('msnToggle')?.addEventListener('click', () => {
    const p = document.getElementById('msnPanel');
    const opening = p.classList.contains('hidden-panel');
    p.classList.toggle('hidden-panel', !opening);
    if (opening) {
        const sel = document.getElementById('msnCity');
        if (!sel.options.length) populateMsnCity();
        if (!sel.value) sel.value = msnCityDefault();
        const cod = sel.value;
        if (cod && !msnLoading) loadMsnOverview(cod);
    }
});
document.getElementById('msnHead')?.addEventListener('click', (e) => {
    if (e.target.closest('.ph-close')) return;
    document.getElementById('msnPanel').classList.toggle('collapsed');
});
document.getElementById('msnCity')?.addEventListener('change', () => {
    const cod = document.getElementById('msnCity').value;
    if (cod) loadMsnOverview(cod);
});
document.getElementById('msnRefresh')?.addEventListener('click', () => {
    const cod = document.getElementById('msnCity').value;
    if (cod) loadMsnOverview(cod);
});
function msnCityDefault() {
    const c = centroidByCod['5103403']; // Cuiabá
    return c ? '5103403' : (Object.keys(centroidByCod)[0] || '');
}


/* ================= SIPAM Painel do Fogo — Eventos ativos em MT ================= */
const SIPAM_STATUS_COR = { 'Em observação': '#f97316', 'Ativo': '#dc2626' };

function sipamRaio(area) {
    if (!area || area <= 0) return 4;
    return Math.min(14, 4 + Math.sqrt(area) / 1.2);
}

function sipamFmtData(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' +
               d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
}

async function loadSIPAM() {
    sipamLoading = true;
    const meta = document.getElementById('metaSipam');
    meta.innerHTML = 'CENSIPAM · <b>carregando eventos...</b>';
    // Fase 3+: CENSIPAM cobre a Amazônia Legal — parametriza a UF.
    // Sem UF (visão Brasil): pede seleção; fora da AMZ: explica.
    const UF_AMZ = ['AC', 'AP', 'AM', 'MA', 'MT', 'PA', 'RO', 'RR', 'TO'];
    const siglaUF = ufSiglaCorrente();
    if (!siglaUF) {
        meta.textContent = 'CENSIPAM · selecione uma UF da Amazônia Legal';
        sipamLoading = false;
        sipamLoaded = true;
        sipamData = [];
        return;
    }
    if (!UF_AMZ.includes(siglaUF)) {
        meta.textContent = `CENSIPAM · fora da área de cobertura (Amazônia Legal) para ${siglaUF}`;
        sipamLoading = false;
        sipamLoaded = true;
        sipamData = [];
        return;
    }
    try {
        const res = await dcProxyFetch('https://panorama.sipam.gov.br/painel-do-fogo/api/v1/eventos?sigla_estado=' + siglaUF);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const eventos = await res.json();
        if (!Array.isArray(eventos) || !eventos.length) {
            meta.textContent = `CENSIPAM · nenhum evento ativo em ${siglaUF}`;
            sipamLoading = false;
            sipamLoaded = true;
            sipamData = [];
            return;
        }
        sipamData = eventos;
        sipamLayer = L.layerGroup();
        eventos.forEach(ev => {
            const lat = ev.latitude, lng = ev.longitude;
            if (!isFinite(lat) || !isFinite(lng)) return;
            const cor = SIPAM_STATUS_COR[ev.status_evento] || '#f97316';
            const raio = sipamRaio(ev.area_total_evento);
            const dominios = ev.dominio ? ev.dominio.split(',').map(d => d.trim()).filter(Boolean) : [];
            const dominioLabel = dominios.length ? dominios.join(', ') : '—';
            const territorios = [ev.terra_indigena, ev.unidade_conservacao, ev.quilombola, ev.projeto_assentamento]
                .filter(Boolean).map(t => t.trim()).join(', ');
            const persistencia = ev.persistencia_dias != null ? ev.persistencia_dias + ' dia(s)' : '—';
            L.marker([lat, lng], { icon: iconDivMarker('flame', cor, Math.round(raio * 2.6)) }).bindPopup(`
                <div style="min-width:230px;">
                    <div style="font-weight:700;font-size:12.5px;margin-bottom:2px;">
                        <i data-lucide="flame" style="color:${cor};margin-right:4px;"></i>Evento #${ev.id_evento}
                    </div>
                    <div style="color:#94a3b8;font-size:10.5px;margin-bottom:8px;">
                        Status: <b style="color:${cor};">${ev.status_evento}</b> · ${ev.municipio || '—'}
                    </div>
                    <div style="font-size:11px;line-height:1.7;">
                        <div><b>Área total:</b> ${ev.area_total_evento ? ev.area_total_evento.toFixed(2) + ' ha' : '—'}</div>
                        <div><b>Persistência:</b> ${persistencia}</div>
                        <div><b>Detectado em:</b> ${sipamFmtData(ev.dt_minima)}</div>
                        <div><b>Última visão:</b> ${sipamFmtData(ev.dt_ultima_visao)}</div>
                        <div><b>Domínio:</b> ${dominioLabel}</div>
                        ${territorios ? '<div><b>Área especial:</b> ' + territorios + '</div>' : ''}
                        <div><b>Coords:</b> ${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
                    </div>
                    <div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);font-size:9px;color:#94a3b8;line-height:1.5;">
                        Fonte: CENSIPAM — Painel do Fogo<br>
                        Evento ativo ou em observação · dados em tempo real<br>
                        <a href="https://panorama.sipam.gov.br/painel-do-fogo/" target="_blank" rel="noopener" style="color:#38bdf8;">portal oficial</a>
                    </div>
                    <a href="https://www.waze.com/ul?ll=${lat},${lng}&navigate=yes&zoom=17" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding:7px 12px;background:linear-gradient(135deg,#33ccff,#0099ff);color:#fff;font-size:11px;font-weight:700;border-radius:8px;text-decoration:none;transition:transform .15s,box-shadow .15s;" onmouseover="this.style.transform='scale(1.03)';this.style.boxShadow='0 4px 16px rgba(0,153,255,.4)';" onmouseout="this.style.transform='';this.style.boxShadow='';">
                        <i data-lucide="navigation"></i> Navegar com Waze
                    </a>
                </div>`).addTo(sipamLayer);
        });
        sipamLayer.addTo(map);
        sipamLoaded = true;
        sipamLoading = false;
        const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        meta.innerHTML = `CENSIPAM · <b>${eventos.length.toLocaleString('pt-BR')} evento(s)</b> em ${siglaUF} · atualizado ${hora}`;
        refreshLegend();
        setTimeout(loadSIPAM, 10 * 60 * 1000);
    } catch (e) {
        sipamLoading = false;
        meta.textContent = 'CENSIPAM · indisponível';
    }
}

/* ================= Ocorrências / Acontecimentos (reports da API) ================= */
const REPORT_ICONS = {
    acidente: 'car', engarrafamento: 'traffic-cone', evento: 'calendar',
    clima: 'cloud-lightning', tempestade: 'cloud-lightning', temporal: 'cloud-lightning',
    tornado: 'tornado', vendaval: 'wind', vento: 'wind', ventania: 'wind',
    raio: 'zap', raios: 'zap', trovoada: 'cloud-lightning',
    chuva: 'cloud-rain', 'chuva forte': 'cloud-rain-wind', 'chuva intensa': 'cloud-rain-wind',
    granizo: 'cloud-hail', neve: 'cloud-snow', gelo: 'snowflake', geada: 'snowflake',
    nevoeiro: 'cloud-fog', neblina: 'cloud-fog', bruma: 'cloud-fog',
    alagamento: 'waves', enchente: 'waves', inundacao: 'waves',
    'transbordamento': 'waves', onda: 'waves', swell: 'waves',
    fogo: 'flame', queimada: 'flame', incendio: 'flame',
    fumaca: 'smoke', fuma: 'smoke',
    arvore: 'tree-deciduous', 'queda de arvore': 'tree-deciduous',
    deslizamento: 'mountain', desmoronamento: 'mountain', desabamento: 'mountain',
    rachadura: 'triangle-alert', perigo: 'triangle-alert',
    obra: 'construction', interdicao: 'traffic-cone',
    'calor': 'thermometer-sun', 'onda de calor': 'thermometer-sun', 'seca': 'sun-dim',
    'seca extrema': 'sun-dim', 'estiagem': 'sun-dim',
    'frio': 'thermometer', 'friagem': 'thermometer-snowflake'
};
const REPORT_SEV_COLOR = { urgent: '#ef4444', warning: '#f97316', alto: '#ef4444', medio: '#f97316', info: '#00d2ff', critica: '#ef4444', alta: '#f97316', media: '#fbbf24', baixa: '#00d2ff' };
const REPORT_CLIMA_COR = {
    tempestade: '#a855f7', temporal: '#a855f7', tornado: '#a855f7',
    chuva: '#38bdf8', granizo: '#60a5fa', neve: '#93c5fd', gelo: '#93c5fd', geada: '#93c5fd',
    alagamento: '#0ea5e9', enchente: '#0ea5e9', inundacao: '#0ea5e9',
    vento: '#f59e0b', vendaval: '#f97316', ventania: '#f59e0b',
    raio: '#facc15', raios: '#facc15', trovoada: '#facc15',
    nevoeiro: '#94a3b8', neblina: '#94a3b8', bruma: '#94a3b8',
    fogo: '#ef4444', queimada: '#ef4444', incendio: '#ef4444',
    fumaca: '#64748b',
    deslizamento: '#b45309', desmoronamento: '#b45309', desabamento: '#b45309',
    arvore: '#22c55e', calor: '#f97316', 'onda de calor': '#f97316', seca: '#eab308', estiagem: '#eab308',
    frio: '#38bdf8', friagem: '#7dd3fc'
};

function reportIcon(type) {
    const t = String(type || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (REPORT_ICONS[t]) return REPORT_ICONS[t];
    if (t.includes('tempest') || t.includes('temporal') || t.includes('clima')) return 'cloud-lightning';
    if (t.includes('raio') || t.includes('trovoada')) return 'zap';
    if (t.includes('alag') || t.includes('inund') || t.includes('enchent') || t.includes('transbord') || t.includes('agua')) return 'waves';
    if (t.includes('chuva') || t.includes('precipit')) return 'cloud-rain';
    if (t.includes('granizo')) return 'cloud-hail';
    if (t.includes('neve') || t.includes('gelo') || t.includes('geada')) return 'snowflake';
    if (t.includes('neblina') || t.includes('nevoeiro') || t.includes('bruma')) return 'cloud-fog';
    if (t.includes('vent') || t.includes('vendaval') || t.includes('tornado')) return 'wind';
    if (t.includes('fogo') || t.includes('queimada') || t.includes('incendio')) return 'flame';
    if (t.includes('fum')) return 'smoke';
    if (t.includes('arvore') || t.includes('queda') || t.includes('galho')) return 'tree-deciduous';
    if (t.includes('desliz') || t.includes('desmoron') || t.includes('desab')) return 'mountain';
    if (t.includes('calor') || t.includes('seca') || t.includes('estiag')) return 'thermometer-sun';
    if (t.includes('frio') || t.includes('friag')) return 'thermometer';
    if (t.includes('acident')) return 'car';
    if (t.includes('transito') || t.includes('engarraf')) return 'traffic-cone';
    return 'circle-alert';
}
function reportSevColor(sev) { return REPORT_SEV_COLOR[String(sev || 'info').toLowerCase()] || '#00d2ff'; }

/* Ocorrência de natureza / ação climática (dispara popup em tempo real) */
function isNaturezaClima(type) {
    return reportIcon(type) !== 'circle-alert' && reportIcon(type) !== 'car' && reportIcon(type) !== 'traffic-cone' && reportIcon(type) !== 'calendar' && reportIcon(type) !== 'construction';
}

function reportMarkerBtn(lat, lng) {
    return `<a href="https://www.waze.com/ul?ll=${lat},${lng}&navigate=yes&zoom=17" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding:7px 12px;background:linear-gradient(135deg,#33ccff,#0099ff);color:#fff;font-size:11px;font-weight:700;border-radius:8px;text-decoration:none;" onmouseover="this.style.transform='scale(1.03)';this.style.boxShadow='0 4px 16px rgba(0,153,255,.4)';" onmouseout="this.style.transform='';this.style.boxShadow='';"><i data-lucide="navigation"></i> Navegar com Waze</a>`;
}

async function loadReports() {
    if (reportsLoading) return;
    reportsLoading = true;
    const meta = document.getElementById('metaReports');
    if (meta && !reportsLoaded) meta.innerHTML = 'Ocorrências · <b>carregando...</b>';
    try {
        let points = [];
        // Fonte principal: ocorrências consolidadas (Waze/TOMTOM + manuais)
        if (window.dcApi && window.dcApi.occurrencesMap) {
            const r = await window.dcApi.occurrencesMap();
            const pts = r && r.data && Array.isArray(r.data.points) ? r.data.points : null;
            if (pts) points = pts;
        }
        // Fallback: coleção antiga de reports (mesmo formato visual)
        if (!points.length && window.dcApi && window.dcApi.reports) {
            const r = await window.dcApi.reports();
            const rep = (r && r.data && r.data.reports) || [];
            points = rep.filter(x => isFinite(Number(x.lat)) && isFinite(Number(x.lng))).map(x => ({
                id: x.id, type: x.type, priority: x.severity || 'info', status: 'INFO',
                source: x.reporter || 'Anônimo', latitude: Number(x.lat), longitude: Number(x.lng),
                street: x.location || '', city: '', reportedAt: x.ts || x.createdAt,
                description: x.description || ''
            }));
        }
        // Limita às ocorrências dentro do território de Mato Grosso
        // Fase 3+: sem recorte MT — nacional, orientado aos dados da API.

        if (!reportsLayer) reportsLayer = L.layerGroup();
        let novos = 0, novosClimaticos = [];
        points.forEach(rep => {
            const lat = Number(rep.latitude), lng = Number(rep.longitude);
            if (!isFinite(lat) || !isFinite(lng)) return;
            const k = String(rep.id) || (lat.toFixed(6) + ',' + lng.toFixed(6) + ':' + (rep.reportedAt || ''));
            if (reportSeenIds.has(k)) return;
            reportSeenIds.add(k);
            novos++;
            const iconeNovo = reportIcon(rep.type);
            const color = REPORT_CLIMA_COR[iconeNovo] || reportSevColor(rep.priority);
            const titulo = (String(rep.type || 'acontecimento')).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
            const iconeHTML = `<i data-lucide="${iconeNovo}" style="color:#fff;width:15px;height:15px;"></i>`;
            const markerIcon = L.divIcon({
                className: '',
                html: `<div style="width:30px;height:30px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px ${color}55;border:2px solid #fff;">${iconeHTML}</div>`,
                iconSize: [30, 30], iconAnchor: [15, 15]
            });
            const cidade = rep.city ? (rep.state && rep.state !== 'MT' ? rep.city + ' · ' + rep.state : rep.city + ' · MT') : 'Local não informado';
            const marker = L.marker([lat, lng], { icon: markerIcon, wazeKey: k }).bindPopup(`
                <div style="min-width:200px;">
                    <div style="font-weight:700;font-size:12.5px;margin-bottom:4px;display:flex;align-items:center;gap:6px;">
                        <i data-lucide="${iconeNovo}" style="color:${color};"></i>${titulo}
                    </div>
                    <div style="color:#94a3b8;font-size:10.5px;margin-bottom:6px;">${cidade}</div>
                    <div style="font-size:11px;line-height:1.7;">
                        ${rep.description ? '<div>' + rep.description + '</div>' : ''}
                        <div style="margin-top:4px;"><b>Prioridade:</b> <span style="color:${reportSevColor(rep.priority)};">${String(rep.priority || 'info')}</span></div>
                        <div><b>Status:</b> ${String(rep.status || '—')}</div>
                        <div><b>Fonte:</b> ${String(rep.source || '—')}</div>
                        <div><b>Hora:</b> ${rep.reportedAt ? new Date(rep.reportedAt).toLocaleString('pt-BR') : '—'}</div>
                    </div>
                    ${reportMarkerBtn(lat, lng)}
                </div>`).addTo(reportsLayer);
            reportMarkerIds.set(k, marker);
            // Ocorrência de natureza / ação climática → gera popup automático no mapa
            if (isNaturezaClima(rep.type)) novosClimaticos.push({ marker, rep, titulo, color, icone: iconeNovo });
        });
        // Remove marcadores de ocorrências que saíram do recorte MT / da API
        const seenNow = new Set(points.map(p => String(p.id) || (String(p.latitude) + ',' + String(p.longitude) + ':' + (p.reportedAt || ''))));
        reportMarkerIds.forEach((m, k) => { if (!seenNow.has(k)) { m.remove(); reportMarkerIds.delete(k); reportSeenIds.delete(k); } });
        reportsLoaded = true;
        reportsLoading = false;
        const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        if (meta) meta.innerHTML = `Ocorrências · <b>${reportMarkerIds.size.toLocaleString('pt-BR')}</b> acontecimento(s) em MT · ao vivo ${hora}${novos ? ' · <b style="color:#38bdf8;">+' + novos + '</b> novo(s)' : ''}`;
        applyChecks();
        if (window.lucide) lucide.createIcons();
        // Popup em tempo real da(s) ocorrência(s) climática(s) recém-chegadas (apenas em atualizações posteriores)
        if (novosClimaticos.length) {
            const jaTinhaDados = reportSeenIds.size > novos;
            if (jaTinhaDados && window.toast) {
                novosClimaticos.forEach(nc => {
                    const coords = nc.marker.getLatLng();
                    toast(`<b style="color:${nc.color};">${nc.icone === 'cloud-lightning' ? '⚡' : ''}${nc.icone === 'flame' ? '🔥' : ''}</b> ${nc.titulo} — ${nc.rep.city || 'MT'} <span style="opacity:.7;font-size:10px;">(${coords.lat.toFixed(3)},${coords.lng.toFixed(3)})</span>`, true);
                });
                const primeio = novosClimaticos[0];
                try { map.flyTo(primeio.marker.getLatLng(), Math.max(map.getZoom(), 11)); } catch {}
                setTimeout(() => { try { primeio.marker.openPopup(); } catch {} }, 450);
            }
        }
    } catch (e) {
        reportsLoading = false;
        if (meta) meta.textContent = 'Ocorrências · API indisponível';
    }
    // Tempo real: atualização frequente (a cada 60s) para refletir novas ocorrências
    clearTimeout(reportsTimer);
    reportsTimer = setTimeout(loadReports, 60 * 1000);
}

