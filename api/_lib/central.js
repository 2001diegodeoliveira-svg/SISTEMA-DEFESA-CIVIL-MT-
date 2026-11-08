/* ============================================================
   Central de Ocorrências — regras de negócio e acesso a dados.
   Compartilhado pelas rotas /api/central/*.

   Modos:
   - PostgreSQL (produção): tabela `ocorrencias` (migração 001 + 003),
     com PostGIS, escopo organizacional por RLS e histórico por trigger.
   - Arquivo/memória (desenvolvimento, testes): coleções `central_*`.

   Nunca inventa dado: classificação sugerida é heurística explicitada em
   `motivos` e só vale depois de confirmação de um operador.
   ============================================================ */
'use strict';

const crypto = require('node:crypto');
const { readCollection, writeCollection, push, getPool, inTx, driver, loadUserAccess } = require('./store');
const { MUNICIPIOS_MT } = require('./municipios');
const { bearerToken, jsonResponse } = require('./http');
const { verifyToken } = require('./auth');

/* ---------------- domínios ---------------- */

const STATUS = {
  REGISTRADA: 'registrada',
  EM_TRIAGEM: 'em_triagem',
  EM_AVALIACAO: 'em_avaliacao',
  AGUARDANDO_MOBILIZACAO: 'aguardando_mobilizacao',
  EQUIPE_MOBILIZADA: 'equipe_mobilizada',
  EM_ATENDIMENTO: 'em_atendimento',
  MONITORAMENTO: 'monitoramento',
  CONCLUIDA: 'concluida',
  ARQUIVADA: 'arquivada',
};
const STATUS_VALIDOS = Object.keys(STATUS);
/* Estados legados somente para leitura de registros antigos. */
const STATUS_LEITURA = [...STATUS_VALIDOS, 'ESCALADA'];
const STATUS_FINAIS = new Set(['CONCLUIDA', 'ARQUIVADA']);

const PRIORIDADES = ['BAIXA', 'MODERADA', 'ALTA', 'CRITICA'];
const VERIFICACOES = ['ALERTA', 'SUSPEITA', 'RELATADA', 'CONFIRMADA'];
const GRUPOS_TIPO = ['hidrologico', 'geologico', 'meteorologico', 'biologico', 'tecnologico', 'estrutural', 'outros'];
const MOBILIZACAO_STATUS = ['mobilizada', 'em_deslocamento', 'no_local', 'retornando', 'encerrada'];

const TIPOS_SEED = [
  ['ALAGAMENTO', 'Alagamento', 'hidrologico', 10],
  ['INUNDACAO', 'Inundação', 'hidrologico', 20],
  ['ENXURRADA', 'Enxurrada', 'hidrologico', 30],
  ['DESLIZAMENTO', 'Deslizamento', 'geologico', 40],
  ['DESMORONAMENTO', 'Desmoronamento', 'geologico', 50],
  ['VENDAVAL', 'Vendaval', 'meteorologico', 60],
  ['TEMPESTADE_SEVERA', 'Tempestade severa', 'meteorologico', 70],
  ['GRANIZO', 'Granizo', 'meteorologico', 80],
  ['ESTIAGEM', 'Estiagem', 'meteorologico', 90],
  ['SECA', 'Seca', 'meteorologico', 100],
  ['INCENDIO_FLORESTAL', 'Incêndio florestal', 'biologico', 110],
  ['QUEIMADA', 'Queimada', 'biologico', 120],
  ['ROMPIMENTO_ESTRUTURA', 'Rompimento de estrutura', 'tecnologico', 130],
  ['QUEDA_ARVORE', 'Queda de árvore', 'outros', 140],
  ['DANOS_ESTRUTURAIS', 'Danos estruturais', 'estrutural', 150],
  ['EROSAO', 'Erosão', 'geologico', 160],
  ['OUTROS', 'Outros eventos adversos', 'outros', 999],
];

/* Tipos com potencial de dano grave quando confirmados. */
const TIPOS_GRAVES = new Set([
  'DESLIZAMENTO', 'DESMORONAMENTO', 'INUNDACAO', 'ROMPIMENTO_ESTRUTURA',
  'INCENDIO_FLORESTAL', 'TEMPESTADE_SEVERA',
]);

const COL = {
  ocorrencias: 'central_ocorrencias',
  tipos: 'central_tipos',
  danos: 'central_danos',
  historico: 'central_historico',
  equipes: 'central_equipes',
  mobilizacoes: 'central_mobilizacoes',
  anexos: 'central_anexos',
};

/* ---------------- erros e utilidades ---------------- */

function erro(statusCode, mensagem, codigo = 'ERRO') {
  const e = new Error(mensagem);
  e.statusCode = statusCode;
  e.code = codigo;
  return e;
}

function pg() {
  return driver() === 'pg';
}

function texto(valor, { campo, min = 0, max = 500, obrigatorio = false }) {
  if (valor === undefined || valor === null) {
    if (obrigatorio) throw erro(400, `Campo obrigatório: ${campo}.`, 'CAMPO_OBRIGATORIO');
    return '';
  }
  if (typeof valor !== 'string') throw erro(400, `Campo ${campo} deve ser texto.`, 'CAMPO_INVALIDO');
  const limpo = valor.trim();
  if (limpo.length < min) {
    throw erro(400, `Campo ${campo} deve ter ao menos ${min} caracteres.`, 'CAMPO_INVALIDO');
  }
  if (limpo.length > max) {
    throw erro(400, `Campo ${campo} excede ${max} caracteres.`, 'CAMPO_INVALIDO');
  }
  return limpo;
}

function inteiroNaoNegativo(valor, { campo, max = 1000000 } = {}) {
  if (valor === undefined || valor === null || valor === '') return 0;
  if (typeof valor === 'string' && !/^\d+$/.test(valor.trim())) {
    throw erro(400, `Campo ${campo} deve ser inteiro não negativo.`, 'CAMPO_INVALIDO');
  }
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw erro(400, `Campo ${campo} deve ser inteiro entre 0 e ${max}.`, 'CAMPO_INVALIDO');
  }
  return n;
}

function numeroFinito(valor, { campo, min, max } = {}) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw erro(400, `Campo ${campo} fora da faixa permitida (${min} a ${max}).`, 'CAMPO_INVALIDO');
  }
  return n;
}

function enumDe(valor, lista, campo) {
  const v = String(valor || '').trim().toUpperCase();
  if (!lista.includes(v)) {
    throw erro(400, `Campo ${campo} inválido. Valores aceitos: ${lista.join(', ')}.`, 'CAMPO_INVALIDO');
  }
  return v;
}

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function toMs(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'number') return valor;
  if (valor instanceof Date) return valor.getTime();
  const t = Date.parse(valor);
  return Number.isFinite(t) ? t : null;
}

function isoOuNull(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const t = Date.parse(valor);
  if (!Number.isFinite(t)) throw erro(400, 'Data inválida.', 'CAMPO_INVALIDO');
  return new Date(t).toISOString();
}

function uuidValido(valor) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(valor || ''));
}

/* ---------------- municípios ---------------- */

let municipiosCache = null;

async function listarMunicipios() {
  if (municipiosCache) return municipiosCache;
  if (pg()) {
    const { rows } = await getPool().query('SELECT id, nome, codigo_ibge FROM municipios ORDER BY nome');
    municipiosCache = rows.map((r) => ({ id: Number(r.id), nome: r.nome, codigoIbge: r.codigo_ibge || null }));
  } else {
    municipiosCache = MUNICIPIOS_MT.map((nome) => ({ id: null, nome, codigoIbge: null }));
  }
  return municipiosCache;
}

async function resolverMunicipio({ municipioId, municipio } = {}) {
  const lista = await listarMunicipios();
  if (municipioId !== undefined && municipioId !== null && municipioId !== '') {
    const id = Number(municipioId);
    const achado = lista.find((m) => m.id === id);
    if (!achado) throw erro(400, 'Município não encontrado.', 'MUNICIPIO_INVALIDO');
    return achado;
  }
  const nome = String(municipio || '').trim();
  if (!nome) return null;
  const alvo = normalizar(nome);
  const achado = lista.find((m) => normalizar(m.nome) === alvo);
  if (!achado) throw erro(400, 'Município não encontrado na base oficial.', 'MUNICIPIO_INVALIDO');
  return achado;
}

/* ---------------- tipos de ocorrência ---------------- */

function tipoJson(codigo, nome, grupo, ordem) {
  return {
    codigo, nome, grupo, descricao: '', ativo: true, ordem,
    criadoEm: Date.now(),
  };
}

async function listarTipos({ incluirInativos = false } = {}) {
  if (pg()) {
    const { rows } = await getPool().query(
      `SELECT codigo, nome, grupo, descricao, ativo, ordem
         FROM tipos_ocorrencia
        ${incluirInativos ? '' : 'WHERE ativo = TRUE'}
        ORDER BY ordem, nome`
    );
    return rows.map((r) => ({
      codigo: r.codigo, nome: r.nome, grupo: r.grupo, descricao: r.descricao,
      ativo: r.ativo, ordem: r.ordem,
    }));
  }
  let lista = await readCollection(COL.tipos);
  if (!Array.isArray(lista) || !lista.length) {
    lista = TIPOS_SEED.map(([codigo, nome, grupo, ordem]) => tipoJson(codigo, nome, grupo, ordem));
    await writeCollection(COL.tipos, lista);
  }
  const filtrada = incluirInativos ? lista : lista.filter((t) => t.ativo !== false);
  return filtrada.sort((a, b) => (a.ordem || 100) - (b.ordem || 100) || a.nome.localeCompare(b.nome));
}

async function criarTipo(dados) {
  const codigoBruto = texto(dados.codigo, { campo: 'codigo', min: 3, max: 40, obrigatorio: true }).toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(codigoBruto)) {
    throw erro(400, 'Código do tipo deve começar por letra e conter apenas A-Z, 0-9 e _.', 'CAMPO_INVALIDO');
  }
  const nome = texto(dados.nome, { campo: 'nome', min: 3, max: 120, obrigatorio: true });
  const grupo = String(dados.grupo || 'outros').trim().toLowerCase();
  if (!GRUPOS_TIPO.includes(grupo)) {
    throw erro(400, `Grupo inválido. Valores aceitos: ${GRUPOS_TIPO.join(', ')}.`, 'CAMPO_INVALIDO');
  }
  const descricao = texto(dados.descricao, { campo: 'descricao', max: 500 });
  const ordem = inteiroNaoNegativo(dados.ordem === undefined ? 100 : dados.ordem, { campo: 'ordem', max: 9999 });

  if (pg()) {
    try {
      const { rows } = await getPool().query(
        `INSERT INTO tipos_ocorrencia (codigo, nome, grupo, descricao, ordem)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING codigo, nome, grupo, descricao, ativo, ordem`,
        [codigoBruto, nome, grupo, descricao, ordem]
      );
      return rows[0];
    } catch (e) {
      if (e && e.code === '23505') throw erro(409, 'Já existe um tipo com esse código ou nome.', 'DUPLICADO');
      throw e;
    }
  }

  const lista = await readCollection(COL.tipos);
  if (lista.some((t) => t.codigo === codigoBruto || normalizar(t.nome) === normalizar(nome))) {
    throw erro(409, 'Já existe um tipo com esse código ou nome.', 'DUPLICADO');
  }
  const novo = { ...tipoJson(codigoBruto, nome, grupo, ordem), descricao };
  lista.push(novo);
  await writeCollection(COL.tipos, lista);
  return novo;
}

/* ---------------- prioridade sugerida ---------------- */

/* Heurística determinística. Não substitui a decisão do operador: a rota
   devolve a sugestão e os motivos; a confirmação é um PATCH explícito. */
function sugerirPrioridade(dados = {}) {
  const motivos = [];
  let nivel = 0; // 0 BAIXA, 1 MODERADA, 2 ALTA, 3 CRITICA

  const obitos = Number(dados.obitos || 0);
  const feridos = Number(dados.pessoasFeridas || dados.feridos || 0);
  const desabrigados = Number(dados.desabrigados || 0);
  const desalojados = Number(dados.desalojados || 0);
  const afetadas = Number(dados.pessoasAfetadas || 0);

  if (obitos > 0) {
    nivel = 3;
    motivos.push(`${obitos} óbito(s) registrado(s).`);
  }
  if (feridos >= 5) {
    nivel = Math.max(nivel, 3);
    motivos.push(`${feridos} pessoas feridas.`);
  } else if (feridos > 0) {
    nivel = Math.max(nivel, 2);
    motivos.push(`${feridos} pessoa(s) ferida(s).`);
  }
  if (desabrigados >= 20 || desalojados >= 50) {
    nivel = Math.max(nivel, 3);
    motivos.push('Grande contingente desabrigado/desalojado.');
  } else if (desabrigados > 0 || desalojados > 0) {
    nivel = Math.max(nivel, 2);
    motivos.push('Pessoas desabrigadas ou desalojadas.');
  }
  if (afetadas >= 50) {
    nivel = Math.max(nivel, 3);
    motivos.push(`${afetadas} pessoas afetadas.`);
  } else if (afetadas >= 10) {
    nivel = Math.max(nivel, 2);
    motivos.push(`${afetadas} pessoas afetadas.`);
  } else if (afetadas > 0) {
    nivel = Math.max(nivel, 1);
    motivos.push(`${afetadas} pessoa(s) afetada(s).`);
  }
  if (TIPOS_GRAVES.has(String(dados.tipo || '').toUpperCase())) {
    nivel = Math.max(nivel, 2);
    motivos.push('Tipo de evento com potencial de dano grave.');
  }
  if (String(dados.verificacao || 'RELATADA').toUpperCase() === 'CONFIRMADA') {
    nivel = Math.min(3, nivel + 1);
    motivos.push('Evento confirmado no local.');
  } else if (String(dados.verificacao || '').toUpperCase() === 'ALERTA') {
    nivel = Math.max(0, nivel - 1);
    motivos.push('Apenas alerta/previsão: não há dano confirmado.');
  }
  if (!motivos.length) motivos.push('Sem indicadores de risco imediato informados.');

  return { prioridade: PRIORIDADES[nivel], motivos };
}

/* ---------------- autenticação e escopo ---------------- */

const PERFIS_CENTRAL = new Set(['admin', 'avancado', 'municipal']);
const PERFIS_DADOS_RESTRITOS = new Set(['admin', 'avancado', 'municipal']);

/* A Central é interna: exige token mesmo quando o login global está
   desligado (modo demonstração). Fail-closed por padrão. */
async function autenticar(req) {
  const token = bearerToken(req);
  const payload = token && verifyToken(token);
  if (!payload) throw erro(401, 'Autenticação necessária para acessar a Central de Ocorrências.', 'NAO_AUTENTICADO');
  const usuarios = await readCollection('users');
  const usuario = usuarios.find((u) => String(u.id) === String(payload.sub)) || null;
  if (!usuario || usuario.ativo === false) {
    throw erro(401, 'Sessão inválida ou conta inativa.', 'SESSAO_INVALIDA');
  }
  if (!PERFIS_CENTRAL.has(usuario.perfil)) {
    throw erro(403, 'Seu perfil não tem acesso à Central de Ocorrências.', 'SEM_PERMISSAO');
  }
  return {
    usuario,
    usuarioId: usuario.id,
    perfil: usuario.perfil,
    municipioRestrito: usuario.perfil === 'municipal' && usuario.municipio
      ? normalizar(usuario.municipio)
      : null,
  };
}

function podeVerDadosRestritos(escopo) {
  return Boolean(escopo && PERFIS_DADOS_RESTRITOS.has(escopo.perfil));
}

/* Organização de gravação: respeita o vínculo do usuário e o escopo do
   município. Sem vínculo em PostgreSQL, a RLS negaria a escrita, então
   falhamos aqui com mensagem clara em vez de erro de banco. */
async function resolverOrganizacao(escopo) {
  if (!pg()) return 'BR';
  let access;
  try {
    access = await loadUserAccess(escopo.usuarioId);
  } catch {
    access = { organizationIds: [], writableOrganizationIds: [], roles: [] };
  }
  const gravaveis = access.writableOrganizationIds || [];
  if (escopo.municipioRestrito) {
    const municipio = await resolverMunicipio({ municipio: escopo.municipioRestrito });
    const esperada = municipio && municipio.codigoIbge ? `MUN-${municipio.codigoIbge}` : null;
    if (!esperada || (gravaveis.length && !gravaveis.includes(esperada))) {
      throw erro(403, 'Usuário municipal sem organização vinculada no banco. Contate o administrador.', 'SEM_ORGANIZACAO');
    }
    return esperada;
  }
  if (gravaveis.length) return gravaveis[0];
  if ((access.organizationIds || []).length) return access.organizationIds[0];
  throw erro(403, 'Usuário sem organização vinculada no banco. Contate o administrador.', 'SEM_ORGANIZACAO');
}

/* ---------------- validação de entrada ---------------- */

function normalizarNovaOcorrencia(body) {
  if (!body || typeof body !== 'object') throw erro(400, 'Corpo da requisição inválido.', 'CORPO_INVALIDO');

  const titulo = texto(body.titulo, { campo: 'titulo', min: 5, max: 160, obrigatorio: true });
  const descricao = texto(body.descricao, { campo: 'descricao', min: 10, max: 5000, obrigatorio: true });
  const tipo = String(body.tipo || '').trim().toUpperCase();
  if (!tipo) throw erro(400, 'Campo obrigatório: tipo.', 'CAMPO_OBRIGATORIO');
  const prioridade = body.prioridade ? enumDe(body.prioridade, PRIORIDADES, 'prioridade') : null;
  const verificacao = enumDe(body.verificacao || 'RELATADA', VERIFICACOES, 'verificacao');
  const status = body.status ? enumDe(body.status, STATUS_VALIDOS, 'status') : 'REGISTRADA';

  const latitude = numeroFinito(body.latitude, { campo: 'latitude', min: -90, max: 90 });
  const longitude = numeroFinito(body.longitude, { campo: 'longitude', min: -180, max: 180 });
  if ((latitude === null) !== (longitude === null)) {
    throw erro(400, 'Informe latitude e longitude juntas.', 'CAMPO_INVALIDO');
  }

  const condicoes = body.condicoesMeteorologicas;
  if (condicoes !== undefined && condicoes !== null && (typeof condicoes !== 'object' || Array.isArray(condicoes))) {
    throw erro(400, 'condicoesMeteorologicas deve ser um objeto.', 'CAMPO_INVALIDO');
  }

  const dadosRestritos = body.dadosRestritos;
  if (dadosRestritos !== undefined && dadosRestritos !== null &&
      (typeof dadosRestritos !== 'object' || Array.isArray(dadosRestritos))) {
    throw erro(400, 'dadosRestritos deve ser um objeto.', 'CAMPO_INVALIDO');
  }

  return {
    titulo,
    descricao,
    tipo,
    prioridade,
    verificacao,
    status,
    latitude,
    longitude,
    bairro: texto(body.bairro, { campo: 'bairro', max: 160 }),
    endereco: texto(body.endereco, { campo: 'endereco', max: 300 }),
    causaProvavel: texto(body.causaProvavel, { campo: 'causaProvavel', max: 500 }),
    necessidades: texto(body.necessidades, { campo: 'necessidades', max: 2000 }),
    pessoasAfetadas: inteiroNaoNegativo(body.pessoasAfetadas, { campo: 'pessoasAfetadas' }),
    municipioId: body.municipioId,
    municipio: body.municipio,
    responsavelId: body.responsavelId === undefined || body.responsavelId === null || body.responsavelId === ''
      ? null
      : String(body.responsavelId),
    fonte: texto(body.fonte, { campo: 'fonte', max: 40 }) || 'MANUAL',
    origemAlertaId: body.origemAlertaId && uuidValido(body.origemAlertaId) ? body.origemAlertaId : null,
    condicoesMeteorologicas: condicoes && typeof condicoes === 'object' ? condicoes : {},
    dadosRestritos: dadosRestritos && typeof dadosRestritos === 'object' ? dadosRestritos : {},
    danos: normalizarDanos(body.danos),
  };
}

function normalizarDanos(dados) {
  if (!dados || typeof dados !== 'object') return null;
  const inteiro = (campo) => inteiroNaoNegativo(dados[campo], { campo: `danos.${campo}` });
  const prejuizo = numeroFinito(dados.prejuizoEstimado, { campo: 'danos.prejuizoEstimado', min: 0, max: 1e12 });
  return {
    residenciasAtingidas: inteiro('residenciasAtingidas'),
    edificacoesDanificadas: inteiro('edificacoesDanificadas'),
    infraestruturaPublica: inteiro('infraestruturaPublica'),
    pontesEstradas: inteiro('pontesEstradas'),
    equipamentosPublicos: inteiro('equipamentosPublicos'),
    agriculturaPecuaria: inteiro('agriculturaPecuaria'),
    pessoasAfetadas: inteiro('pessoasAfetadas'),
    pessoasFeridas: inteiro('pessoasFeridas'),
    obitos: inteiro('obitos'),
    desabrigados: inteiro('desabrigados'),
    desalojados: inteiro('desalojados'),
    prejuizoEstimado: prejuizo,
    observacoes: texto(dados.observacoes, { campo: 'danos.observacoes', max: 2000 }),
  };
}

/* ---------------- mapeamento de saída ---------------- */

function ocorrenciaDeLinha(r) {
  const status = String(r.status || '').toUpperCase();
  return {
    id: r.id,
    protocolo: r.protocolo,
    titulo: r.titulo,
    descricao: r.descricao,
    tipo: r.tipo,
    tipoNome: r.tipo_nome || r.tipo,
    grupo: r.tipo_grupo || 'outros',
    prioridade: r.prioridade || null,
    prioridadeSugerida: r.prioridade_sugerida || null,
    prioridadeSugeridaMotivos: Array.isArray(r.prioridade_sugerida_motivos)
      ? r.prioridade_sugerida_motivos
      : (r.prioridade_sugerida_motivos || []),
    prioridadeRevisadaEm: toMs(r.prioridade_revisada_em),
    status,
    verificacao: String(r.verificacao || 'RELATADA').toUpperCase(),
    organizacaoId: r.organizacao_id,
    territorioId: r.territorio_id || null,
    municipioId: r.municipio_id === null || r.municipio_id === undefined ? null : Number(r.municipio_id),
    municipio: r.municipio_nome || null,
    bairro: r.bairro || '',
    endereco: r.endereco || '',
    latitude: r.latitude === null || r.latitude === undefined ? null : Number(r.latitude),
    longitude: r.longitude === null || r.longitude === undefined ? null : Number(r.longitude),
    causaProvavel: r.causa_provavel || '',
    condicoesMeteorologicas: r.condicoes_meteorologicas || {},
    pessoasAfetadas: Number(r.pessoas_afetadas || 0),
    necessidades: r.necessidades || '',
    fonte: r.fonte || 'MANUAL',
    origemAlertaId: r.origem_alerta_id || null,
    responsavelId: r.responsavel_id === null || r.responsavel_id === undefined ? null : Number(r.responsavel_id),
    criadaPor: r.criada_por === null || r.criada_por === undefined ? null : Number(r.criada_por),
    criadaEm: toMs(r.criada_em),
    atualizadaEm: toMs(r.atualizada_em),
    encerradaEm: toMs(r.encerrada_em),
    equipesMobilizadas: Number(r.equipes_mobilizadas || 0),
  };
}

/* ---------------- protocolo ---------------- */

async function proximoProtocolo() {
  const ano = new Date().getFullYear();
  if (pg()) {
    const { rows } = await getPool().query('SELECT proximo_protocolo_ocorrencia($1) AS protocolo', [ano]);
    return rows[0].protocolo;
  }
  const lista = await readCollection(COL.ocorrencias);
  const prefixo = `OC-${ano}-`;
  const maior = lista
    .map((o) => (String(o.protocolo || '').startsWith(prefixo) ? Number(String(o.protocolo).slice(prefixo.length)) : 0))
    .reduce((a, b) => Math.max(a, Number.isFinite(b) ? b : 0), 0);
  return prefixo + String(maior + 1).padStart(6, '0');
}

/* ---------------- ocorrências: escrita ---------------- */

async function criarOcorrencia(dados, escopo) {
  const tipos = await listarTipos();
  const tipo = tipos.find((t) => t.codigo === dados.tipo);
  if (!tipo) throw erro(400, 'Tipo de ocorrência não cadastrado no catálogo.', 'TIPO_INVALIDO');

  const municipio = await resolverMunicipio({ municipioId: dados.municipioId, municipio: dados.municipio });
  if (escopo && escopo.municipioRestrito) {
    if (!municipio || normalizar(municipio.nome) !== escopo.municipioRestrito) {
      throw erro(403, 'Você só pode registrar ocorrências do seu município.', 'FORA_DO_ESCOPO');
    }
  }

  const sugestao = sugerirPrioridade({
    tipo: dados.tipo,
    verificacao: dados.verificacao,
    pessoasAfetadas: dados.pessoasAfetadas,
    ...(dados.danos || {}),
  });
  const prioridade = dados.prioridade || sugestao.prioridade;
  const protocolo = await proximoProtocolo();
  const agora = Date.now();

  if (pg()) {
    const organizacaoId = dados.organizacaoId;
    try {
      const id = await inTx(async (c) => {
        await c.query("SELECT set_config('app.historico_nota', $1, true)", ['Registro inicial da ocorrência.']);
        const { rows } = await c.query(
          `INSERT INTO ocorrencias
             (organizacao_id, territorio_id, titulo, descricao, tipo, status, localizacao,
              dados_restritos, criada_por, protocolo, prioridade, prioridade_sugerida,
              prioridade_sugerida_motivos, verificacao, municipio_id, bairro, endereco,
              causa_provavel, condicoes_meteorologicas, pessoas_afetadas, necessidades,
              fonte, origem_alerta_id, responsavel_id)
           VALUES ($1,$2,$3,$4,$5,$6::ocorrencia_status,
                   CASE WHEN $7::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($8::float8, $7::float8), 4326) END,
                   $9::jsonb,$10,$11,$12::ocorrencia_prioridade,$13::ocorrencia_prioridade,
                   $14::jsonb,$15::ocorrencia_verificacao,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24,$25)
           RETURNING id`,
          [
            organizacaoId, dados.territorioId || null, dados.titulo, dados.descricao, dados.tipo,
            STATUS[dados.status] || STATUS.REGISTRADA,
            dados.latitude, dados.longitude,
            JSON.stringify(dados.dadosRestritos || {}),
            escopo.usuarioId, protocolo, prioridade, sugestao.prioridade,
            JSON.stringify(sugestao.motivos), dados.verificacao,
            municipio ? municipio.id : null, dados.bairro || null, dados.endereco || null,
            dados.causaProvavel || null, JSON.stringify(dados.condicoesMeteorologicas || {}),
            dados.pessoasAfetadas, dados.necessidades || null, dados.fonte,
            dados.origemAlertaId, dados.responsavelId,
          ]
        );
        const novoId = rows[0].id;
        if (dados.danos) await gravarDanosTx(c, novoId, dados.danos, escopo.usuarioId);
        return novoId;
      });
      const criada = await obterOcorrencia(id, { historico: true });
      await registrarAuditoria('ocorrencia_criada', escopo, { ocorrenciaId: id, protocolo, tipo: dados.tipo });
      return criada;
    } catch (e) {
      if (e && e.code === '23503') throw erro(400, 'Organização, município ou usuário inválido.', 'REFERENCIA_INVALIDA');
      throw e;
    }
  }

  /* modo arquivo/memória */
  const lista = await readCollection(COL.ocorrencias);
  const registro = {
    id: crypto.randomUUID(),
    protocolo,
    titulo: dados.titulo,
    descricao: dados.descricao,
    tipo: dados.tipo,
    tipoNome: tipo.nome,
    grupo: tipo.grupo,
    prioridade,
    prioridadeSugerida: sugestao.prioridade,
    prioridadeSugeridaMotivos: sugestao.motivos,
    prioridadeRevisadaEm: null,
    status: dados.status,
    verificacao: dados.verificacao,
    organizacaoId: dados.organizacaoId || 'BR',
    territorioId: dados.territorioId || null,
    municipioId: municipio ? municipio.id : null,
    municipio: municipio ? municipio.nome : '',
    bairro: dados.bairro,
    endereco: dados.endereco,
    latitude: dados.latitude,
    longitude: dados.longitude,
    causaProvavel: dados.causaProvavel,
    condicoesMeteorologicas: dados.condicoesMeteorologicas,
    pessoasAfetadas: dados.pessoasAfetadas,
    necessidades: dados.necessidades,
    fonte: dados.fonte,
    origemAlertaId: dados.origemAlertaId,
    responsavelId: dados.responsavelId ? Number(dados.responsavelId) : null,
    criadaPor: escopo.usuarioId ? Number(escopo.usuarioId) : null,
    criadaEm: agora,
    atualizadaEm: agora,
    encerradaEm: null,
    dadosRestritos: dados.dadosRestritos,
    equipesMobilizadas: 0,
  };
  lista.push(registro);
  await writeCollection(COL.ocorrencias, lista);

  const historico = await readCollection(COL.historico);
  historico.push({
    id: crypto.randomUUID(),
    ocorrenciaId: registro.id,
    statusAnterior: null,
    statusNovo: registro.status,
    usuarioId: registro.criadaPor,
    usuarioNome: escopo.usuario ? escopo.usuario.nome || escopo.usuario.usuario : null,
    nota: 'Registro inicial da ocorrência.',
    alteradoEm: agora,
  });
  await writeCollection(COL.historico, historico);

  if (dados.danos) await gravarDanosJson(registro.id, dados.danos, escopo.usuarioId);
  await registrarAuditoria('ocorrencia_criada', escopo, { ocorrenciaId: registro.id, protocolo, tipo: dados.tipo });
  return obterOcorrencia(registro.id, { historico: true });
}

function publicoComDanos(registro, danos) {
  const { dadosRestritos, ...resto } = registro;
  return { ...resto, danos: danos || null };
}

async function registrarAuditoria(action, escopo, metadata) {
  try {
    await push('audit_logs', {
      id: `central-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action,
      metadata: { ...metadata, usuario: escopo.usuario ? escopo.usuario.usuario : null },
      createdAt: Date.now(),
    });
  } catch { /* auditoria é best-effort; não derruba a operação */ }
}

async function gravarDanosTx(client, ocorrenciaId, danos, usuarioId) {
  await client.query(
    `INSERT INTO ocorrencia_danos (
       ocorrencia_id, residencias_atingidas, edificacoes_danificadas, infraestrutura_publica,
       pontes_estradas, equipamentos_publicos, agricultura_pecuaria, pessoas_afetadas,
       pessoas_feridas, obitos, desabrigados, desalojados, prejuizo_estimado, observacoes,
       atualizado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (ocorrencia_id) DO UPDATE SET
       residencias_atingidas = EXCLUDED.residencias_atingidas,
       edificacoes_danificadas = EXCLUDED.edificacoes_danificadas,
       infraestrutura_publica = EXCLUDED.infraestrutura_publica,
       pontes_estradas = EXCLUDED.pontes_estradas,
       equipamentos_publicos = EXCLUDED.equipamentos_publicos,
       agricultura_pecuaria = EXCLUDED.agricultura_pecuaria,
       pessoas_afetadas = EXCLUDED.pessoas_afetadas,
       pessoas_feridas = EXCLUDED.pessoas_feridas,
       obitos = EXCLUDED.obitos,
       desabrigados = EXCLUDED.desabrigados,
       desalojados = EXCLUDED.desalojados,
       prejuizo_estimado = EXCLUDED.prejuizo_estimado,
       observacoes = EXCLUDED.observacoes,
       atualizado_em = now(),
       atualizado_por = EXCLUDED.atualizado_por`,
    [
      ocorrenciaId, danos.residenciasAtingidas, danos.edificacoesDanificadas,
      danos.infraestruturaPublica, danos.pontesEstradas, danos.equipamentosPublicos,
      danos.agriculturaPecuaria, danos.pessoasAfetadas, danos.pessoasFeridas,
      danos.obitos, danos.desabrigados, danos.desalojados, danos.prejuizoEstimado,
      danos.observacoes, usuarioId,
    ]
  );
}

async function gravarDanosJson(ocorrenciaId, danos, usuarioId) {
  const lista = await readCollection(COL.danos);
  const idx = lista.findIndex((d) => d.ocorrenciaId === ocorrenciaId);
  const registro = { ...danos, ocorrenciaId, atualizadoEm: Date.now(), atualizadoPor: usuarioId };
  if (idx >= 0) lista[idx] = registro;
  else lista.push(registro);
  await writeCollection(COL.danos, lista);
  return registro;
}

/* ---------------- ocorrências: leitura ---------------- */

function filtrosPg(filtros = {}, params = []) {
  const cond = [];
  const add = (sql, valor) => {
    params.push(valor);
    cond.push(sql.replace(/\?/g, `$${params.length}`));
  };
  if (filtros.protocolo) add('o.protocolo ILIKE ?', `%${String(filtros.protocolo).trim()}%`);
  if (filtros.tipo) add('o.tipo = ?', String(filtros.tipo).toUpperCase());
  if (filtros.prioridade) add('o.prioridade::text = ?', String(filtros.prioridade).toUpperCase());
  if (filtros.status) add('o.status::text = ?', String(filtros.status).toLowerCase());
  if (filtros.verificacao) add('o.verificacao::text = ?', String(filtros.verificacao).toUpperCase());
  if (filtros.municipioId) add('o.municipio_id = ?', Number(filtros.municipioId));
  if (filtros.responsavelId) add('o.responsavel_id = ?', Number(filtros.responsavelId));
  if (filtros.de) add('o.criada_em >= ?', filtros.de);
  if (filtros.ate) add('o.criada_em <= ?', filtros.ate);
  if (filtros.q) {
    add('(o.titulo ILIKE ? OR o.descricao ILIKE ? OR o.endereco ILIKE ? OR o.protocolo ILIKE ?)', `%${filtros.q}%`);
  }
  return cond;
}

/* Filtro em memória equivalente ao SQL (modo arquivo/memória). */
function filtrarJson(lista, filtros = {}) {
  let filtrada = lista.slice();
  if (filtros.protocolo) {
    const alvo = normalizar(filtros.protocolo);
    filtrada = filtrada.filter((o) => normalizar(o.protocolo).includes(alvo));
  }
  if (filtros.tipo) filtrada = filtrada.filter((o) => o.tipo === String(filtros.tipo).toUpperCase());
  if (filtros.prioridade) {
    const alvo = String(filtros.prioridade).toUpperCase();
    filtrada = filtrada.filter((o) => o.prioridade === alvo);
  }
  if (filtros.status) {
    const alvo = String(filtros.status).toUpperCase();
    filtrada = filtrada.filter((o) => o.status === alvo);
  }
  if (filtros.verificacao) {
    const alvo = String(filtros.verificacao).toUpperCase();
    filtrada = filtrada.filter((o) => o.verificacao === alvo);
  }
  if (filtros.municipioId) {
    filtrada = filtrada.filter((o) => Number(o.municipioId) === Number(filtros.municipioId));
  }
  if (filtros.municipioNome) {
    const alvo = normalizar(filtros.municipioNome);
    filtrada = filtrada.filter((o) => normalizar(o.municipio) === alvo);
  }
  if (filtros.responsavelId) {
    filtrada = filtrada.filter((o) => Number(o.responsavelId) === Number(filtros.responsavelId));
  }
  if (filtros.de) filtrada = filtrada.filter((o) => (o.criadaEm || 0) >= Date.parse(filtros.de));
  if (filtros.ate) filtrada = filtrada.filter((o) => (o.criadaEm || 0) <= Date.parse(filtros.ate));
  if (filtros.q) {
    const alvo = normalizar(filtros.q);
    filtrada = filtrada.filter((o) => [o.titulo, o.descricao, o.endereco, o.protocolo]
      .some((v) => normalizar(v).includes(alvo)));
  }
  return filtrada.sort((a, b) => (b.criadaEm || 0) - (a.criadaEm || 0));
}

async function listarOcorrencias(filtros = {}, { limite = 100, deslocamento = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limite) || 100, 1), 500);
  const off = Math.max(Number(deslocamento) || 0, 0);

  if (pg()) {
    const params = [];
    const cond = filtrosPg(filtros, params);
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await getPool().query(
      `SELECT o.*, m.nome AS municipio_nome, t.nome AS tipo_nome, t.grupo AS tipo_grupo,
              ST_Y(o.localizacao) AS latitude, ST_X(o.localizacao) AS longitude,
              (SELECT count(*) FROM equipe_mobilizacoes em
                WHERE em.ocorrencia_id = o.id AND em.status <> 'encerrada') AS equipes_mobilizadas
         FROM ocorrencias o
         LEFT JOIN municipios m ON m.id = o.municipio_id
         LEFT JOIN tipos_ocorrencia t ON t.codigo = o.tipo
         ${where}
         ORDER BY o.criada_em DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, lim, off]
    );
    return rows.map(ocorrenciaDeLinha);
  }

  const lista = await readCollection(COL.ocorrencias);
  const tipos = await listarTipos({ incluirInativos: true });
  const nomes = new Map(tipos.map((t) => [t.codigo, t]));
  const mobilizacoes = await readCollection(COL.mobilizacoes);
  return filtrarJson(lista, filtros)
    .slice(off, off + lim)
    .map((o) => {
      const { dadosRestritos, ...resto } = o;
      const tipo = nomes.get(o.tipo) || {};
      return {
        ...resto,
        tipoNome: tipo.nome || o.tipo,
        grupo: tipo.grupo || o.grupo || 'outros',
        equipesMobilizadas: mobilizacoes
          .filter((m) => m.ocorrenciaId === o.id && m.status !== 'encerrada').length,
      };
    });
}

async function obterOcorrencia(id, { historico = false, dadosRestritos = false } = {}) {
  if (pg()) {
    if (!uuidValido(id)) throw erro(400, 'Identificador de ocorrência inválido.', 'ID_INVALIDO');
    const { rows } = await getPool().query(
      `SELECT o.*, m.nome AS municipio_nome, t.nome AS tipo_nome, t.grupo AS tipo_grupo,
              ST_Y(o.localizacao) AS latitude, ST_X(o.localizacao) AS longitude,
              (SELECT count(*) FROM equipe_mobilizacoes em
                WHERE em.ocorrencia_id = o.id AND em.status <> 'encerrada') AS equipes_mobilizadas
         FROM ocorrencias o
         LEFT JOIN municipios m ON m.id = o.municipio_id
         LEFT JOIN tipos_ocorrencia t ON t.codigo = o.tipo
        WHERE o.id = $1`,
      [id]
    );
    if (!rows.length) return null;
    const ocorrencia = ocorrenciaDeLinha(rows[0]);
    ocorrencia.danos = await obterDanos(id);
    if (dadosRestritos) ocorrencia.dadosRestritos = rows[0].dados_restritos || {};
    if (historico) {
      ocorrencia.historico = await obterHistorico(id);
      ocorrencia.mobilizacoes = await listarMobilizacoes({ ocorrenciaId: id });
      ocorrencia.anexos = await listarAnexos(id);
    }
    return ocorrencia;
  }

  const lista = await readCollection(COL.ocorrencias);
  const achada = lista.find((o) => o.id === id);
  if (!achada) return null;
  const saida = publicoComDanos(achada, await obterDanosJson(id));
  if (dadosRestritos) saida.dadosRestritos = achada.dadosRestritos || {};
  if (historico) {
    const todos = await readCollection(COL.historico);
    saida.historico = todos
      .filter((h) => h.ocorrenciaId === id)
      .sort((a, b) => (a.alteradoEm || 0) - (b.alteradoEm || 0));
    saida.mobilizacoes = await listarMobilizacoes({ ocorrenciaId: id });
    saida.anexos = await listarAnexos(id);
  }
  return saida;
}

async function obterHistorico(id) {
  const { rows } = await getPool().query(
    `SELECT h.id, h.status_anterior, h.status_novo, h.nota, h.alterado_em,
            h.usuario_id, u.nome AS usuario_nome, u.usuario AS usuario_login
       FROM ocorrencia_historico h
       LEFT JOIN usuarios u ON u.id = h.usuario_id
      WHERE h.ocorrencia_id = $1
      ORDER BY h.alterado_em, h.id`,
    [id]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    statusAnterior: r.status_anterior ? String(r.status_anterior).toUpperCase() : null,
    statusNovo: String(r.status_novo).toUpperCase(),
    nota: r.nota || '',
    usuarioId: r.usuario_id,
    usuario: r.usuario_nome || r.usuario_login || null,
    alteradoEm: toMs(r.alterado_em),
  }));
}

async function obterDanos(id) {
  if (pg()) {
    const { rows } = await getPool().query('SELECT * FROM ocorrencia_danos WHERE ocorrencia_id = $1', [id]);
    if (!rows.length) return null;
    return danosDeLinha(rows[0]);
  }
  return obterDanosJson(id);
}

async function obterDanosJson(id) {
  const lista = await readCollection(COL.danos);
  return lista.find((d) => d.ocorrenciaId === id) || null;
}

function danosDeLinha(r) {
  return {
    residenciasAtingidas: Number(r.residencias_atingidas || 0),
    edificacoesDanificadas: Number(r.edificacoes_danificadas || 0),
    infraestruturaPublica: Number(r.infraestrutura_publica || 0),
    pontesEstradas: Number(r.pontes_estradas || 0),
    equipamentosPublicos: Number(r.equipamentos_publicos || 0),
    agriculturaPecuaria: Number(r.agricultura_pecuaria || 0),
    pessoasAfetadas: Number(r.pessoas_afetadas || 0),
    pessoasFeridas: Number(r.pessoas_feridas || 0),
    obitos: Number(r.obitos || 0),
    desabrigados: Number(r.desabrigados || 0),
    desalojados: Number(r.desalojados || 0),
    prejuizoEstimado: r.prejuizo_estimado === null || r.prejuizo_estimado === undefined ? null : Number(r.prejuizo_estimado),
    observacoes: r.observacoes || '',
    atualizadoEm: toMs(r.atualizado_em),
    atualizadoPor: r.atualizado_por === null || r.atualizado_por === undefined ? null : Number(r.atualizado_por),
  };
}

/* ---------------- ocorrências: atualização ---------------- */

const CAMPOS_ATUALIZAVEIS = {
  titulo: { col: 'titulo', tipo: 'texto', min: 5, max: 160 },
  descricao: { col: 'descricao', tipo: 'texto', min: 10, max: 5000 },
  bairro: { col: 'bairro', tipo: 'texto', max: 160 },
  endereco: { col: 'endereco', tipo: 'texto', max: 300 },
  causaProvavel: { col: 'causa_provavel', tipo: 'texto', max: 500 },
  necessidades: { col: 'necessidades', tipo: 'texto', max: 2000 },
  pessoasAfetadas: { col: 'pessoas_afetadas', tipo: 'inteiro' },
  latitude: { col: 'latitude', tipo: 'coordenada' },
  longitude: { col: 'longitude', tipo: 'coordenada' },
};

async function atualizarOcorrencia(id, body, escopo) {
  if (!body || typeof body !== 'object') throw erro(400, 'Corpo da requisição inválido.', 'CORPO_INVALIDO');
  const atual = await obterOcorrencia(id, { dadosRestritos: true });
  if (!atual) throw erro(404, 'Ocorrência não encontrada.', 'NAO_ENCONTRADA');

  if (escopo.municipioRestrito && normalizar(atual.municipio) !== escopo.municipioRestrito) {
    throw erro(403, 'Acesso limitado às ocorrências do seu município.', 'FORA_DO_ESCOPO');
  }

  const sets = [];
  const params = [];
  const add = (col, valor, cast) => {
    params.push(valor);
    sets.push(`${col} = $${params.length}${cast ? '::' + cast : ''}`);
  };

  const temLat = Object.hasOwn(body, 'latitude');
  const temLng = Object.hasOwn(body, 'longitude');
  if (temLat !== temLng) throw erro(400, 'Informe latitude e longitude juntas.', 'CAMPO_INVALIDO');
  if (temLat) {
    const latitude = numeroFinito(body.latitude, { campo: 'latitude', min: -90, max: 90 });
    const longitude = numeroFinito(body.longitude, { campo: 'longitude', min: -180, max: 180 });
    if (latitude === null || longitude === null) {
      sets.push('localizacao = NULL');
    } else {
      params.push(longitude);
      const posLng = params.length;
      params.push(latitude);
      sets.push(`localizacao = ST_SetSRID(ST_MakePoint($${posLng}::float8, $${params.length}::float8), 4326)`);
    }
  }

  for (const [campo, regra] of Object.entries(CAMPOS_ATUALIZAVEIS)) {
    if (campo === 'latitude' || campo === 'longitude') continue;
    if (!Object.hasOwn(body, campo)) continue;
    if (regra.tipo === 'texto') add(regra.col, texto(body[campo], { campo, min: regra.min || 0, max: regra.max }));
    else if (regra.tipo === 'inteiro') add(regra.col, inteiroNaoNegativo(body[campo], { campo }));
  }

  if (Object.hasOwn(body, 'tipo')) {
    const tipo = String(body.tipo || '').trim().toUpperCase();
    const tipos = await listarTipos();
    if (!tipos.some((t) => t.codigo === tipo)) throw erro(400, 'Tipo de ocorrência não cadastrado.', 'TIPO_INVALIDO');
    add('tipo', tipo);
  }
  if (Object.hasOwn(body, 'verificacao')) {
    add('verificacao', enumDe(body.verificacao, VERIFICACOES, 'verificacao'), 'ocorrencia_verificacao');
  }
  if (Object.hasOwn(body, 'condicoesMeteorologicas')) {
    const c = body.condicoesMeteorologicas;
    if (c !== null && (typeof c !== 'object' || Array.isArray(c))) {
      throw erro(400, 'condicoesMeteorologicas deve ser um objeto.', 'CAMPO_INVALIDO');
    }
    add('condicoes_meteorologicas', JSON.stringify(c || {}), 'jsonb');
  }
  if (Object.hasOwn(body, 'dadosRestritos')) {
    const d = body.dadosRestritos;
    if (d !== null && (typeof d !== 'object' || Array.isArray(d))) {
      throw erro(400, 'dadosRestritos deve ser um objeto.', 'CAMPO_INVALIDO');
    }
    add('dados_restritos', JSON.stringify(d || {}), 'jsonb');
  }
  if (Object.hasOwn(body, 'responsavelId')) {
    const v = body.responsavelId;
    add('responsavel_id', v === null || v === '' ? null : Number(v));
  }

  let novaPrioridade = null;
  if (Object.hasOwn(body, 'prioridade')) {
    novaPrioridade = enumDe(body.prioridade, PRIORIDADES, 'prioridade');
    add('prioridade', novaPrioridade, 'ocorrencia_prioridade');
    add('prioridade_revisada_por', escopo.usuarioId);
    sets.push('prioridade_revisada_em = now()');
  }

  let novoStatus = null;
  let justificativa = '';
  if (Object.hasOwn(body, 'status')) {
    novoStatus = enumDe(body.status, STATUS_VALIDOS, 'status');
    if (atual.status === novoStatus) {
      throw erro(400, 'A ocorrência já está nesse status.', 'STATUS_REPETIDO');
    }
    justificativa = texto(body.justificativa, { campo: 'justificativa', max: 1000 });
    if (['CONCLUIDA', 'ARQUIVADA'].includes(novoStatus) && justificativa.length < 10) {
      throw erro(400, 'Informe justificativa (mínimo 10 caracteres) para concluir ou arquivar.', 'JUSTIFICATIVA_OBRIGATORIA');
    }
    add('status', STATUS[novoStatus], 'ocorrencia_status');
    if (novoStatus === 'CONCLUIDA') sets.push('encerrada_em = now()');
    if (novoStatus === 'ARQUIVADA' && atual.status !== 'CONCLUIDA') sets.push('encerrada_em = now()');
  }

  let danosNormalizados = null;
  if (Object.hasOwn(body, 'danos')) {
    danosNormalizados = normalizarDanos(body.danos);
    if (!danosNormalizados) throw erro(400, 'danos deve ser um objeto.', 'CAMPO_INVALIDO');
  }

  if (!sets.length && !danosNormalizados) throw erro(400, 'Nenhum campo válido para atualizar.', 'SEM_ALTERACOES');

  if (danosNormalizados) {
    if (pg()) await gravarDanosTx(getPool(), id, danosNormalizados, escopo.usuarioId);
    else await gravarDanosJson(id, danosNormalizados, escopo.usuarioId);
  }

  if (pg()) {
    await inTx(async (c) => {
      if (justificativa) await c.query("SELECT set_config('app.historico_nota', $1, true)", [justificativa]);
      params.push(escopo.usuarioId);
      sets.push(`atualizada_por = $${params.length}`);
      sets.push('atualizada_em = now()');
      params.push(id);
      const { rowCount } = await c.query(
        `UPDATE ocorrencias SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params
      );
      if (!rowCount) throw erro(404, 'Ocorrência não encontrada.', 'NAO_ENCONTRADA');
    });
  } else {
    const lista = await readCollection(COL.ocorrencias);
    const idx = lista.findIndex((o) => o.id === id);
    if (idx < 0) throw erro(404, 'Ocorrência não encontrada.', 'NAO_ENCONTRADA');
    const alvo = { ...lista[idx] };
    /* Aplica exatamente os mesmos campos já validados. */
    if (Object.hasOwn(body, 'titulo')) alvo.titulo = texto(body.titulo, { campo: 'titulo', min: 5, max: 160 });
    if (Object.hasOwn(body, 'descricao')) alvo.descricao = texto(body.descricao, { campo: 'descricao', min: 10, max: 5000 });
    if (Object.hasOwn(body, 'bairro')) alvo.bairro = texto(body.bairro, { campo: 'bairro', max: 160 });
    if (Object.hasOwn(body, 'endereco')) alvo.endereco = texto(body.endereco, { campo: 'endereco', max: 300 });
    if (Object.hasOwn(body, 'causaProvavel')) alvo.causaProvavel = texto(body.causaProvavel, { campo: 'causaProvavel', max: 500 });
    if (Object.hasOwn(body, 'necessidades')) alvo.necessidades = texto(body.necessidades, { campo: 'necessidades', max: 2000 });
    if (Object.hasOwn(body, 'pessoasAfetadas')) alvo.pessoasAfetadas = inteiroNaoNegativo(body.pessoasAfetadas, { campo: 'pessoasAfetadas' });
    if (temLat) {
      alvo.latitude = body.latitude === null || body.latitude === '' ? null : Number(body.latitude);
      alvo.longitude = body.longitude === null || body.longitude === '' ? null : Number(body.longitude);
    }
    if (Object.hasOwn(body, 'tipo')) alvo.tipo = String(body.tipo).toUpperCase();
    if (Object.hasOwn(body, 'verificacao')) alvo.verificacao = String(body.verificacao).toUpperCase();
    if (Object.hasOwn(body, 'condicoesMeteorologicas')) alvo.condicoesMeteorologicas = body.condicoesMeteorologicas || {};
    if (Object.hasOwn(body, 'dadosRestritos')) alvo.dadosRestritos = body.dadosRestritos || {};
    if (Object.hasOwn(body, 'responsavelId')) alvo.responsavelId = body.responsavelId === null || body.responsavelId === '' ? null : Number(body.responsavelId);
    if (novaPrioridade) {
      alvo.prioridade = novaPrioridade;
      alvo.prioridadeRevisadaEm = Date.now();
    }
    if (novoStatus) {
      alvo.status = novoStatus;
      if (novoStatus === 'CONCLUIDA' || novoStatus === 'ARQUIVADA') alvo.encerradaEm = Date.now();
      const hist = await readCollection(COL.historico);
      hist.push({
        id: crypto.randomUUID(),
        ocorrenciaId: id,
        statusAnterior: lista[idx].status,
        statusNovo: novoStatus,
        usuarioId: escopo.usuarioId,
        usuarioNome: escopo.usuario ? escopo.usuario.nome || escopo.usuario.usuario : null,
        nota: justificativa,
        alteradoEm: Date.now(),
      });
      await writeCollection(COL.historico, hist);
    }
    alvo.atualizadaEm = Date.now();
    lista[idx] = alvo;
    await writeCollection(COL.ocorrencias, lista);
  }

  if (novoStatus) {
    await registrarAuditoria('ocorrencia_status_atualizado', escopo, {
      ocorrenciaId: id, statusAnterior: atual.status, status: novoStatus, justificativa,
    });
  }
  if (novaPrioridade) {
    await registrarAuditoria('ocorrencia_prioridade_definida', escopo, {
      ocorrenciaId: id, prioridade: novaPrioridade,
    });
  }

  return obterOcorrencia(id, { historico: true, dadosRestritos: true });
}

/* ---------------- estatísticas do dashboard ---------------- */

function filtrosSqlParaStats(filtros = {}) {
  const params = [];
  const cond = filtrosPg(filtros, params);
  return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', params };
}

async function estatisticas(filtros = {}) {
  if (pg()) {
    const { where, params } = filtrosSqlParaStats(filtros);
    const { rows } = await getPool().query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE o.status NOT IN ('concluida', 'arquivada'))::int AS em_andamento,
         count(*) FILTER (WHERE o.prioridade = 'CRITICA')::int AS criticas,
         count(*) FILTER (WHERE o.status = 'concluida')::int AS concluidas,
         count(*) FILTER (WHERE o.status = 'arquivada')::int AS arquivadas,
         count(DISTINCT o.municipio_id) FILTER (WHERE o.municipio_id IS NOT NULL)::int AS municipios_afetados,
         COALESCE(sum(o.pessoas_afetadas), 0)::int AS pessoas_afetadas,
         COALESCE(sum(d.desalojados), 0)::int AS desalojados,
         COALESCE(sum(d.desabrigados), 0)::int AS desabrigados,
         COALESCE(sum(d.obitos), 0)::int AS obitos,
         COALESCE(sum(d.pessoas_feridas), 0)::int AS feridos,
         (SELECT count(DISTINCT em.equipe_id) FROM equipe_mobilizacoes em
           WHERE em.status <> 'encerrada')::int AS equipes_mobilizadas,
         round(avg(EXTRACT(EPOCH FROM (o.encerrada_em - o.criada_em)) / 3600.0)
               FILTER (WHERE o.encerrada_em IS NOT NULL), 1) AS tempo_medio_horas
       FROM ocorrencias o
       LEFT JOIN ocorrencia_danos d ON d.ocorrencia_id = o.id
       ${where}`,
      params
    );
    const r = rows[0] || {};
    const porTipo = await getPool().query(
      `SELECT o.tipo AS chave, COALESCE(t.nome, o.tipo) AS nome, count(*)::int AS total
         FROM ocorrencias o LEFT JOIN tipos_ocorrencia t ON t.codigo = o.tipo
         ${where} GROUP BY o.tipo, t.nome ORDER BY total DESC`, params
    );
    const porPrioridade = await getPool().query(
      `SELECT COALESCE(o.prioridade::text, 'SEM_PRIORIDADE') AS chave, count(*)::int AS total
         FROM ocorrencias o ${where} GROUP BY 1`, params
    );
    const porStatus = await getPool().query(
      `SELECT o.status::text AS chave, count(*)::int AS total FROM ocorrencias o ${where} GROUP BY 1`, params
    );
    const porMunicipio = await getPool().query(
      `SELECT COALESCE(m.nome, 'Não informado') AS nome, count(*)::int AS total
         FROM ocorrencias o LEFT JOIN municipios m ON m.id = o.municipio_id
         ${where} GROUP BY 1 ORDER BY total DESC LIMIT 10`, params
    );
    const evolucao = await getPool().query(
      `SELECT to_char(date_trunc('day', o.criada_em), 'YYYY-MM-DD') AS dia, count(*)::int AS total
         FROM ocorrencias o
        ${where ? where + ' AND' : 'WHERE'} o.criada_em >= now() - interval '14 days'
        GROUP BY 1 ORDER BY 1`, params
    );
    const contar = (res) => Object.fromEntries(res.rows.map((x) => [x.chave, x.total]));
    return {
      total: Number(r.total || 0),
      emAndamento: Number(r.em_andamento || 0),
      criticas: Number(r.criticas || 0),
      concluidas: Number(r.concluidas || 0),
      arquivadas: Number(r.arquivadas || 0),
      municipiosAfetados: Number(r.municipios_afetados || 0),
      pessoasAfetadas: Number(r.pessoas_afetadas || 0),
      desalojados: Number(r.desalojados || 0),
      desabrigados: Number(r.desabrigados || 0),
      obitos: Number(r.obitos || 0),
      feridos: Number(r.feridos || 0),
      equipesMobilizadas: Number(r.equipes_mobilizadas || 0),
      tempoMedioAtendimentoHoras: r.tempo_medio_horas === null ? null : Number(r.tempo_medio_horas),
      porTipo: porTipo.rows,
      porPrioridade: contar(porPrioridade),
      porStatus: contar(porStatus),
      porMunicipio: porMunicipio.rows,
      evolucao: evolucao.rows,
    };
  }

  const lista = await readCollection(COL.ocorrencias);
  const tipos = await listarTipos({ incluirInativos: true });
  const nomes = new Map(tipos.map((t) => [t.codigo, t]));
  const mobilizacoes = await readCollection(COL.mobilizacoes);
  const filtrada = filtrarJson(lista, filtros).map((o) => {
    const { dadosRestritos, ...resto } = o;
    const tipo = nomes.get(o.tipo) || {};
    return {
      ...resto,
      tipoNome: tipo.nome || o.tipo,
      grupo: tipo.grupo || o.grupo || 'outros',
      equipesMobilizadas: mobilizacoes
        .filter((m) => m.ocorrenciaId === o.id && m.status !== 'encerrada').length,
    };
  });
  const danos = await readCollection(COL.danos);
  return estatisticasDeLista(filtrada, danos, mobilizacoes);
}

function estatisticasDeLista(lista, danos, mobilizacoes) {
  const ativas = lista.filter((o) => !STATUS_FINAIS.has(o.status));
  const danosPorId = new Map(danos.map((d) => [d.ocorrenciaId, d]));
  const soma = (campo) => lista.reduce((acc, o) => acc + Number((danosPorId.get(o.id) || {})[campo] || 0), 0);
  const encerradas = lista.filter((o) => o.encerradaEm && o.criadaEm);
  const tempoMedio = encerradas.length
    ? Math.round(encerradas.reduce((acc, o) => acc + (o.encerradaEm - o.criadaEm) / 3600000, 0) / encerradas.length * 10) / 10
    : null;
  const conta = (campo) => lista.reduce((acc, o) => {
    const chave = o[campo] || 'N/A';
    acc[chave] = (acc[chave] || 0) + 1;
    return acc;
  }, {});
  const porTipoMap = new Map();
  for (const o of lista) {
    const atual = porTipoMap.get(o.tipo) || { chave: o.tipo, nome: o.tipoNome || o.tipo, total: 0 };
    atual.total += 1;
    porTipoMap.set(o.tipo, atual);
  }
  const porMunicipioMap = new Map();
  for (const o of lista) {
    const nome = o.municipio || 'Não informado';
    porMunicipioMap.set(nome, (porMunicipioMap.get(nome) || 0) + 1);
  }
  const hoje = new Date();
  const evolucao = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - i);
    const chave = d.toISOString().slice(0, 10);
    evolucao.push({
      dia: chave,
      total: lista.filter((o) => o.criadaEm && new Date(o.criadaEm).toISOString().slice(0, 10) === chave).length,
    });
  }
  return {
    total: lista.length,
    emAndamento: ativas.length,
    criticas: lista.filter((o) => o.prioridade === 'CRITICA').length,
    concluidas: lista.filter((o) => o.status === 'CONCLUIDA').length,
    arquivadas: lista.filter((o) => o.status === 'ARQUIVADA').length,
    municipiosAfetados: new Set(lista.map((o) => o.municipio).filter(Boolean)).size,
    pessoasAfetadas: lista.reduce((acc, o) => acc + Number(o.pessoasAfetadas || 0), 0),
    desalojados: soma('desalojados'),
    desabrigados: soma('desabrigados'),
    obitos: soma('obitos'),
    feridos: soma('pessoasFeridas'),
    equipesMobilizadas: new Set(mobilizacoes
      .filter((m) => m.status !== 'encerrada')
      .map((m) => m.equipeId)).size,
    tempoMedioAtendimentoHoras: tempoMedio,
    porTipo: [...porTipoMap.values()].sort((a, b) => b.total - a.total),
    porPrioridade: conta('prioridade'),
    porStatus: conta('status'),
    porMunicipio: [...porMunicipioMap.entries()].map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total).slice(0, 10),
    evolucao,
  };
}

/* ---------------- equipes e mobilizações ---------------- */

async function listarEquipes({ incluirInativas = false } = {}) {
  if (pg()) {
    const { rows } = await getPool().query(
      `SELECT e.*, (SELECT count(*) FROM equipe_mobilizacoes m
                     WHERE m.equipe_id = e.id AND m.status <> 'encerrada') AS mobilizacoes_abertas
         FROM equipes e ${incluirInativas ? '' : 'WHERE e.ativa = TRUE'} ORDER BY e.nome`
    );
    return rows.map(equipeDeLinha);
  }
  const lista = await readCollection(COL.equipes);
  return (incluirInativas ? lista : lista.filter((e) => e.ativa !== false))
    .sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
}

function equipeDeLinha(r) {
  return {
    id: r.id,
    organizacaoId: r.organizacao_id,
    nome: r.nome,
    tipo: r.tipo,
    responsavel: r.responsavel || '',
    contato: r.contato || '',
    ativa: r.ativa,
    criadaEm: toMs(r.criada_em),
    mobilizacoesAbertas: Number(r.mobilizacoes_abertas || 0),
  };
}

async function criarEquipe(dados, escopo) {
  const nome = texto(dados.nome, { campo: 'nome', min: 3, max: 120, obrigatorio: true });
  const tipo = texto(dados.tipo, { campo: 'tipo', max: 40 }) || 'operacional';
  const responsavel = texto(dados.responsavel, { campo: 'responsavel', max: 120 });
  const contato = texto(dados.contato, { campo: 'contato', max: 80 });

  if (pg()) {
    const { rows } = await getPool().query(
      `INSERT INTO equipes (organizacao_id, territorio_id, nome, tipo, responsavel, contato, criada_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [dados.organizacaoId, dados.territorioId || null, nome, tipo, responsavel, contato, escopo.usuarioId]
    );
    return equipeDeLinha(rows[0]);
  }
  const lista = await readCollection(COL.equipes);
  const nova = {
    id: crypto.randomUUID(),
    organizacaoId: dados.organizacaoId || 'BR',
    nome, tipo, responsavel, contato, ativa: true,
    criadaEm: Date.now(), mobilizacoesAbertas: 0,
  };
  lista.push(nova);
  await writeCollection(COL.equipes, lista);
  return nova;
}

async function listarMobilizacoes(filtros = {}) {
  if (pg()) {
    const params = [];
    const cond = [];
    if (filtros.ocorrenciaId) { params.push(filtros.ocorrenciaId); cond.push(`m.ocorrencia_id = $${params.length}`); }
    if (filtros.equipeId) { params.push(filtros.equipeId); cond.push(`m.equipe_id = $${params.length}`); }
    if (filtros.status) { params.push(String(filtros.status).toLowerCase()); cond.push(`m.status::text = $${params.length}`); }
    const { rows } = await getPool().query(
      `SELECT m.*, e.nome AS equipe_nome
         FROM equipe_mobilizacoes m JOIN equipes e ON e.id = m.equipe_id
         ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
         ORDER BY m.mobilizada_em DESC`,
      params
    );
    return rows.map(mobilizacaoDeLinha);
  }
  const [lista, equipes] = await Promise.all([readCollection(COL.mobilizacoes), readCollection(COL.equipes)]);
  const nomes = new Map(equipes.map((e) => [e.id, e.nome]));
  return lista
    .filter((m) => (!filtros.ocorrenciaId || m.ocorrenciaId === filtros.ocorrenciaId) &&
      (!filtros.equipeId || m.equipeId === filtros.equipeId) &&
      (!filtros.status || m.status === filtros.status))
    .sort((a, b) => (b.mobilizadaEm || 0) - (a.mobilizadaEm || 0))
    .map((m) => ({ ...m, equipeNome: nomes.get(m.equipeId) || null }));
}

function mobilizacaoDeLinha(r) {
  return {
    id: r.id,
    equipeId: r.equipe_id,
    equipeNome: r.equipe_nome || null,
    ocorrenciaId: r.ocorrencia_id,
    organizacaoId: r.organizacao_id,
    status: r.status,
    mobilizadaEm: toMs(r.mobilizada_em),
    chegadaEm: toMs(r.chegada_em),
    encerradaEm: toMs(r.encerrada_em),
    atividades: r.atividades || '',
    recursos: r.recursos || {},
  };
}

async function criarMobilizacao(dados, escopo) {
  const status = String(dados.status || 'mobilizada').toLowerCase();
  if (!MOBILIZACAO_STATUS.includes(status)) throw erro(400, 'Status de mobilização inválido.', 'CAMPO_INVALIDO');
  if (!uuidValido(dados.equipeId)) throw erro(400, 'equipeId inválido.', 'CAMPO_INVALIDO');
  if (!uuidValido(dados.ocorrenciaId)) throw erro(400, 'ocorrenciaId inválido.', 'CAMPO_INVALIDO');

  if (pg()) {
    const ocorrencia = await obterOcorrencia(dados.ocorrenciaId);
    if (!ocorrencia) throw erro(404, 'Ocorrência não encontrada.', 'NAO_ENCONTRADA');
    if (escopo.municipioRestrito && normalizar(ocorrencia.municipio) !== escopo.municipioRestrito) {
      throw erro(403, 'Acesso limitado às ocorrências do seu município.', 'FORA_DO_ESCOPO');
    }
    const { rows } = await getPool().query(
      `INSERT INTO equipe_mobilizacoes
         (equipe_id, ocorrencia_id, organizacao_id, status, atividades, recursos, atualizada_por)
       VALUES ($1,$2,$3,$4::mobilizacao_status,$5,$6::jsonb,$7)
       RETURNING *`,
      [
        dados.equipeId, dados.ocorrenciaId,
        dados.organizacaoId || ocorrencia.organizacaoId,
        status, texto(dados.atividades, { campo: 'atividades', max: 2000 }),
        JSON.stringify(dados.recursos && typeof dados.recursos === 'object' ? dados.recursos : {}),
        escopo.usuarioId,
      ]
    );
    return mobilizacaoDeLinha(rows[0]);
  }

  const ocorrencia = await obterOcorrencia(dados.ocorrenciaId);
  if (!ocorrencia) throw erro(404, 'Ocorrência não encontrada.', 'NAO_ENCONTRADA');
  if (escopo.municipioRestrito && normalizar(ocorrencia.municipio) !== escopo.municipioRestrito) {
    throw erro(403, 'Acesso limitado às ocorrências do seu município.', 'FORA_DO_ESCOPO');
  }
  const equipes = await readCollection(COL.equipes);
  const equipe = equipes.find((e) => e.id === dados.equipeId);
  if (!equipe) throw erro(404, 'Equipe não encontrada.', 'NAO_ENCONTRADA');
  const lista = await readCollection(COL.mobilizacoes);
  if (lista.some((m) => m.equipeId === dados.equipeId && m.ocorrenciaId === dados.ocorrenciaId && m.status !== 'encerrada')) {
    throw erro(409, 'Já existe mobilização aberta desta equipe para a ocorrência.', 'DUPLICADO');
  }
  const nova = {
    id: crypto.randomUUID(),
    equipeId: dados.equipeId,
    equipeNome: equipe.nome,
    ocorrenciaId: dados.ocorrenciaId,
    organizacaoId: dados.organizacaoId || ocorrencia.organizacaoId || 'BR',
    status,
    mobilizadaEm: Date.now(),
    chegadaEm: null,
    encerradaEm: null,
    atividades: texto(dados.atividades, { campo: 'atividades', max: 2000 }),
    recursos: dados.recursos && typeof dados.recursos === 'object' ? dados.recursos : {},
  };
  lista.push(nova);
  await writeCollection(COL.mobilizacoes, lista);
  return nova;
}

async function atualizarMobilizacao(id, body, escopo) {
  if (!body || typeof body !== 'object') throw erro(400, 'Corpo inválido.', 'CORPO_INVALIDO');
  const status = body.status ? String(body.status).toLowerCase() : null;
  if (status && !MOBILIZACAO_STATUS.includes(status)) throw erro(400, 'Status de mobilização inválido.', 'CAMPO_INVALIDO');
  const atividades = Object.hasOwn(body, 'atividades')
    ? texto(body.atividades, { campo: 'atividades', max: 2000 }) : null;
  if (!status && atividades === null) throw erro(400, 'Informe status ou atividades.', 'SEM_ALTERACOES');

  if (pg()) {
    if (!uuidValido(id)) throw erro(400, 'Identificador inválido.', 'ID_INVALIDO');
    const sets = [];
    const params = [];
    if (status) { params.push(status); sets.push(`status = $${params.length}::mobilizacao_status`); }
    if (atividades !== null) { params.push(atividades); sets.push(`atividades = $${params.length}`); }
    if (status === 'no_local') sets.push('chegada_em = COALESCE(chegada_em, now())');
    if (status === 'encerrada') sets.push('encerrada_em = COALESCE(encerrada_em, now())');
    params.push(escopo.usuarioId); sets.push(`atualizada_por = $${params.length}`);
    sets.push('atualizada_em = now()');
    params.push(id);
    const { rows } = await getPool().query(
      `UPDATE equipe_mobilizacoes SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params
    );
    if (!rows.length) throw erro(404, 'Mobilização não encontrada.', 'NAO_ENCONTRADA');
    return mobilizacaoDeLinha(rows[0]);
  }

  const lista = await readCollection(COL.mobilizacoes);
  const idx = lista.findIndex((m) => m.id === id);
  if (idx < 0) throw erro(404, 'Mobilização não encontrada.', 'NAO_ENCONTRADA');
  const alvo = { ...lista[idx] };
  if (status) alvo.status = status;
  if (atividades !== null) alvo.atividades = atividades;
  if (status === 'no_local' && !alvo.chegadaEm) alvo.chegadaEm = Date.now();
  if (status === 'encerrada' && !alvo.encerradaEm) alvo.encerradaEm = Date.now();
  lista[idx] = alvo;
  await writeCollection(COL.mobilizacoes, lista);
  return alvo;
}

/* ---------------- anexos (metadados) ---------------- */

async function listarAnexos(ocorrenciaId) {
  if (pg()) {
    const { rows } = await getPool().query(
      'SELECT * FROM ocorrencia_anexos WHERE ocorrencia_id = $1 ORDER BY criado_em', [ocorrenciaId]
    );
    return rows.map(anexoDeLinha);
  }
  const lista = await readCollection(COL.anexos);
  return lista.filter((a) => a.ocorrenciaId === ocorrenciaId);
}

function anexoDeLinha(r) {
  return {
    id: r.id, ocorrenciaId: r.ocorrencia_id, nome: r.nome, mimeType: r.mime_type,
    tamanhoBytes: r.tamanho_bytes === null ? null : Number(r.tamanho_bytes),
    url: r.url, hashSha256: r.hash_sha256 || null, criadoEm: toMs(r.criado_em),
  };
}

async function criarAnexo(ocorrenciaId, dados, escopo) {
  const ocorrencia = await obterOcorrencia(ocorrenciaId);
  if (!ocorrencia) throw erro(404, 'Ocorrência não encontrada.', 'NAO_ENCONTRADA');
  if (escopo.municipioRestrito && normalizar(ocorrencia.municipio) !== escopo.municipioRestrito) {
    throw erro(403, 'Acesso limitado às ocorrências do seu município.', 'FORA_DO_ESCOPO');
  }
  const nome = texto(dados.nome, { campo: 'nome', min: 1, max: 200, obrigatorio: true });
  const mimeType = texto(dados.mimeType, { campo: 'mimeType', min: 3, max: 120, obrigatorio: true });
  const url = texto(dados.url, { campo: 'url', min: 8, max: 1000, obrigatorio: true });
  if (!/^https?:\/\//i.test(url) && !/^\/[^\s]*$/.test(url)) {
    throw erro(400, 'url deve ser http(s) ou caminho absoluto iniciado por /.', 'CAMPO_INVALIDO');
  }
  const tamanho = dados.tamanhoBytes === undefined || dados.tamanhoBytes === null
    ? null : inteiroNaoNegativo(dados.tamanhoBytes, { campo: 'tamanhoBytes', max: Number.MAX_SAFE_INTEGER });

  if (pg()) {
    const { rows } = await getPool().query(
      `INSERT INTO ocorrencia_anexos (ocorrencia_id, nome, mime_type, tamanho_bytes, url, hash_sha256, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ocorrenciaId, nome, mimeType, tamanho, url, dados.hashSha256 || null, escopo.usuarioId]
    );
    return anexoDeLinha(rows[0]);
  }
  const lista = await readCollection(COL.anexos);
  const novo = {
    id: crypto.randomUUID(), ocorrenciaId, nome, mimeType, tamanhoBytes: tamanho,
    url, hashSha256: dados.hashSha256 || null, criadoEm: Date.now(),
  };
  lista.push(novo);
  await writeCollection(COL.anexos, lista);
  return novo;
}

/* ---------------- resposta de erro padrão ---------------- */

function responderErro(e, origin) {
  const status = Number(e && e.statusCode) || 500;
  if (status >= 500) console.error('[central]', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
  return jsonResponse(status, {
    erro: status >= 500 ? 'Erro interno na Central de Ocorrências.' : (e.message || 'Erro.'),
    ...(e && e.code && status < 500 ? { codigo: e.code } : {}),
  }, origin);
}

/* ---------------- exportações ---------------- */

module.exports = {
  STATUS,
  STATUS_VALIDOS,
  STATUS_LEITURA,
  PRIORIDADES,
  VERIFICACOES,
  GRUPOS_TIPO,
  MOBILIZACAO_STATUS,
  erro,
  normalizar,
  sugerirPrioridade,
  autenticar,
  podeVerDadosRestritos,
  resolverOrganizacao,
  listarMunicipios,
  resolverMunicipio,
  listarTipos,
  criarTipo,
  listarOcorrencias,
  obterOcorrencia,
  criarOcorrencia,
  atualizarOcorrencia,
  normalizarNovaOcorrencia,
  normalizarDanos,
  estatisticas,
  listarEquipes,
  criarEquipe,
  criarMobilizacao,
  atualizarMobilizacao,
  listarMobilizacoes,
  listarAnexos,
  criarAnexo,
  responderErro,
};
