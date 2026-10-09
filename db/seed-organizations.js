'use strict';

const IBGE_API = 'https://servicodados.ibge.gov.br/api/v1/localidades';

function normalizarNome(nome) {
  return String(nome)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function buscarLista(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw new Error(`IBGE respondeu HTTP ${response.status} para ${url}.`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(`Resposta inválida do IBGE para ${url}: era esperada uma lista.`);
  }
  return data;
}

async function carregarCatalogoIbge(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Este Node.js não disponibiliza fetch; é necessário Node.js 18 ou superior.');
  }

  const [estadosRaw, municipiosRaw] = await Promise.all([
    buscarLista(`${IBGE_API}/estados?orderBy=id`, fetchImpl),
    buscarLista(`${IBGE_API}/estados/51/municipios?orderBy=id`, fetchImpl)
  ]);

  const estados = estadosRaw.map(estado => ({
    codigo: String(estado.id),
    sigla: String(estado.sigla || ''),
    nome: String(estado.nome || '')
  }));
  const municipios = municipiosRaw.map(municipio => ({
    codigo: String(municipio.id),
    nome: String(municipio.nome || '')
  }));

  if (estados.length !== 27 ||
      estados.some(estado => !/^\d{2}$/.test(estado.codigo) || !estado.sigla || !estado.nome) ||
      new Set(estados.map(estado => estado.codigo)).size !== 27) {
    throw new Error('O catálogo de UFs retornado pelo IBGE está incompleto ou inválido; nenhum seed foi aplicado.');
  }
  if (!estados.some(estado => estado.codigo === '51' && estado.sigla === 'MT') ||
      municipios.length === 0 ||
      municipios.some(municipio => !/^51\d{5}$/.test(municipio.codigo) || !municipio.nome) ||
      new Set(municipios.map(municipio => municipio.codigo)).size !== municipios.length) {
    throw new Error('O catálogo de municípios de MT retornado pelo IBGE está inválido; nenhum seed foi aplicado.');
  }

  return { estados, municipios };
}

async function inserirTerritorios(client, rows) {
  if (!rows.length) return;
  const ids = rows.map(row => row.id);
  const codigos = rows.map(row => row.codigo);
  const nomes = rows.map(row => row.nome);
  const niveis = rows.map(row => row.nivel);
  const pais = rows.map(row => row.parentId);
  const organizacoes = rows.map(row => row.organizacaoId);

  await client.query(
    `INSERT INTO territorios (id, codigo_ibge, nome, nivel, parent_id, organizacao_id)
     SELECT id, codigo_ibge, nome, nivel, parent_id, organizacao_id
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       AS seed(id, codigo_ibge, nome, nivel, parent_id, organizacao_id)
     ON CONFLICT (id) DO UPDATE SET
       codigo_ibge = EXCLUDED.codigo_ibge,
       nome = EXCLUDED.nome,
       nivel = EXCLUDED.nivel,
       parent_id = EXCLUDED.parent_id,
       organizacao_id = EXCLUDED.organizacao_id`,
    [ids, codigos, nomes, niveis, pais, organizacoes]
  );
}

async function inserirOrganizacoes(client, rows) {
  if (!rows.length) return;
  await client.query(
    `INSERT INTO organizacoes (id, nome, sigla, nivel, parent_id, codigo_ibge, municipio_id)
     SELECT id, nome, sigla, nivel, parent_id, codigo_ibge, municipio_id
     FROM unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
       $6::text[], $7::integer[]
     ) AS seed(id, nome, sigla, nivel, parent_id, codigo_ibge, municipio_id)
     ON CONFLICT (id) DO UPDATE SET
       nome = EXCLUDED.nome,
       sigla = EXCLUDED.sigla,
       nivel = EXCLUDED.nivel,
       parent_id = EXCLUDED.parent_id,
       codigo_ibge = EXCLUDED.codigo_ibge,
       municipio_id = EXCLUDED.municipio_id`,
    [
      rows.map(row => row.id),
      rows.map(row => row.nome),
      rows.map(row => row.sigla),
      rows.map(row => row.nivel),
      rows.map(row => row.parentId),
      rows.map(row => row.codigo),
      rows.map(row => row.municipioId)
    ]
  );
}

async function seedOrganizacoes(client, catalogo) {
  const municipios = await client.query('SELECT id, nome, codigo_ibge FROM municipios');
  const existentes = new Map(municipios.rows.map(row => [normalizarNome(row.nome), row]));
  if (existentes.size !== municipios.rows.length) {
    throw new Error('Há municípios com nomes duplicados após normalização; seed cancelado para evitar associação incorreta.');
  }
  const atualizar = [];
  const inserir = [];
  const municipioIds = new Map();

  for (const municipio of catalogo.municipios) {
    const existente = existentes.get(normalizarNome(municipio.nome));
    if (existente) {
      if (existente.codigo_ibge && existente.codigo_ibge !== municipio.codigo) {
        throw new Error(`Código IBGE divergente para ${municipio.nome}; seed cancelado para evitar troca de identidade.`);
      }
      municipioIds.set(municipio.codigo, existente.id);
      if (!existente.codigo_ibge) atualizar.push({ id: existente.id, codigo: municipio.codigo });
    } else {
      inserir.push(municipio);
    }
  }

  if (atualizar.length) {
    await client.query(
      `UPDATE municipios AS m SET codigo_ibge = dados.codigo
       FROM unnest($1::integer[], $2::text[]) AS dados(id, codigo)
       WHERE m.id = dados.id`,
      [atualizar.map(row => row.id), atualizar.map(row => row.codigo)]
    );
  }
  if (inserir.length) {
    const created = await client.query(
      `INSERT INTO municipios (nome, codigo_ibge)
       SELECT nome, codigo_ibge
       FROM unnest($1::text[], $2::text[]) AS dados(nome, codigo_ibge)
       ON CONFLICT (nome) DO UPDATE SET codigo_ibge = EXCLUDED.codigo_ibge
       RETURNING id, codigo_ibge`,
      [inserir.map(row => row.nome), inserir.map(row => row.codigo)]
    );
    for (const row of created.rows) municipioIds.set(row.codigo_ibge, row.id);
  }
  const semId = catalogo.municipios.filter(municipio => !municipioIds.has(municipio.codigo));
  if (semId.length) {
    throw new Error(`Não foi possível associar todos os municípios de MT: ${semId.length} sem identificador local.`);
  }

  const estadoRaiz = {
    id: 'BR',
    codigo: null,
    nome: 'Brasil',
    sigla: 'BR',
    nivel: 'nacional',
    parentId: null,
    municipioId: null
  };
  const estados = catalogo.estados.map(estado => ({
    id: `UF-${estado.codigo}`,
    codigo: estado.codigo,
    nome: estado.nome,
    sigla: estado.sigla,
    nivel: 'estadual',
    parentId: 'BR',
    municipioId: null
  }));
  const municipiosMt = catalogo.municipios.map(municipio => ({
    id: `MUN-${municipio.codigo}`,
    codigo: municipio.codigo,
    nome: municipio.nome,
    sigla: null,
    nivel: 'municipal',
    parentId: 'UF-51',
    municipioId: municipioIds.get(municipio.codigo)
  }));

  await inserirOrganizacoes(client, [estadoRaiz]);
  await inserirTerritorios(client, [{
    id: 'BR',
    codigo: null,
    nome: 'Brasil',
    nivel: 'nacional',
    parentId: null,
    organizacaoId: 'BR'
  }]);
  await inserirOrganizacoes(client, estados);
  await inserirTerritorios(client, estados.map(estado => ({
    id: estado.id,
    codigo: estado.codigo,
    nome: estado.nome,
    nivel: 'estadual',
    parentId: 'BR',
    organizacaoId: estado.id
  })));
  await inserirOrganizacoes(client, municipiosMt);
  await inserirTerritorios(client, municipiosMt.map(municipio => ({
    id: municipio.id,
    codigo: municipio.codigo,
    nome: municipio.nome,
    nivel: 'municipal',
    parentId: 'UF-51',
    organizacaoId: municipio.id
  })));
}

async function carregarCatalogoPersistido(client) {
  const result = await client.query(
    `SELECT t.id, t.codigo_ibge, t.nome, t.nivel, t.parent_id,
            COALESCE(o.sigla, '') AS sigla
     FROM territorios t
     LEFT JOIN organizacoes o ON o.id = t.organizacao_id
     WHERE t.nivel IN ('estadual', 'municipal')
     ORDER BY t.codigo_ibge`
  );
  const estados = result.rows
    .filter(row => row.nivel === 'estadual')
    .map(row => ({ codigo: String(row.codigo_ibge), sigla: row.sigla, nome: row.nome }));
  const municipios = result.rows
    .filter(row => row.nivel === 'municipal' && row.parent_id === 'UF-51')
    .map(row => ({ codigo: String(row.codigo_ibge), nome: row.nome }));

  if (estados.length !== 27 ||
      estados.some(estado => !/^\d{2}$/.test(estado.codigo)) ||
      new Set(estados.map(estado => estado.codigo)).size !== 27 ||
      !estados.some(estado => estado.codigo === '51') ||
      municipios.length === 0 ||
      municipios.some(municipio => !/^51\d{5}$/.test(municipio.codigo))) {
    throw new Error('Não há catálogo IBGE previamente validado e completo no banco para usar como fallback.');
  }
  return { estados, municipios };
}

module.exports = {
  carregarCatalogoIbge,
  carregarCatalogoPersistido,
  seedOrganizacoes,
  normalizarNome
};
