(function (global) {
    'use strict';

    const IBGE_BASE = 'https://servicodados.ibge.gov.br/api/v1/localidades';
    const MALHAS_BASE = 'https://servicodados.ibge.gov.br/api/v3/malhas';
    const CORES_PADRAO = Object.freeze({
        primaria: '#f9631c',
        secundaria: '#38bdf8',
        fundo: '#0f172a',
        texto: '#f1f5f9'
    });

    const ORGANIZACAO_NACIONAL = Object.freeze({
        id: 'brasil',
        nome: 'SGI PROTEGE Brasil',
        sigla: 'BR',
        nivel: 'nacional',
        codigoIbge: null,
        uf: null,
        logo: null,
        cores: CORES_PADRAO,
        mapa: Object.freeze({ centro: [-14.235004, -51.92528], zoom: 4 }),
        telefoneEmergencia: '199',
        limiares: null
    });

    const ORGANIZACAO_MT = Object.freeze({
        id: 'mato-grosso',
        nome: 'Defesa Civil de Mato Grosso',
        sigla: 'MT',
        nivel: 'estadual',
        codigoIbge: '51',
        uf: 'MT',
        logo: null,
        cores: CORES_PADRAO,
        mapa: Object.freeze({ centro: [-13, -56], zoom: 5 }),
        telefoneEmergencia: '199',
        limiares: null
    });

    let estadosPromise = null;
    let municipiosNacionaisPromise = null;
    let malhaEstadosPromise = null;
    const malhasMunicipaisPorUf = new Map();

    function normalizarCodigoUf(codigo) {
        const valor = String(codigo == null ? '' : codigo).trim().toUpperCase();
        if (/^\d{1,2}$/.test(valor)) return valor.padStart(2, '0');
        return valor;
    }

    function criarOrganizacaoEstadual(estado) {
        if (!estado || !/^\d{1,2}$/.test(String(estado.id)) ||
            !/^[A-Z]{2}$/.test(String(estado.sigla || '').toUpperCase()) ||
            !String(estado.nome || '').trim()) {
            throw new TypeError('Dados de UF inválidos recebidos do IBGE.');
        }

        const codigoIbge = String(estado.id).padStart(2, '0');
        const sigla = String(estado.sigla).toUpperCase();
        if (codigoIbge === ORGANIZACAO_MT.codigoIbge) return ORGANIZACAO_MT;

        return Object.freeze({
            id: 'uf-' + codigoIbge,
            nome: String(estado.nome).trim(),
            sigla,
            nivel: 'estadual',
            codigoIbge,
            uf: sigla,
            logo: null,
            cores: CORES_PADRAO,
            // O mapa enquadra a malha oficial da UF; não estimamos centros por coordenadas fixas.
            mapa: Object.freeze({ centro: null, zoom: 6 }),
            telefoneEmergencia: '199',
            limiares: null
        });
    }

    function organizacaoPorUf(codigo, estados) {
        const uf = normalizarCodigoUf(codigo);
        if (!uf) return ORGANIZACAO_NACIONAL;

        const estado = (estados || []).find(function (item) {
            return normalizarCodigoUf(item.id) === uf ||
                String(item.sigla || '').toUpperCase() === uf;
        });
        return estado ? criarOrganizacaoEstadual(estado) : ORGANIZACAO_NACIONAL;
    }

    async function obterOrganizacaoInicial() {
        const codigo = obterUfInicial();
        if (!codigo) return ORGANIZACAO_NACIONAL;
        if (codigo === ORGANIZACAO_MT.codigoIbge || codigo === ORGANIZACAO_MT.uf) return ORGANIZACAO_MT;
        return organizacaoPorUf(codigo, await obterEstados());
    }

    async function buscarJson(url) {
        const requisitar = global.dcProxyFetch || global.fetch;
        if (typeof requisitar !== 'function') {
            throw new Error('Não há um serviço de rede disponível para consultar o IBGE.');
        }

        const resposta = await requisitar(url);
        if (!resposta || !resposta.ok) {
            const status = resposta && Number.isFinite(resposta.status) ? ' (' + resposta.status + ')' : '';
            throw new Error('O IBGE não respondeu à consulta' + status + '.');
        }
        return resposta.json();
    }

    function validarLista(valor, descricao) {
        if (!Array.isArray(valor)) throw new Error('Resposta inválida do IBGE: ' + descricao + '.');
        return valor;
    }

    function validarMalha(valor, descricao) {
        if (!valor || valor.type !== 'FeatureCollection' || !Array.isArray(valor.features)) {
            throw new Error('Malha territorial inválida recebida do IBGE: ' + descricao + '.');
        }
        return valor;
    }

    function obterEstados() {
        if (!estadosPromise) {
            estadosPromise = buscarJson(IBGE_BASE + '/estados?orderBy=nome')
                .then(function (valor) {
                    return validarLista(valor, 'lista de estados').filter(function (estado) {
                        return estado && /^\d{1,2}$/.test(String(estado.id)) &&
                            /^[A-Z]{2}$/.test(String(estado.sigla || '').toUpperCase()) &&
                            String(estado.nome || '').trim();
                    }).sort(function (a, b) {
                        return String(a.nome).localeCompare(String(b.nome), 'pt-BR');
                    });
                })
                .catch(function (erro) {
                    estadosPromise = null;
                    throw erro;
                });
        }
        return estadosPromise;
    }

    function obterMunicipios(codigoUf) {
        const uf = normalizarCodigoUf(codigoUf);
        if (!/^\d{2}$/.test(uf)) {
            return Promise.reject(new TypeError('Informe o código IBGE de dois dígitos da UF.'));
        }
        return buscarJson(IBGE_BASE + '/estados/' + encodeURIComponent(uf) + '/municipios?orderBy=nome')
            .then(function (valor) {
                return validarLista(valor, 'municípios da UF').filter(function (municipio) {
                    return municipio && /^\d{7}$/.test(String(municipio.id)) &&
                        String(municipio.nome || '').trim();
                }).sort(function (a, b) {
                    return String(a.nome).localeCompare(String(b.nome), 'pt-BR');
                });
            });
    }

    function obterTotalMunicipios() {
        if (!municipiosNacionaisPromise) {
            municipiosNacionaisPromise = buscarJson(IBGE_BASE + '/municipios?orderBy=nome')
                .then(function (valor) {
                    return validarLista(valor, 'lista nacional de municípios').filter(function (municipio) {
                        return municipio && /^\d{7}$/.test(String(municipio.id));
                    }).length;
                })
                .catch(function (erro) {
                    municipiosNacionaisPromise = null;
                    throw erro;
                });
        }
        return municipiosNacionaisPromise;
    }

    function obterMalhaEstados() {
        if (!malhaEstadosPromise) {
            const url = MALHAS_BASE + '/estados?formato=application/vnd.geo+json&qualidade=minima';
            malhaEstadosPromise = buscarJson(url)
                .then(function (valor) {
                    return validarMalha(valor, 'estados');
                })
                .catch(function (erro) {
                    malhaEstadosPromise = null;
                    throw erro;
                });
        }
        return malhaEstadosPromise;
    }

    function obterMalhaMunicipios(codigoUf) {
        const uf = normalizarCodigoUf(codigoUf);
        if (!/^\d{2}$/.test(uf)) {
            return Promise.reject(new TypeError('Informe o código IBGE de dois dígitos da UF.'));
        }
        if (!malhasMunicipaisPorUf.has(uf)) {
            const url = MALHAS_BASE + '/estados/' + encodeURIComponent(uf) +
                '?formato=application/vnd.geo+json&intrarregiao=municipio&qualidade=minima';
            const malhaPromise = buscarJson(url)
                .then(function (valor) {
                    return validarMalha(valor, 'municípios da UF');
                })
                .catch(function (erro) {
                    malhasMunicipaisPorUf.delete(uf);
                    throw erro;
                });
            malhasMunicipaisPorUf.set(uf, malhaPromise);
        }
        return malhasMunicipaisPorUf.get(uf);
    }

    function obterUfInicial() {
        if (typeof global.location === 'undefined') return '';
        return normalizarCodigoUf(new URLSearchParams(global.location.search).get('uf'));
    }

    function aplicarIdentidade(documento, organizacao) {
        if (!documento || !organizacao) return;
        documento.querySelectorAll('[data-org-nome]').forEach(function (elemento) {
            elemento.textContent = organizacao.nome;
        });
        documento.querySelectorAll('[data-org-sigla]').forEach(function (elemento) {
            elemento.textContent = organizacao.sigla;
        });
        documento.querySelectorAll('[data-emergency-phone]').forEach(function (elemento) {
            elemento.textContent = organizacao.telefoneEmergencia || '199';
        });
        documento.querySelectorAll('[data-org-logo]').forEach(function (elemento) {
            elemento.src = organizacao.logo || 'imagens/logo.png';
            elemento.alt = organizacao.nome;
        });
        if (typeof global.location !== 'undefined') {
            documento.querySelectorAll('a[href]').forEach(function (link) {
                const destino = new URL(link.href, global.location.href);
                if (destino.origin !== global.location.origin ||
                    !/\.html?$/i.test(destino.pathname) ||
                    destino.pathname === global.location.pathname) return;
                if (organizacao.nivel === 'estadual' && organizacao.codigoIbge) {
                    destino.searchParams.set('uf', organizacao.codigoIbge);
                } else {
                    destino.searchParams.delete('uf');
                }
                link.href = destino.pathname + destino.search + destino.hash;
            });
        }
        if (documento.documentElement && organizacao.cores) {
            documento.documentElement.style.setProperty('--accent-orange', organizacao.cores.primaria);
            documento.documentElement.style.setProperty('--blue-glow', organizacao.cores.secundaria);
        }
    }

    const api = Object.freeze({
        nacional: ORGANIZACAO_NACIONAL,
        matoGrosso: ORGANIZACAO_MT,
        normalizarCodigoUf,
        criarOrganizacaoEstadual,
        organizacaoPorUf,
        obterOrganizacaoInicial,
        obterEstados,
        obterMunicipios,
        obterTotalMunicipios,
        obterMalhaEstados,
        obterMalhaMunicipios,
        obterUfInicial,
        aplicarIdentidade
    });

    global.DC_ORGANIZACAO = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
