/* ============================================================
   Monitor de frescor e saúde das fontes — Mapa Integrado (Fase 2).
   - Selos por camada ("atualizado há X min", verde/amarelo/
     vermelho) a partir de GET /api/fontes/saude (hora da fonte
     no servidor, não do navegador).
   - Painel "Saúde das fontes": estado, último sucesso, última
     falha e latência por fonte (botão flutuante "Fontes").
    - Auto-refresh por camada (só camada visível e ligada pelo usuário),
      pausado com a aba oculta e retomado ao voltar (atrasados rodam
      na hora). Nada é ligado sozinho: opt-in como na versão MT.
   - Indicador global online/offline com heartbeat e reconexão
     automática (retoma polls + refresh atrasado).
   Não duplica o js/monitor.js (alertas); só frescor/saúde.
   ============================================================ */
(function (global) {
    'use strict';

    function baseUrl(path) {
        try {
            if (typeof apiUrl === 'function') return apiUrl(path);
        } catch (e) {}
        return path;
    }
    var SAUDE_POLL_MS = 60000;
    var TICK_MS = 60000;

    /* check-key do mapa -> meta-line, fonte (api/_lib/origens.js),
       intervalo de refresh e loader global. Opt-in como antes:
       nada é ligado sozinho; refresh só em camada visível. */
    var CAMADAS = [
        { check: 'focos', meta: 'metaFocos', fonte: 'inpe-csv', refreshMin: 10, loader: 'loadFocos' },
        { check: 'deter', meta: 'metaDeter', fonte: null, refreshMin: 0, loader: 'loadDeter' },
        { check: 'qualidadeAr', meta: 'metaQualidadeAr', fonte: 'open-meteo-aq', refreshMin: 60, loader: 'loadQualidadeAr' },
        { check: 'wmsFocos48h', meta: 'metaWmsFocos48h', fonte: 'inpe-terrabrasilis', refreshMin: 0, loader: null },
        { check: 'anaHydrology', meta: 'metaAnaHydrology', fonte: null, refreshMin: 15, loader: 'loadAnaHydrology' },
        { check: 'inmetStations', meta: 'metaInmet', fonte: 'inmet-estacoes', refreshMin: 15, loader: 'loadInmetStations' },
        { check: 'chuvaInmet', meta: 'metaChuvaInmet', fonte: 'inmet-estacoes', refreshMin: 0, loader: null },
        { check: 'sipam', meta: 'metaSipam', fonte: 'censipam', refreshMin: 10, loader: 'loadSIPAM' },
        { check: 'barragens', meta: 'metaBarragens', fonte: null, refreshMin: 0, loader: null },
    ];

    var saudePorFonte = {};   // id -> {estado, ultimoSucesso, ultimaFalha, latenciaMs}
    var ultimoRefresh = {};   // check -> timestamp ms (disparos deste monitor)
    var online = true;

    function $(id) { return document.getElementById(id); }

    function haXMin(iso) {
        if (!iso) return null;
        var ms = Date.now() - Date.parse(iso);
        if (!isFinite(ms) || ms < 0) return null;
        var min = Math.floor(ms / 60000);
        if (min < 1) return 'agora mesmo';
        if (min === 1) return 'há 1 min';
        if (min < 60) return 'há ' + min + ' min';
        var h = Math.floor(min / 60);
        return 'há ' + h + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '');
    }

    function corEstado(estado) {
        return estado === 'ok' ? '#22c55e' : (estado === 'lento' ? '#facc15' : '#ef4444');
    }

    /* ---------- selos por camada ---------- */
    /* Anexa (sem apagar o texto do loader) um selo com a hora da fonte. */
    function atualizarSelos() {
        CAMADAS.forEach(function (c) {
            var meta = c.meta && $(c.meta);
            if (!meta) return;
            if (/carregando/i.test(meta.textContent || '')) return; // não atropela loading
            var selo = meta.querySelector(':scope > span.fonte-selo');
            if (!c.fonte) {
                if (selo) selo.remove();
                return;
            }
            var s = saudePorFonte[c.fonte];
            if (!selo) {
                selo = document.createElement('span');
                selo.className = 'fonte-selo';
                meta.appendChild(document.createTextNode(' '));
                meta.appendChild(selo);
            }
            if (!s || !s.ultimoSucesso) {
                selo.innerHTML = '<span class="fonte-dot" style="background:#94a3b8"></span>sem registro da fonte';
                return;
            }
            var quando = haXMin(s.ultimoSucesso) || '—';
            var extra = '';
            if (s.ultimaFalha && Date.parse(s.ultimaFalha) > Date.parse(s.ultimoSucesso)) {
                extra = ' · última tentativa falhou (' + (haXMin(s.ultimaFalha) || '') + ')';
            }
            selo.innerHTML = '<span class="fonte-dot" style="background:' + corEstado(s.estado || 'fora') + '"></span>'
                + 'fonte atualizada ' + quando + extra;
        });
    }

    /* ---------- painel saúde das fontes ---------- */
    function renderPainel(lista) {
        var corpo = $('fontesCorpo');
        if (!corpo) return;
        if (!lista.length) {
            corpo.innerHTML = '<p class="fontes-vazio">Sem dados de saúde ainda.</p>';
            return;
        }
        corpo.innerHTML = lista.map(function (f) {
            var ok = f.ultimoSucesso ? haXMin(f.ultimoSucesso) : 'nunca';
            var falha = f.ultimaFalha ? haXMin(f.ultimaFalha) : '—';
            var lat = (f.latenciaMs != null) ? f.latenciaMs + ' ms' : '—';
            return '<div class="fonte-linha">'
                + '<span class="fonte-dot" style="background:' + corEstado(f.estado) + '"></span>'
                + '<b>' + f.id + '</b>'
                + '<span>ok: ' + ok + ' · falha: ' + falha + ' · ' + lat + '</span>'
                + '</div>';
        }).join('');
        var tit = $('fontesTitulo');
        if (tit) {
            var ruins = lista.filter(function (f) { return f.estado === 'fora'; }).length;
            tit.textContent = 'Saúde das fontes' + (ruins ? ' · ' + ruins + ' fora do ar' : ' · todas respondendo');
        }
    }

    function pollSaude() {
        return fetch(baseUrl('/api/fontes/saude'), { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        }).then(function (j) {
            saudePorFonte = {};
            (j.fontes || []).forEach(function (f) { saudePorFonte[f.id] = f; });
            renderPainel(j.fontes || []);
            atualizarSelos();
        }).catch(function () {
            /* sem saúde: mantém últimos selos; online/offline cuida do aviso */
        });
    }

    /* ---------- auto-refresh ---------- */
    function camadaVisivel(check) {
        try {
            if (typeof checkState !== 'undefined' && checkState[check] === false) return false;
        } catch (e) {}
        return true;
    }

    function refreshCamadas(soAtrasados) {
        var agora = Date.now();
        CAMADAS.forEach(function (c) {
            if (!c.refreshMin || !c.loader) return;
            if (!camadaVisivel(c.check)) return;
            var ultimo = ultimoRefresh[c.check] || 0;
            if (soAtrasados && agora - ultimo < c.refreshMin * 60000) return;
            var fn = global[c.loader];
            if (typeof fn !== 'function') return;
            ultimoRefresh[c.check] = agora;
            try {
                var r = fn();
                if (r && typeof r.catch === 'function') r.catch(function () {});
            } catch (e) {}
        });
    }

    /* ---------- online/offline ---------- */
    function setOnline(v, motivo) {
        if (v === online && motivo !== 'heartbeat') return;
        online = v;
        var banner = $('connBanner');
        if (banner) banner.style.display = v ? 'none' : 'flex';
        if (!v && typeof global.toast === 'function') global.toast('Sem conexão — pausando atualizações.');
        if (v) {
            if (typeof global.toast === 'function') global.toast('Conexão restabelecida.', true);
            pollSaude();
            refreshCamadas(true);
        }
    }

    function heartbeat() {
        fetch(baseUrl('/api/'), { cache: 'no-store' }).then(function (r) {
            setOnline(r.ok, 'heartbeat');
        }).catch(function () {
            setOnline(false, 'heartbeat');
        });
    }

    /* ---------- boot ---------- */
    var tickTimer = null;
    function tick() {
        if (document.hidden) return;
        pollSaude();
        refreshCamadas(true);
        heartbeat();
    }

    function init() {
        if (!global.checkState && typeof checkState === 'undefined') return false;
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
            } else {
                pollSaude();
                refreshCamadas(true);
                if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
            }
        });
        global.addEventListener('online', function () { setOnline(true); });
        global.addEventListener('offline', function () { setOnline(false); });
        pollSaude();
        if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
        return true;
    }

    var tentativas = 0;
    function boot() {
        try {
            if (init()) return;
        } catch (e) {}
        if (++tentativas < 40) setTimeout(boot, 500); // espera mapa/checkState
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    global.SaudeMonitor = {
        pollSaude: pollSaude,
        refreshCamadas: refreshCamadas,
        camadas: function () { return CAMADAS.slice(); },
    };
})(window);
