/* ============================================================
   Janela de demonstração — espelho no cliente.

   A primeira visita grava o início em localStorage; o servidor é a
   autoridade (GET /api/demo) e devolve o marco que ele registrou.
   Enquanto a janela está aberta o sistema roda sem login; ao expirar,
   com AUTH_LOGIN_ENABLED ativo, as páginas restritas vão para login.html.

   Páginas que continuam públicas mesmo com a janela expirada:
   listadas em PUBLICAS abaixo.
   ============================================================ */
(function (global) {
    'use strict';

    var CHAVE_INICIO = 'dcmt_demo_inicio';
    var DURACAO_PADRAO_MS = 24 * 60 * 60 * 1000;
    var TIMEOUT_SYNC_MS = 4000;
    var LIMITE_TIMEOUT_MS = 2147483647;

    /* Serviços cidadãos que não exigem sessão. */
    var PUBLICAS = [
        'login.html',
        'alertas.html',
        'ocorrencia.html',
        'registrar-ocorrencia.html',
        'cadastro-voluntario.html',
        'satelite.html'
    ];

    function nomePagina() {
        var partes = String((global.location && global.location.pathname) || '').split('/');
        return (partes[partes.length - 1] || 'index.html').toLowerCase();
    }

    function lerInicioLocal() {
        try {
            var valor = Number(global.localStorage.getItem(CHAVE_INICIO));
            return valor > 0 ? valor : null;
        } catch (e) { return null; }
    }

    function gravarInicioLocal(inicio) {
        try { global.localStorage.setItem(CHAVE_INICIO, String(inicio)); } catch (e) { /* sem storage */ }
    }

    function sessaoReal() {
        try {
            return !!(global.localStorage.getItem('dcmt_session') || global.localStorage.getItem('dcmt_token'));
        } catch (e) { return false; }
    }

    var inicio = lerInicioLocal();
    if (!inicio) { inicio = Date.now(); gravarInicioLocal(inicio); }

    var estado = {
        inicio: inicio,
        duracaoMs: DURACAO_PADRAO_MS,
        expiraEm: inicio + DURACAO_PADRAO_MS,
        aberto: true,
        /* Sem resposta do servidor assumimos login desabilitado, para não
           jogar o visitante no login durante uma falha de rede. */
        loginHabilitado: false,
        liberado: true,
        sincronizado: false,
        concluido: false
    };

    function recalcular() {
        estado.expiraEm = estado.inicio + estado.duracaoMs;
        estado.aberto = Date.now() < estado.expiraEm;
        estado.liberado = estado.aberto || !estado.loginHabilitado;
    }
    recalcular();

    var esperando = [];
    function notificar() {
        var fila = esperando;
        esperando = [];
        for (var i = 0; i < fila.length; i++) {
            try { fila[i](estado); } catch (e) { /* callback externo */ }
        }
    }

    function bloquearSeNecessario() {
        if (estado.liberado) return;
        if (sessaoReal()) return;
        var pagina = nomePagina();
        if (pagina === 'login.html') return;
        if (PUBLICAS.indexOf(pagina) !== -1) return;
        global.location.replace('login.html');
    }

    function aplicarNaPagina() {
        try {
            if (typeof global.dcRenderUserArea === 'function') global.dcRenderUserArea();
            if (typeof global.dcAplicarNav === 'function') global.dcAplicarNav();
        } catch (e) { /* página ainda não pronta */ }
    }

    function agendarBloqueio() {
        if (estado.liberado || !estado.expiraEm) return;
        var restante = estado.expiraEm - Date.now();
        if (restante > 0 && restante < LIMITE_TIMEOUT_MS) {
            global.setTimeout(bloquearSeNecessario, restante + 1000);
        }
    }

    function sincronizar() {
        if (typeof global.fetch !== 'function') return concluir();
        var pedido = global.fetch('api/demo', { headers: { accept: 'application/json' } })
            .then(function (resposta) { return resposta && resposta.ok ? resposta.json() : null; });
        var comTempo = Promise.race([
            pedido,
            new Promise(function (resolver) {
                global.setTimeout(function () { resolver(null); }, TIMEOUT_SYNC_MS);
            })
        ]);
        comTempo
            .then(function (dados) {
                if (!dados) return;
                /* O servidor é a autoridade: marco, duração e janela vêm dele
                   (assim um reset no banco reinicia a janela em todo navegador). */
                var servidor = Number(dados.inicio);
                if (servidor > 0) {
                    estado.inicio = servidor;
                    gravarInicioLocal(servidor);
                }
                if (dados.habilitado === false) {
                    /* Janela desligada no servidor: fecha imediatamente aqui. */
                    estado.duracaoMs = 0;
                    if (servidor <= 0) {
                        estado.inicio = Date.now();
                        gravarInicioLocal(estado.inicio);
                    }
                } else if (Number(dados.duracaoHoras) > 0) {
                    estado.duracaoMs = Number(dados.duracaoHoras) * 3600000;
                }
                estado.loginHabilitado = !!dados.loginHabilitado;
                estado.sincronizado = true;
            })
            .catch(function () { /* offline: mantém o cálculo local */ })
            .then(concluir);
    }

    function concluir() {
        recalcular();
        estado.concluido = true;
        aplicarNaPagina();
        bloquearSeNecessario();
        agendarBloqueio();
        notificar();
    }

    global.DC_DEMO = {
        estado: estado,
        aguardar: function (callback) {
            if (estado.concluido) {
                try { callback(estado); } catch (e) { /* callback externo */ }
                return;
            }
            esperando.push(callback);
        },
        bloquear: bloquearSeNecessario,
        recalcular: recalcular
    };

    sincronizar();
})(window);
