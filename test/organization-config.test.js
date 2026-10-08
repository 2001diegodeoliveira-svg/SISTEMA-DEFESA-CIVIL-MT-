'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const organizacao = require('../js/organizacao');

test('organização nacional não declara código de UF nem limiares inventados', () => {
    assert.equal(organizacao.nacional.nivel, 'nacional');
    assert.equal(organizacao.nacional.codigoIbge, null);
    assert.equal(organizacao.nacional.limiares, null);
    assert.equal(organizacao.nacional.telefoneEmergencia, '199');
});

test('Mato Grosso permanece cadastrado com código IBGE estadual 51', () => {
    const mt = organizacao.organizacaoPorUf('51', [{ id: 51, sigla: 'MT', nome: 'Mato Grosso' }]);
    assert.equal(mt, organizacao.matoGrosso);
    assert.equal(mt.codigoIbge, '51');
    assert.equal(mt.nivel, 'estadual');
});

test('organizações estaduais são construídas a partir dos metadados do IBGE', () => {
    const estado = organizacao.criarOrganizacaoEstadual({ id: 32, sigla: 'ES', nome: 'Espírito Santo' });
    assert.equal(estado.id, 'uf-32');
    assert.equal(estado.nome, 'Espírito Santo');
    assert.equal(estado.codigoIbge, '32');
    assert.equal(estado.limiares, null);
    assert.equal(estado.mapa.centro, null);
});

test('códigos e metadados estaduais inválidos são rejeitados', () => {
    assert.equal(organizacao.normalizarCodigoUf('4'), '04');
    assert.equal(organizacao.organizacaoPorUf('99', []), organizacao.nacional);
    assert.throws(
        () => organizacao.criarOrganizacaoEstadual({ id: 999, sigla: 'XX', nome: 'UF falsa' }),
        /Dados de UF inválidos/
    );
});

test('aplicação de identidade usa texto, cores e logo definidos pela organização', () => {
    const propriedades = new Map();
    const texto = { textContent: '' };
    const logo = { src: '', alt: '' };
    const documento = {
        documentElement: { style: { setProperty: (key, value) => propriedades.set(key, value) } },
        querySelectorAll(seletor) {
            if (seletor === '[data-org-nome]') return [texto];
            if (seletor === '[data-org-logo]') return [logo];
            return [];
        }
    };
    organizacao.aplicarIdentidade(documento, organizacao.matoGrosso);
    assert.equal(texto.textContent, 'Defesa Civil de Mato Grosso');
    assert.equal(logo.alt, 'Defesa Civil de Mato Grosso');
    assert.equal(logo.src, 'imagens/logo.png');
    assert.equal(propriedades.get('--accent-orange'), organizacao.matoGrosso.cores.primaria);
});

test('navegação mantém a UF selecionada e remove o escopo ao voltar ao Brasil', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: {
            href: 'https://sgi.example/mapa.html?uf=51',
            origin: 'https://sgi.example',
            pathname: '/mapa.html'
        }
    });
    const link = { href: 'https://sgi.example/alertas.html?filtro=chuva' };
    const documento = {
        documentElement: { style: { setProperty() {} } },
        querySelectorAll(seletor) {
            return seletor === 'a[href]' ? [link] : [];
        }
    };

    try {
        organizacao.aplicarIdentidade(documento, organizacao.matoGrosso);
        let destino = new URL(link.href, 'https://sgi.example');
        assert.equal(destino.searchParams.get('uf'), '51');
        assert.equal(destino.searchParams.get('filtro'), 'chuva');

        organizacao.aplicarIdentidade(documento, organizacao.nacional);
        destino = new URL(link.href, 'https://sgi.example');
        assert.equal(destino.searchParams.has('uf'), false);
        assert.equal(destino.searchParams.get('filtro'), 'chuva');
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
        else delete globalThis.location;
    }
});
