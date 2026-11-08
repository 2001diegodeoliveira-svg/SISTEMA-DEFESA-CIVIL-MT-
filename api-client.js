/* ============================================================
   Cliente HTTP do módulo de Contratos (SGC / COPAL).
   Usado por contratos.html.

   Backend padrão: https://sistema-geral-copal-4.onrender.com
   (com fallback para https://sistema-geral-copal.onrender.com).
   Pode ser sobrescrito por:
   - window.API_BASE_URL = 'https://...';
   - localStorage.setItem('API_BASE_URL', 'https://...');
   - app-config.json { "productionApiBase": "https://..." }.
   ============================================================ */
(function (global) {
    'use strict';

    var PADRAO = 'https://sistema-geral-copal-4.onrender.com';
    var FALLBACKS = ['https://sistema-geral-copal.onrender.com'];
    var baseConfigurada = '';
    var carregouConfig = false;

    function normalizar(valor) {
        return String(valor || '').trim().replace(/\/+$/, '');
    }

    function baseGuardada() {
        try { return normalizar(global.localStorage.getItem('API_BASE_URL')); }
        catch (e) { return ''; }
    }

    function baseAtual() {
        return normalizar(global.API_BASE_URL || baseGuardada() || baseConfigurada || PADRAO);
    }

    /* app-config.json é opcional; se existir, tem prioridade. */
    function carregarConfig() {
        if (carregouConfig) return;
        carregouConfig = true;
        try {
            fetch('app-config.json', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (cfg) {
                    if (!cfg) return;
                    if (Array.isArray(cfg.productionApiFallbacks)) {
                        FALLBACKS = cfg.productionApiFallbacks.map(normalizar).filter(Boolean);
                    }
                    var producao = normalizar(cfg.productionApiBase);
                    if (producao && !global.API_BASE_URL && !baseGuardada()) baseConfigurada = producao;
                })
                .catch(function () { /* mantém o padrão */ });
        } catch (e) { /* mantém o padrão */ }
    }

    function apiUrl(path) {
        var p = String(path || '');
        if (/^https?:\/\//i.test(p)) return p;
        return baseAtual() + (p.charAt(0) === '/' ? p : '/' + p);
    }

    function tokenAtual() {
        try { return global.localStorage.getItem('accessToken') || ''; }
        catch (e) { return ''; }
    }

    async function apiFetch(path, options) {
        var opts = Object.assign({}, options || {});
        var headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
        var token = tokenAtual();
        var ehLogin = /^\/?auth\/(login|registrar|register)\b/i.test(String(path || ''));
        if (token && !ehLogin) headers['Authorization'] = 'Bearer ' + token;
        if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        opts.headers = headers;
        return fetch(apiUrl(path), opts);
    }

    async function apiFetchJson(path, options) {
        var resposta = await apiFetch(path, options);
        var texto = await resposta.text();
        var dados = null;
        if (texto) {
            try { dados = JSON.parse(texto); } catch (e) { dados = texto; }
        }
        if (!resposta.ok) {
            var mensagem = (dados && (dados.erro || dados.error || dados.message)) || ('HTTP ' + resposta.status);
            var erro = new Error(mensagem);
            erro.status = resposta.status;
            erro.data = dados;
            throw erro;
        }
        return dados;
    }

    global.apiUrl = apiUrl;
    global.apiFetch = apiFetch;
    global.apiFetchJson = apiFetchJson;
    global.setApiBaseUrl = function (url) {
        baseConfigurada = normalizar(url);
        try {
            if (baseConfigurada) global.localStorage.setItem('API_BASE_URL', baseConfigurada);
            else global.localStorage.removeItem('API_BASE_URL');
        } catch (e) { /* ignore */ }
        return baseAtual();
    };
    global.clearApiBaseUrl = function () { return global.setApiBaseUrl(''); };
    global.getApiBaseUrl = baseAtual;

    carregarConfig();
})(typeof window !== 'undefined' ? window : globalThis);
