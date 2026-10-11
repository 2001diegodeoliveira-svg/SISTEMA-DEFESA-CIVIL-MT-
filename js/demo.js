/* Access control mirrors the server configuration.
   AUTH_LOGIN_ENABLED=false opens all pages and protected API operations.
   The client starts open to avoid redirecting before the server responds;
   the server then applies the configured login or demo-window state. */
(function (global) {
    'use strict';

    var CHAVE_INICIO = 'dcmt_demo_inicio';
    var DURACAO_PADRAO_MS = 24 * 60 * 60 * 1000;
    var TIMEOUT_SYNC_MS = 4000;
    var LIMITE_TIMEOUT_MS = 2147483647;

    /* Login remains available as a public page when authentication is enabled. */
    var PUBLICAS = ['login.html'];
    var PAGINAS_INTERNAS = {
        'painel.html': ['admin', 'avancado', 'municipal', 'coordenador', 'analista', 'operador_campo', 'leitura'],
        'gestao.html': ['admin', 'avancado', 'municipal', 'administrador_orgao', 'coordenador', 'analista', 'leitura'],
        'gestaodefrota.html': ['admin', 'avancado', 'municipal', 'administrador_orgao', 'coordenador', 'operador_campo', 'leitura'],
        'vistoria.html': ['admin', 'avancado', 'municipal', 'coordenador', 'operador_campo'],
        'meus-chamados.html': ['admin', 'avancado', 'municipal', 'coordenador', 'analista', 'operador_campo', 'voluntario', 'leitura'],
        'cadastro-usuarios.html': ['admin', 'administrador_orgao', 'coordenador']
    };

    function paginaPermitida(pagina, sessao) {
        var papeis = PAGINAS_INTERNAS[pagina];
        if (!papeis) return true;
        if (!sessao) return false;
        var atribuicoes = [sessao.perfil].concat(Array.isArray(sessao.papeis) ? sessao.papeis : []);
        if (sessao.perfil === 'admin') atribuicoes.push('administrador_orgao');
        if (sessao.perfil === 'avancado') atribuicoes.push('coordenador', 'analista');
        if (sessao.perfil === 'municipal') atribuicoes.push('operador_campo');
        return papeis.some(function (papel) { return atribuicoes.indexOf(papel) !== -1; });
    }

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

    function sessaoAtual() {
        try {
            var token = global.localStorage.getItem('dcmt_token');
            if (!token) return false;
            var s = JSON.parse(global.localStorage.getItem('dcmt_session') || 'null');
            if (!s || !s.perfil) return false;
            var validos = ['admin', 'avancado', 'municipal', 'comum'];
            return validos.indexOf(s.perfil) !== -1 ? s : false;
        } catch (e) { return false; }
    }

    var inicio = lerInicioLocal();
    if (!inicio) { inicio = Date.now(); gravarInicioLocal(inicio); }

    /* Estado inicial aberto: o sistema fica público por padrão para
       evitar redirecionamentos indevidos e permitir o acesso ao mapa
       e às páginas públicas sem exigir login. */
    var estado = {
        inicio: inicio,
        duracaoMs: 0,
        expiraEm: inicio,
        aberto: true,
        loginHabilitado: false,
        liberado: true,
        sincronizado: false,
        concluido: false
    };

    function recalcular() {
        estado.expiraEm = estado.inicio + estado.duracaoMs;
        estado.aberto = Date.now() < estado.expiraEm || estado.loginHabilitado === false;
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
        var pagina = nomePagina();
        if (pagina === 'login.html') return;
        if (PUBLICAS.indexOf(pagina) !== -1) return;
        var sessao = sessaoAtual();
        if (!sessao) {
            try { global.location.replace('login.html'); } catch (e) {}
            return;
        }
        if (!paginaPermitida(pagina, sessao)) {
            try { global.location.replace('index.html?acesso=negado'); } catch (e) {}
        }
    }

    function verificarPaginaProtegida() {
        var pagina = nomePagina();
        if (!PAGINAS_INTERNAS[pagina] || !estado.loginHabilitado || estado.liberado) return;
        var sessao = sessaoAtual();
        if (!sessao) return bloquearSeNecessario();
        var token = global.localStorage.getItem('dcmt_token');
        global.fetch('api/auth/me', {
            headers: { Authorization: 'Bearer ' + token, accept: 'application/json' }
        }).then(function (resposta) {
            if (!resposta.ok) throw new Error('Sessão expirada ou sem acesso.');
            return resposta.json();
        }).then(function (dados) {
            if (!dados || !dados.user || !paginaPermitida(pagina, dados.user)) {
                throw new Error('Seu perfil não pode acessar esta área.');
            }
            global.localStorage.setItem('dcmt_session', JSON.stringify(dados.user));
        }).catch(function () {
            global.localStorage.removeItem('dcmt_token');
            global.localStorage.removeItem('dcmt_session');
            global.location.replace('login.html?acesso=negado');
        });
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
        verificarPaginaProtegida();
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