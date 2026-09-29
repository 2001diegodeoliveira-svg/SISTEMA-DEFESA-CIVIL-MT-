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

        // Solicitações de acesso e administração de usuários
        userRegistrations: function () { return request('user-registrations'); },
        createUserRegistration: function (data) {
            return request('user-registrations', { method: 'POST', body: data });
        },
        decideUserRegistration: function (id, decision) {
            return request('user-registrations/' + encodeURIComponent(id), { method: 'PATCH', body: decision });
        },
        updateUserRegistration: function (id, data) {
            return request('user-registrations/' + encodeURIComponent(id), { method: 'PUT', body: data });
        },
        deleteUserRegistration: function (id) {
            return request('user-registrations/' + encodeURIComponent(id), { method: 'DELETE' });
        },

        // Ocorrências (Waze)
        reports: function () { return request('reports'); },
        createReport: function (data) { return request('reports', { method: 'POST', body: data }); },
        occurrencesMap: function () { return request('occurrences?view=map'); },

        // Áreas de interesse
        areas: function () { return request('areas'); },
        createArea: function (data) { return request('areas', { method: 'POST', body: data }); },
        deleteArea: function (id) { return request('areas/' + id, { method: 'DELETE' }); },

        // Gestão por município
        gestao: function (municipio) { return request('gestao?municipio=' + encodeURIComponent(municipio)); },
        gestaoVisaoGeral: function () { return request('gestao?visao=geral'); },
        gestaoSalvar: function (municipio, secao, item) {
            return request('gestao', { method: 'POST', body: { municipio: municipio, secao: secao, item: item } });
        },
        gestaoRemover: function (municipio, secao, id) {
            return request('gestao?municipio=' + encodeURIComponent(municipio) + '&secao=' + encodeURIComponent(secao) + '&id=' + encodeURIComponent(id), { method: 'DELETE' });
        },

        // Notícias diárias (tempo, ações climáticas e Defesa Civil MT)
        noticias: function (n) { return request('noticias?n=' + (n || 6)); },

        // Alerta de pluviômetro (limiar e ativação são do servidor)
        pluvAlertaConfig: function () { return request('pluv-alerta'); },
        pluvAlertaSalvar: function (cfg) {
            return request('pluv-alerta', { method: 'POST', body: cfg });
        },
        pluvAlertaResetar: function () { return request('pluv-alerta', { method: 'DELETE' }); },
        pluvAlertaAvaliar: function (estacoes) {
            return request('pluv-alerta/avaliar', { method: 'POST', body: { estacoes: estacoes } });
        },

        // Utilidades
        getToken: token,
    };
})(window);
