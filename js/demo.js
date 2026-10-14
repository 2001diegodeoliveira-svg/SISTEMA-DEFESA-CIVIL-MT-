/* Access control — public mode (no login required).
   AUTH_LOGIN_ENABLED=false opens all pages and protected API operations. */
(function (global) {
    'use strict';

    /* Todas as páginas são públicas. O mapa é monitoramento público
       (inclusive TVs de sala de situação sem login). */
    var PUBLICAS = ['mapa.html'];
    var PAGINAS_INTERNAS = {};

    function nomePagina() {
        var partes = String((global.location && global.location.pathname) || '').split('/');
        return (partes[partes.length - 1] || 'index.html').toLowerCase();
    }

    var estado = {
        aberto: true,
        loginHabilitado: false,
        liberado: true,
        sincronizado: true,
        concluido: true,
        suspenso: false,
        manutencaoAte: null
    };

    function aplicarNaPagina() {
        try {
            if (typeof global.dcRenderUserArea === 'function') global.dcRenderUserArea();
            if (typeof global.dcAplicarNav === 'function') global.dcAplicarNav();
        } catch (e) { /* página ainda não pronta */ }
    }

    function concluir() {
        aplicarNaPagina();
    }

    global.DC_DEMO = {
        estado: estado,
        aguardar: function (callback) {
            try { callback(estado); } catch (e) { /* callback externo */ }
        },
        bloquear: function () {},
        recalcular: function () {}
    };

    concluir();
})(window);