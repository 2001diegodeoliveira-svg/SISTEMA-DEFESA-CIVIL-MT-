/* ============================================================
   Monitor de frescor e saúde das fontes — Mapa Integrado (Fase 2).
   - Selos por camada ("atualizado há X min", verde/amarelo/
     vermelho) a partir de GET /api/fontes/saude (hora da fonte
     no servidor, não do navegador).
   - Painel "Saúde das fontes": estado, último sucesso, última
     falha e latência por fonte (botão flutuante "Fontes").
   - Auto-refresh por camada (só camada visível), pausado com a
     aba oculta e retomado ao voltar (atrasados rodam na hora).
   - Camadas essenciais passam a carregar sozinhas (sem
     "ative para carregar"): focos, INMET, ANA e CENSIPAM.
   - Indicador global online/offline com heartbeat e reconexão
     automática (retoma polls + refresh atrasado).
   Não duplica o js/monitor.js (alertas); só frescor/saúde.
   ============================================================ */
(function (global) {
    'use strict';

    var SAUDE_URL = '/api/fontes/saude';
    var SAUDE_POLL_MS = 60000;
    var TICK_MS = 60000;

    /* check-key do mapa -> meta-line, fonte (api/_lib/origens.js),
       intervalo de refresh, auto-load no boot e loader global. */
    var CAMADAS = [
        { check: 'focos', meta: 'metaFocos', fonte: 'inpe-csv', refreshMin: 10, auto: true, loader: 'loadFocos' },
        { check: 'wmsFocos48h', meta: 'metaWmsFocos48h', fonte: 'inpe-terrabrasilis', refreshMin: 0, auto: false, loader: null },
        { check: 'anaHydrology', meta: 'metaAnaHydrology', fonte: null, refreshMin: 15, auto: true, loader: 'loadAnaHydrology' },
        { check: 'inmetStations', meta: 'metaInmet', fonte: 'inmet-estacoes', refreshMin: 15, auto: true, loader: 'loadInmetStations' },
        { check: 'chuvaInmet', meta: 'metaChuvaInmet', fonte: 'inmet-estacoes', refreshMin: 0, auto: false, loader: null },
        { check: 'sipam', meta: 'metaSipam', fonte: 'censipam', refreshMin: 10, auto: true, loader: 'loadSIPAM' },
        { check: 'barragens', meta: 'metaBarragens', fonte: null, refreshMin: 0, auto: false, loader: null },
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
    function atualizarSelos() {
        CAMADAS.forEach(function (c) {
            var meta = c.meta && $(c.meta);
            if (!meta) return;
            if (/carregando/i.test(meta.textContent || '')) return; // não atropela loading
            var dot = '<span class="fonte-dot" style="background:__COR__"></span> ';
            if (!c.fonte) {
                meta.innerHTML = dot.replace('__COR__', '#94a3b8') + 'sem telemetria de fonte';
                return;
            }
            var s = saudePorFonte[c.fonte];
            if (!s || !s.ultimoSucesso) {
                meta.innerHTML = dot.replace('__COR__', '#94a3b8') + 'sem registro da fonte';
                return;
            }
            var quando = haXMin(s.ultimoSucesso) || '—';
            var extra = '';
            if (s.ultimaFalha && Date.parse(s.ultimaFalha) > Date.parse(s.ultimoSucesso)) {
                extra = ' · última tentativa falhou (' + (haXMin(s.ultimaFalha) || '') + ')';
            }
            meta.innerHTML = dot.replace('__COR__', corEstado(s.estado || 'fora'))
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
        return fetch(SAUDE_URL, { cache: 'no-store' }).then(function (r) {
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
        fetch('/api/', { cache: 'no-store' }).then(function (r) {
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
        // Camadas essenciais: carrega sozinhas (adeus "ative para carregar").
        CAMADAS.forEach(function (c) {
            if (!c.auto) return;
            var meta = c.meta && $(c.meta);
            if (meta && /ative para carregar/i.test(meta.textContent || '')) {
                meta.textContent = 'carregamento automático ativo…';
            }
            try {
                if (typeof global.setCheck === 'function') global.setCheck(c.check, true);
            } catch (e) {}
            ultimoRefresh[c.check] = Date.now();
        });
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
