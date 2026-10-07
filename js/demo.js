/* ============================================================
   Controle de acesso — espelho no cliente.

   O sistema NÃO abre sem login por padrão: o estado inicial é
   FECHADO e qualquer página (exceto login.html) é redirecionada
   para o login até existir uma sessão válida.

   O servidor é a autoridade (GET /api/demo): se ele declarar a
   janela de demonstração ABERTA (DEMO_HORAS > 0), o acesso livre
   é permitido. Sem resposta do servidor o sistema permanece
   fechado (falha fechada, nunca aberta).

   Páginas públicas mesmo sem sessão: nenhuma (apenas login.html).
   ============================================================ */
(function (global) {
    'use strict';

    var CHAVE_INICIO = 'dcmt_demo_inicio';
    var DURACAO_PADRAO_MS = 24 * 60 * 60 * 1000;
    var TIMEOUT_SYNC_MS = 4000;
    var LIMITE_TIMEOUT_MS = 2147483647;

    /* Serviços que não exigem sessão — por padrão, só a página de login. */
    var PUBLICAS = ['login.html'];

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
            var token = global.localStorage.getItem('dcmt_token');
            if (!token) return false;
            var s = JSON.parse(global.localStorage.getItem('dcmt_session') || 'null');
            if (!s || !s.perfil) return false;
            var validos = ['admin', 'avancado', 'municipal', 'comum'];
            return validos.indexOf(s.perfil) !== -1;
        } catch (e) { return false; }
    }

    var inicio = lerInicioLocal();
    if (!inicio) { inicio = Date.now(); gravarInicioLocal(inicio); }

    /* Estado inicial FECHADO: exige login até o servidor confirmar
       a janela de demonstração. Falha fechada, nunca aberta. */
    var estado = {
        inicio: inicio,
        duracaoMs: 0,
        expiraEm: inicio,
        aberto: false,
        loginHabilitado: true,
        liberado: false,
        sincronizado: false,
        concluido: false
    };

    function recalcular() {
        estado.expiraEm = estado.inicio + estado.duracaoMs;
        estado.aberto = Date.now() < estado.expiraEm;
        estado.liberado = estado.aberto || estado.loginHabilitado === false;
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
        try {
            global.location.replace('login.html');
        } catch (e) { /* já está em login */ }
    }

    function aplicarNaPagina() {
        try {
            if (typeof global.dcRenderUserArea === 'function') global.dcRenderUserArea();
            if (typeof global.dcAplicarNav === 'function') global.dcAplicarNav();
        } catch (e) { /* página ainda não pronta */ }
    }

    /* Bloqueio imediato: não espera a sincronização com o servidor. */
    bloquearSeNecessario();

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
                /* O servidor é a autoridade. Sem resposta (offline, API
                   indisponível) o estado permanece FECHADO. */
                var servidor = Number(dados.inicio);
                if (servidor > 0) {
                    estado.inicio = servidor;
                    gravarInicioLocal(servidor);
                }
                if (dados.loginHabilitado === false) {
                    /* Login suspenso no servidor: libera leitura sem token. */
                    estado.duracaoMs = 0;
                    estado.loginHabilitado = false;
                } else if (dados.habilitado === true && Number(dados.duracaoHoras) > 0) {
                    /* Autorização explícita do servidor para janela de demo. */
                    estado.duracaoMs = Number(dados.duracaoHoras) * 3600000;
                    if (servidor <= 0) {
                        estado.inicio = Date.now();
                        gravarInicioLocal(estado.inicio);
                    }
                    estado.loginHabilitado = true;
                } else {
                    /* Janela desligada: sistema fechado, exige login. */
                    estado.duracaoMs = 0;
                    estado.loginHabilitado = true;
                }
                estado.sincronizado = true;
            })
            .catch(function () { /* offline: mantém o cálculo local (fechado) */ })
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