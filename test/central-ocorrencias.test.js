'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { readCollection, writeCollection } = require('../api/_lib/store');
const { demoReset } = require('../api/_lib/demo');

const ocorrenciasHandler = require('../api/_routes/central/ocorrencias');
const ocorrenciaIdHandler = require('../api/_routes/central/ocorrencias/[id]');
const tiposHandler = require('../api/_routes/central/tipos');
const dashboardHandler = require('../api/_routes/central/dashboard');
const equipesHandler = require('../api/_routes/central/equipes');
const mobilizacoesHandler = require('../api/_routes/central/mobilizacoes');
const mobilizacaoIdHandler = require('../api/_routes/central/mobilizacoes/[id]');
const anexosHandler = require('../api/_routes/central/ocorrencias/[id]/anexos');

const ENV_KEYS = [
  'AUTH_LOGIN_ENABLED', 'DEMO_HORAS', 'JWT_SECRET', 'VERCEL', 'VERCEL_ENV',
  'NODE_ENV', 'FILE_STORE', 'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN',
];

const COLECOES = [
  'users', 'central_ocorrencias', 'central_tipos', 'central_danos',
  'central_historico', 'central_equipes', 'central_mobilizacoes',
  'central_anexos', 'audit_logs',
];

const USERS = [
  { id: 'U-ADMIN', usuario: 'admin', nome: 'Administrador', perfil: 'admin', municipio: '', ativo: true, bootstrapAdmin: true },
  { id: 'U-CUIABA', usuario: 'cuiaba', nome: 'Gestor Cuiabá', perfil: 'municipal', municipio: 'Cuiabá', ativo: true },
  { id: 'U-SINOP', usuario: 'sinop', nome: 'Gestor Sinop', perfil: 'municipal', municipio: 'Sinop', ativo: true },
  { id: 'U-COMUM', usuario: 'comum', nome: 'Cidadão', perfil: 'comum', municipio: 'Cuiabá', ativo: true },
];

function request(method, path, { token, body } = {}) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`http://localhost/api/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function tokenFor(id) {
  const user = USERS.find((u) => u.id === id);
  return jwt.sign({ sub: id, usuario: user.usuario, perfil: user.perfil, mfa: true }, process.env.JWT_SECRET);
}

async function prepararAmbiente() {
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'preview';
  process.env.NODE_ENV = 'test';
  process.env.FILE_STORE = '0';
  delete process.env.DATABASE_URL;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.AUTH_LOGIN_ENABLED = 'true';
  process.env.DEMO_HORAS = '0';
  process.env.JWT_SECRET = 'dc-mt-dev-secret-change-me';
  demoReset();
  const backup = new Map();
  for (const nome of COLECOES) backup.set(nome, await readCollection(nome));
  await writeCollection('users', USERS.map((u) => ({ ...u })));
  await writeCollection('central_tipos', []);
  for (const nome of ['central_ocorrencias', 'central_danos', 'central_historico',
    'central_equipes', 'central_mobilizacoes', 'central_anexos', 'audit_logs']) {
    await writeCollection(nome, []);
  }
  return backup;
}

async function restaurarAmbiente(backup, previousEnv) {
  for (const [nome, valor] of backup) await writeCollection(nome, valor);
  for (const [chave, valor] of previousEnv) {
    if (valor === undefined) delete process.env[chave];
    else process.env[chave] = valor;
  }
  demoReset();
}

function salvarEnv() {
  return new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
}

test('Central exige autenticação e perfil operacional, e o cadastro gera protocolo e histórico', async () => {
  const previousEnv = salvarEnv();
  let backup = null;
  try {
    backup = await prepararAmbiente();

    const anonimo = await ocorrenciasHandler(request('GET', 'central/ocorrencias'));
    assert.equal(anonimo.status, 401);

    const comum = await ocorrenciasHandler(request('GET', 'central/ocorrencias', { token: tokenFor('U-COMUM') }));
    assert.equal(comum.status, 403);

    const token = tokenFor('U-ADMIN');

    const semTipo = await ocorrenciasHandler(request('POST', 'central/ocorrencias', {
      token,
      body: { titulo: 'Alagamento na rua central', descricao: 'Água subiu cerca de meio metro na via principal.' },
    }));
    assert.equal(semTipo.status, 400);

    const tipoInvalido = await ocorrenciasHandler(request('POST', 'central/ocorrencias', {
      token,
      body: {
        titulo: 'Evento não catalogado', descricao: 'Descrição suficientemente longa para a validação.',
        tipo: 'METEORO', municipio: 'Cuiabá',
      },
    }));
    assert.equal(tipoInvalido.status, 400);

    const coordenadaInvalida = await ocorrenciasHandler(request('POST', 'central/ocorrencias', {
      token,
      body: {
        titulo: 'Alagamento na rua central', descricao: 'Água subiu cerca de meio metro na via principal.',
        tipo: 'ALAGAMENTO', municipio: 'Cuiabá', latitude: 999, longitude: -56.1,
      },
    }));
    assert.equal(coordenadaInvalida.status, 400);

    const criada = await ocorrenciasHandler(request('POST', 'central/ocorrencias', {
      token,
      body: {
        titulo: 'Alagamento na rua central',
        descricao: 'Água subiu cerca de meio metro na via principal após chuva forte.',
        tipo: 'ALAGAMENTO',
        municipio: 'Cuiabá',
        bairro: 'Centro',
        endereco: 'Rua Central, 100',
        latitude: -15.6014,
        longitude: -56.0979,
        pessoasAfetadas: 25,
        necessidades: 'Abrigo e água potável.',
        danos: { residenciasAtingidas: 4, desalojados: 12, pessoasAfetadas: 25 },
      },
    }));
    assert.equal(criada.status, 201);
    const ocorrencia = (await criada.json()).ocorrencia;
    assert.match(ocorrencia.protocolo, /^OC-\d{4}-\d{6}$/);
    assert.equal(ocorrencia.tipo, 'ALAGAMENTO');
    assert.equal(ocorrencia.status, 'REGISTRADA');
    assert.equal(ocorrencia.verificacao, 'RELATADA');
    assert.equal(ocorrencia.municipio, 'Cuiabá');
    assert.equal(ocorrencia.pessoasAfetadas, 25);
    assert.ok(['MODERADA', 'ALTA', 'CRITICA'].includes(ocorrencia.prioridade));
    assert.equal(ocorrencia.danos.desalojados, 12);
    assert.equal(ocorrencia.historico.length, 1);
    assert.equal(ocorrencia.historico[0].statusNovo, 'REGISTRADA');
    assert.match(ocorrencia.historico[0].nota, /Registro inicial/);

    const segunda = await ocorrenciasHandler(request('POST', 'central/ocorrencias', {
      token,
      body: {
        titulo: 'Queda de árvore bloqueia avenida',
        descricao: 'Árvore de grande porte caiu sobre a pista e interditou uma faixa.',
        tipo: 'QUEDA_ARVORE',
        municipio: 'Sinop',
        prioridade: 'ALTA',
      },
    }));
    assert.equal(segunda.status, 201);
    const segundaOcorrencia = (await segunda.json()).ocorrencia;
    assert.notEqual(segundaOcorrencia.protocolo, ocorrencia.protocolo);
    assert.equal(segundaOcorrencia.prioridade, 'ALTA');

    /* Dados restritos não vazam na criação/listagem pública interna. */
    assert.equal(Object.hasOwn(ocorrencia, 'dadosRestritos'), false);

    /* Gestor municipal só vê e altera o próprio município. */
    const tokenCuiaba = tokenFor('U-CUIABA');
    const listaCuiaba = await ocorrenciasHandler(request('GET', 'central/ocorrencias', { token: tokenCuiaba }));
    const dadosCuiaba = await listaCuiaba.json();
    assert.ok(dadosCuiaba.ocorrencias.length >= 1);

    const detalheOutro = await ocorrenciaIdHandler(
      request('GET', `central/ocorrencias/${segundaOcorrencia.id}`, { token: tokenCuiaba })
    );
    assert.equal(detalheOutro.status, 403);

    const criarOutroMunicipio = await ocorrenciasHandler(request('POST', 'central/ocorrencias', {
      token: tokenCuiaba,
      body: {
        titulo: 'Registro indevido em outro município',
        descricao: 'Tentativa de gravar fora do escopo municipal autorizado.',
        tipo: 'ALAGAMENTO',
        municipio: 'Sinop',
      },
    }));
    assert.equal(criarOutroMunicipio.status, 403);

    /* Atualização de status exige justificativa em conclusão e audita. */
    const semJustificativa = await ocorrenciaIdHandler(
      request('PATCH', `central/ocorrencias/${ocorrencia.id}`, { token, body: { status: 'CONCLUIDA' } })
    );
    assert.equal(semJustificativa.status, 400);

    const concluida = await ocorrenciaIdHandler(request('PATCH', `central/ocorrencias/${ocorrencia.id}`, {
      token,
      body: { status: 'CONCLUIDA', justificativa: 'Rua liberada e famílias realocadas com apoio do município.' },
    }));
    assert.equal(concluida.status, 200);
    const atualizada = (await concluida.json()).ocorrencia;
    assert.equal(atualizada.status, 'CONCLUIDA');
    assert.ok(atualizada.encerradaEm);
    const ultimoHistorico = atualizada.historico[atualizada.historico.length - 1];
    assert.equal(ultimoHistorico.statusNovo, 'CONCLUIDA');
    assert.match(ultimoHistorico.nota, /Rua liberada/);
    assert.equal(ultimoHistorico.usuarioId, 'U-ADMIN');

    const repetido = await ocorrenciaIdHandler(
      request('PATCH', `central/ocorrencias/${ocorrencia.id}`, { token, body: { status: 'CONCLUIDA' } })
    );
    assert.equal(repetido.status, 400);

    const prioridade = await ocorrenciaIdHandler(request('PATCH', `central/ocorrencias/${ocorrencia.id}`, {
      token,
      body: { prioridade: 'CRITICA' },
    }));
    assert.equal(prioridade.status, 200);
    const comPrioridade = (await prioridade.json()).ocorrencia;
    assert.equal(comPrioridade.prioridade, 'CRITICA');
    assert.ok(comPrioridade.prioridadeRevisadaEm);

    const logs = await readCollection('audit_logs');
    assert.ok(logs.some((l) => l.action === 'ocorrencia_criada'));
    assert.ok(logs.some((l) => l.action === 'ocorrencia_status_atualizado'));
  } finally {
    await restaurarAmbiente(backup, previousEnv);
  }
});

test('roteador exige autenticação para a Central (sem token → 401)', async () => {
  const previousEnv = salvarEnv();
  let backup = null;
  try {
    backup = await prepararAmbiente();
    const apiHandler = require('../api/index');

    const lista = await apiHandler(request('GET', 'central/ocorrencias'));
    assert.equal(lista.status, 401);

    const dashboard = await apiHandler(request('GET', 'central/dashboard'));
    assert.equal(dashboard.status, 401);

    const tipos = await apiHandler(request('GET', 'central/tipos'));
    assert.equal(tipos.status, 401);

    const criada = await apiHandler(request('POST', 'central/ocorrencias', {
      body: {
        titulo: 'Inundação em área ribeirinha',
        descricao: 'Nível do rio subiu e atingiu residências próximas à margem.',
        tipo: 'INUNDACAO',
        municipio: 'Cuiabá',
      },
    }));
    assert.equal(criada.status, 401);
  } finally {
    await restaurarAmbiente(backup, previousEnv);
  }
});

test('catálogo de tipos, dashboard e gestão de equipes/mobilizações/anexos funcionam juntos', async () => {
  const previousEnv = salvarEnv();
  let backup = null;
  try {
    backup = await prepararAmbiente();
    const token = tokenFor('U-ADMIN');

    const tipos = await tiposHandler(request('GET', 'central/tipos', { token }));
    assert.equal(tipos.status, 200);
    const catalogo = (await tipos.json()).tipos;
    assert.equal(catalogo.length, 17);
    assert.ok(catalogo.some((t) => t.codigo === 'ALAGAMENTO'));

    const novo = await tiposHandler(request('POST', 'central/tipos', {
      token,
      body: { codigo: 'DESABAMENTO', nome: 'Desabamento', grupo: 'estrutural', ordem: 155 },
    }));
    assert.equal(novo.status, 201);
    assert.equal((await novo.json()).tipo.codigo, 'DESABAMENTO');

    const duplicado = await tiposHandler(request('POST', 'central/tipos', {
      token,
      body: { codigo: 'DESABAMENTO', nome: 'Desabamento', grupo: 'estrutural' },
    }));
    assert.equal(duplicado.status, 409);

    const municipal = await tiposHandler(request('POST', 'central/tipos', {
      token: tokenFor('U-CUIABA'),
      body: { codigo: 'TESTE', nome: 'Tipo de teste', grupo: 'outros' },
    }));
    assert.equal(municipal.status, 201);

    const ocorrenciaResponse = await ocorrenciasHandler(request('POST', 'central/ocorrencias', {
      token,
      body: {
        titulo: 'Desabamento parcial de residência',
        descricao: 'Telhado cedeu após vendaval; moradores deixaram o imóvel.',
        tipo: 'DESABAMENTO',
        municipio: 'Cuiabá',
        pesoInvalido: 1,
        danos: { residenciasAtingidas: 1, desabrigados: 3, pessoasAfetadas: 3 },
      },
    }));
    assert.equal(ocorrenciaResponse.status, 201);
    const ocorrencia = (await ocorrenciaResponse.json()).ocorrencia;

    const equipeResponse = await equipesHandler(request('POST', 'central/equipes', {
      token,
      body: { nome: 'Equipe Alfa', tipo: 'resgate', responsavel: 'Coordenador', contato: '65999999999' },
    }));
    assert.equal(equipeResponse.status, 201);
    const equipe = (await equipeResponse.json()).equipe;

    const mobilizacaoResponse = await mobilizacoesHandler(request('POST', 'central/mobilizacoes', {
      token,
      body: {
        equipeId: equipe.id,
        ocorrenciaId: ocorrencia.id,
        atividades: 'Deslocamento para vistoria e apoio aos moradores.',
        recursos: { viaturas: 1 },
      },
    }));
    assert.equal(mobilizacaoResponse.status, 201);
    const mobilizacao = (await mobilizacaoResponse.json()).mobilizacao;

    const chegada = await mobilizacaoIdHandler(request('PATCH', `central/mobilizacoes/${mobilizacao.id}`, {
      token,
      body: { status: 'no_local', atividades: 'Equipe no local, isolamento iniciado.' },
    }));
    assert.equal(chegada.status, 200);
    const mobilizacaoAtualizada = (await chegada.json()).mobilizacao;
    assert.equal(mobilizacaoAtualizada.status, 'no_local');
    assert.ok(mobilizacaoAtualizada.chegadaEm);

    const anexoResponse = await anexosHandler(request('POST', `central/ocorrencias/${ocorrencia.id}/anexos`, {
      token,
      body: { nome: 'foto-fachada.jpg', mimeType: 'image/jpeg', url: 'https://exemplo.invalid/foto.jpg', tamanhoBytes: 2048 },
    }));
    assert.equal(anexoResponse.status, 201);

    const anexoInvalido = await anexosHandler(request('POST', `central/ocorrencias/${ocorrencia.id}/anexos`, {
      token,
      body: { nome: 'script.js', mimeType: 'text/javascript', url: 'javascript:alert(1)' },
    }));
    assert.equal(anexoInvalido.status, 400);

    const dashboard = await dashboardHandler(request('GET', 'central/dashboard', { token }));
    assert.equal(dashboard.status, 200);
    const indicadores = (await dashboard.json()).indicadores;
    assert.equal(indicadores.total, 1);
    assert.equal(indicadores.emAndamento, 1);
    assert.equal(indicadores.desabrigados, 3);
    assert.equal(indicadores.equipesMobilizadas, 1);
    assert.deepEqual(indicadores.porTipo.map((t) => t.chave), ['DESABAMENTO']);

    const detalhe = await ocorrenciaIdHandler(request('GET', `central/ocorrencias/${ocorrencia.id}`, { token }));
    const detalheOcorrencia = (await detalhe.json()).ocorrencia;
    assert.equal(detalheOcorrencia.anexos.length, 1);
    assert.equal(detalheOcorrencia.mobilizacoes.length, 1);
    assert.equal(detalheOcorrencia.danos.desabrigados, 3);
  } finally {
    await restaurarAmbiente(backup, previousEnv);
  }
});
