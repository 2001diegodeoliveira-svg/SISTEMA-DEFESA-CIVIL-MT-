/* Registro em memoria do status das fontes usadas pelo painel Amazonia. */
const TTL = {
  'focos': 900,
  'deter': 1800,
  'territorios-ti': 86400,
  'territorios-uc': 86400,
  'ibge': 86400,
  'open-meteo': 600,
  'open-meteo-aq': 1800,
  'ana': 1800,
};

const registro = new Map();

function registrar(id, { ok, latenciaMs = null, erro = null }) {
  registro.set(id, { id, ok: !!ok, latenciaMs, erro: erro ? String(erro).slice(0, 200) : null, atualizadoEm: new Date().toISOString() });
}

function estado(id, r) {
  if (!r) return 'atrasado';
  const ttl = TTL[id] || 1800;
  const idade = Date.now() - Date.parse(r.atualizadoEm);
  if (!r.ok) return 'erro';
  if (idade <= ttl * 1000 * 2) return 'ok';
  if (idade <= ttl * 1000 * 8) return 'atrasado';
  return 'erro';
}

function listar() {
  const ids = Object.keys(TTL);
  // inclui tambem registrados dinamicamente
  const all = new Set([...ids, ...registro.keys()]);
  return [...all].map((id) => {
    const r = registro.get(id) || null;
    return {
      id,
      ttlSeg: TTL[id] || 1800,
      estado: estado(id, r),
      ultimoSucesso: r && r.ok ? r.atualizadoEm : null,
      ultimaFalha: r && !r.ok ? r.atualizadoEm : null,
      latenciaMs: r ? r.latenciaMs : null,
      erro: r ? r.erro : null,
      atualizadoEm: r ? r.atualizadoEm : null,
    };
  });
}

module.exports = { registrar, listar, TTL };