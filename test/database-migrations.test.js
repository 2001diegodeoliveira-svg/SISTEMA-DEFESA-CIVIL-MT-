'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { applyMigrations, MIGRATIONS_DIR } = require('../db/migrate-versioned');
const {
  carregarCatalogoIbge,
  carregarCatalogoPersistido
} = require('../db/seed-organizations');

function catalogoValido() {
  const codigos = [
    11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    31, 32, 33, 35, 41, 42, 43, 50, 51, 52, 53
  ];
  const estados = codigos.map(codigo => ({
    id: codigo,
    sigla: `U${codigo}`,
    nome: `Estado ${codigo}`
  }));
  estados[codigos.indexOf(51)] = { id: 51, sigla: 'MT', nome: 'Mato Grosso' };
  const municipios = [
    { id: 5100102, nome: 'Acorizal' },
    { id: 5100201, nome: 'Água Boa' }
  ];
  return { estados, municipios };
}

test('catálogo oficial valida as 27 UFs e somente municípios com códigos IBGE de MT', async () => {
  const catalogo = catalogoValido();
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    return {
      ok: true,
      json: async () => url.endsWith('/estados?orderBy=id') ? catalogo.estados : catalogo.municipios
    };
  };

  const result = await carregarCatalogoIbge(fetchImpl);

  assert.equal(result.estados.length, 27);
  assert.deepEqual(result.municipios.map(item => item.codigo), ['5100102', '5100201']);
  assert.ok(urls.every(url => url.startsWith('https://servicodados.ibge.gov.br/api/v1/localidades/')));
});

test('catálogo incompleto ou com códigos inválidos é rejeitado', async () => {
  const catalogo = catalogoValido();
  catalogo.estados.pop();
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.endsWith('/estados?orderBy=id') ? catalogo.estados : catalogo.municipios
  });

  await assert.rejects(carregarCatalogoIbge(fetchImpl), /incompleto ou inválido/);
});

test('fallback exige catálogo IBGE previamente gravado e completo', async () => {
  const rows = catalogoValido().estados.map(estado => ({
    id: `UF-${String(estado.id).padStart(2, '0')}`,
    codigo_ibge: String(estado.id).padStart(2, '0'),
    nome: estado.nome,
    sigla: estado.sigla,
    nivel: 'estadual',
    parent_id: 'BR'
  }));
  rows.push({
    id: 'MUN-5100102',
    codigo_ibge: '5100102',
    nome: 'Acorizal',
    nivel: 'municipal',
    parent_id: 'UF-51'
  });
  const result = await carregarCatalogoPersistido({
    query: async () => ({ rows })
  });
  assert.equal(result.estados.length, 27);
  assert.equal(result.estados.find(estado => estado.codigo === '51').sigla, 'MT');
  assert.deepEqual(result.municipios, [{ codigo: '5100102', nome: 'Acorizal' }]);
  await assert.rejects(
    carregarCatalogoPersistido({ query: async () => ({ rows: [] }) }),
    /previamente validado e completo/
  );
});

test('migrações são versionadas por checksum e aplicadas dentro de transação', async () => {
  const aplicada = new Map();
  const log = [];
  const client = {
    async query(sql, params = []) {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (sql.includes('SELECT checksum FROM schema_migrations')) {
        const checksum = aplicada.get(params[0]);
        return checksum ? { rowCount: 1, rows: [{ checksum }] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO schema_migrations')) {
        aplicada.set(params[0], params[1]);
      }
      return { rowCount: 0, rows: [] };
    }
  };

  await applyMigrations(client);

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(file => file.endsWith('.sql'));
  assert.equal(files.length, 2);
  for (const file of files) {
    const version = file.slice(0, -4);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    assert.equal(aplicada.get(version), crypto.createHash('sha256').update(sql).digest('hex'));
  }
  assert.equal(log.filter(line => line === 'BEGIN').length, 2);
  assert.equal(log.filter(line => line === 'COMMIT').length, 2);
  const rbacMigration = fs.readFileSync(
    path.join(MIGRATIONS_DIR, '000000000002_rbac_mfa_rls.sql'),
    'utf8'
  );
  for (const table of ['usuarios', 'solicitacoes_usuarios', 'usuario_mfa', 'convites_usuarios', 'usuario_organizacao_papel']) {
    assert.match(rbacMigration, new RegExp(`ALTER TABLE ${table}[\\s\\S]*?FORCE ROW LEVEL SECURITY`));
  }
  assert.match(rbacMigration, /CREATE POLICY auditoria_log_immutable_insert/);
  assert.ok(log.includes('SELECT pg_advisory_unlock(73104211)'));

  const countBeforeRerun = log.length;
  await applyMigrations(client);
  assert.equal(log.filter(line => line === 'BEGIN').length, 2);
  assert.ok(log.length > countBeforeRerun);
});

test('DDL define histórico de ocorrência, escopo organizacional e modelos da Fase 2', () => {
  const migration = fs.readFileSync(
    path.join(MIGRATIONS_DIR, '000000000001_multi_organization.sql'),
    'utf8'
  );
  for (const table of [
    'organizacoes', 'papeis', 'usuario_organizacao_papel', 'territorios',
    'ocorrencias', 'ocorrencia_historico', 'alertas', 'alerta_ciente',
    'eventos', 'recursos', 'pedidos_apoio', 'cameras', 'fontes_dados', 'auditoria_log'
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}\\s*\\(`));
  }
  for (const status of ['aberta', 'em_atendimento', 'escalada', 'apoio_solicitado', 'encerrada']) {
    assert.match(migration, new RegExp(`'${status}'`));
  }
  assert.match(migration, /USING GIST/);
  assert.match(migration, /AFTER INSERT OR UPDATE OF status ON ocorrencias/);
});
