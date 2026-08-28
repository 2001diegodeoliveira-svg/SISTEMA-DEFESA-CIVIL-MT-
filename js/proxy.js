/* ============================================================
   Cliente do proxy CORS — Defesa Civil MT.
   dcProxyFetch(url, opts) envia requisições a APIs externas via
   backend (/api/proxy), evitando bloqueios de CORS no navegador.
   Se o backend estiver indisponível, cai para fetch direto
   (mantendo funcionamento em hospedagem estática pura).
   ============================================================ */
(function (global) {
    var API_BASE = (typeof BACKEND_BASE !== 'undefined' && BACKEND_BASE) ? BACKEND_BASE : '';

    function proxyUrl(target) {
        return API_BASE + '/api/proxy?url=' + encodeURIComponent(target) + '&raw=' + (global.__DCPROXY_RAW ? '1' : '0');
    }

    function directFetch(url, opts) {
        return fetch(url, opts);
    }

    // Faz fetch via proxy; fallback direto se o proxy falhar.
    function dcProxyFetch(url, opts) {
        opts = opts || {};
        var proxied = proxyUrl(url);
        return fetch(proxied, {
            method: opts.method || 'GET',
            headers: opts.headers || {},
            body: opts.body || undefined,
        }).then(function (r) {
            if (r.ok) return r;
            // Proxy indisponível ou erro CORS: tenta direto
            return directFetch(url, opts);
        }).catch(function () {
            return directFetch(url, opts);
        });
    }

    // fetch + text() via proxy
    function dcProxyText(url, opts) {
        return dcProxyFetch(url, opts).then(function (r) { return r.text(); });
    }

    // fetch + json() via proxy
    function dcProxyJson(url, opts) {
        return dcProxyFetch(url, opts).then(function (r) { return r.json(); });
    }

    global.dcProxyFetch = dcProxyFetch;
    global.dcProxyText = dcProxyText;
    global.dcProxyJson = dcProxyJson;
})(window);
