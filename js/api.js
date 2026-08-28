/* ============================================================
   Cliente da API do backend — Defesa Civil MT.
   Centraliza a URL base, o token de sessão e o fallback.
   Usa o mesmo domínio do deploy (Vercel) — /api/*.
   ============================================================ */
(function (global) {
    var API_BASE = (typeof BACKEND_BASE !== 'undefined' && BACKEND_BASE)
        ? BACKEND_BASE
        : '';

    function token() {
        try { return localStorage.getItem('dcmt_token'); } catch (e) { return null; }
    }

    function request(path, opts) {
        opts = opts || {};
        opts.method = opts.method || 'GET';
        var headers = Object.assign({}, opts.headers || {});
        var tok = token();
        if (tok) headers['Authorization'] = 'Bearer ' + tok;
        if (opts.body) headers['Content-Type'] = 'application/json';

        return fetch(API_BASE + '/api/' + path, {
            method: opts.method,
            headers: headers,
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (data) {
                return { status: r.status, ok: r.ok, data: data };
            });
        });
    }

    global.dcApi = {
        // Autenticação
        login: function (usuario, senha) {
            return request('auth/login', { method: 'POST', body: { usuario: usuario, senha: senha } });
        },
        me: function () { return request('auth/me'); },
        logout: function () {
            try { localStorage.removeItem('dcmt_token'); } catch (e) {}
            return request('auth/logout', { method: 'POST' }).catch(function () { return null; });
        },

        // Alertas
        alertas: function () { return request('alertas'); },

        // Ocorrências (Waze)
        reports: function () { return request('reports'); },
        createReport: function (data) { return request('reports', { method: 'POST', body: data }); },

        // Áreas de interesse
        areas: function () { return request('areas'); },
        createArea: function (data) { return request('areas', { method: 'POST', body: data }); },
        deleteArea: function (id) { return request('areas/' + id, { method: 'DELETE' }); },

        // Utilidades
        getToken: token,
    };
})(window);
