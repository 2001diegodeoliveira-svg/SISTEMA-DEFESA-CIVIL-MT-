/* GET /api/municipios → { municipios: [{ municipio, usuario, nome }] }
   Listagem pública das contas de gestores municipais (todos os 142
   municípios de MT, incluindo Cuiabá). Usada na tela de login para o
   gestor municipal escolher o município e ter o usuário preenchido. */
const { jsonResponse } = require('./_lib/http');
const { ensureSeededUsers } = require('./_lib/auth');
const { serve } = require('./_lib/serverless');

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

  const users = await ensureSeededUsers();
  const municipios = users
    .filter((u) => u.perfil === 'municipal' && u.municipio)
    .sort((a, b) => String(a.municipio).localeCompare(String(b.municipio), 'pt-BR'))
    .map((u) => ({ municipio: u.municipio, usuario: u.usuario, nome: u.nome }));

  return jsonResponse(200, { municipios, total: municipios.length }, origin);
});