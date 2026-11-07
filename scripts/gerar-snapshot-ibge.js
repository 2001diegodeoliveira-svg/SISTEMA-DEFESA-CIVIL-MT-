/* Gera snapshot local do IBGE para o SGI PROTEGE.
   - api/_lib/ibge-localidades.json  (estados + municÃ­pios com micro/meso)
   - geo/malhas/estados.geojson
   - geo/malhas/uf-XX.geojson        (municÃ­pios por UF, qualidade mÃ­nima)
   - geo/indicadores.json            (Censo 2022 + PIB 2023 via SIDRA)
   Uso: node gerar-snapshot-ibge.js
*/
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.cwd();
const API_LIB = path.join(ROOT, 'api', '_lib');
const GEO = path.join(ROOT, 'geo');
const MALHAS = path.join(GEO, 'malhas');

const UFS = ['11','12','13','14','15','16','17','21','22','23','24','25','26','27','28','29','31','32','33','35','41','42','43','50','51','52','53'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJson(url, tentativas = 3) {
  let ultimo;
  for (let t = 0; t < tentativas; t++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'SGI-Protege-Snapshot/1.0' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } finally { clearTimeout(timer); }
    } catch (e) {
      ultimo = e;
      if (t < tentativas - 1) await sleep(1200 * (t + 1));
    }
  }
  throw ultimo;
}

function log(msg) { console.log(new Date().toISOString().slice(11, 19) + ' ' + msg); }

(async () => {
  fs.mkdirSync(MALHAS, { recursive: true });

  log('estados...');
  const estados = await getJson('https://servicodados.ibge.gov.br/api/v1/localidades/estados?orderBy=nome');

  log('municÃ­pios (catÃ¡logo nacional)...');
  const municipios = await getJson('https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome');
  const porUf = {};
  for (const m of municipios) {
    const uf = String(m.id).slice(0, 2);
    (porUf[uf] = porUf[uf] || []).push({
      id: m.id,
      nome: m.nome,
      micro: m.microrregiao?.nome || null,
      meso: m.microrregiao?.mesorregiao?.nome || null,
    });
  }
  fs.writeFileSync(path.join(API_LIB, 'ibge-localidades.json'), JSON.stringify({
    atualizadoEm: new Date().toISOString(),
    fonte: 'IBGE â€” API de Localidades',
    estados,
    municipios: porUf,
  }));
  log('localidades: ' + estados.length + ' UFs, ' + municipios.length + ' municÃ­pios');

  log('malha dos estados...');
  const malhaEstados = await getJson('https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?formato=application/vnd.geo+json&intrarregiao=UF&qualidade=minima');
  fs.writeFileSync(path.join(MALHAS, 'estados.geojson'), JSON.stringify(malhaEstados));
  log('malha estados: ' + malhaEstados.features.length + ' features, ' + Math.round(fs.statSync(path.join(MALHAS, 'estados.geojson')).size / 1024) + ' KB');

  for (const uf of UFS) {
    const destino = path.join(MALHAS, 'uf-' + uf + '.geojson');
    if (fs.existsSync(destino) && fs.statSync(destino).size > 100) { log('malha ' + uf + ': jÃ¡ existe'); continue; }
    try {
      const j = await getJson('https://servicodados.ibge.gov.br/api/v3/malhas/estados/' + uf + '?formato=application/vnd.geo+json&intrarregiao=municipio&qualidade=minima');
      if (!j || !Array.isArray(j.features) || !j.features.length) throw new Error('malha vazia');
      fs.writeFileSync(destino, JSON.stringify(j));
      log('malha ' + uf + ': ' + j.features.length + ' municÃ­pios, ' + Math.round(fs.statSync(destino).size / 1024) + ' KB');
    } catch (e) {
      log('ERRO malha ' + uf + ': ' + (e.message || e));
    }
  }

  log('indicadores SIDRA/Censo 2022...');
  const [t4714, t9923, t5938] = await Promise.all([
    getJson('https://apisidra.ibge.gov.br/values/t/4714/n6/all/v/93,6318,614/p/2022'),
    getJson('https://apisidra.ibge.gov.br/values/t/9923/n6/all/v/93/p/2022/c1/1,2'),
    getJson('https://apisidra.ibge.gov.br/values/t/5938/n6/all/v/37/p/2023'),
  ]);
  const ind = {};
  const alvo = (cod) => (ind[cod] = ind[cod] || {});
  for (const row of t4714.slice(1)) {
    const cod = String(row.D1C || '').trim();
    if (!/^\d{7}$/.test(cod)) continue;
    const v = parseFloat(row.V);
    if (!Number.isFinite(v)) continue;
    if (row.D2C === '93') alvo(cod).populacao = v;
    else if (row.D2C === '6318') alvo(cod).areaKm2 = v;
    else if (row.D2C === '614') alvo(cod).densidade = v;
  }
  for (const row of t9923.slice(1)) {
    const cod = String(row.D1C || '').trim();
    if (!/^\d{7}$/.test(cod)) continue;
    const v = parseFloat(row.V);
    if (!Number.isFinite(v)) continue;
    if (row.D4C === '1') alvo(cod).populacaoUrbana = v;
    else if (row.D4C === '2') alvo(cod).populacaoRural = v;
  }
  for (const row of t5938.slice(1)) {
    const cod = String(row.D1C || '').trim();
    if (!/^\d{7}$/.test(cod)) continue;
    const v = parseFloat(row.V);
    if (!Number.isFinite(v)) continue;
    if (row.D2C === '37') alvo(cod).pibMilReais = v;
  }
  for (const cod of Object.keys(ind)) {
    const m = ind[cod];
    if (m.populacaoUrbana != null && m.populacaoRural != null && (m.populacaoUrbana + m.populacaoRural) > 0) {
      m.urbanizacaoPct = Math.round((m.populacaoUrbana / (m.populacaoUrbana + m.populacaoRural)) * 1000) / 10;
    }
    if (m.pibMilReais != null && m.populacao) {
      m.pibPerCapita = Math.round((m.pibMilReais * 1000 / m.populacao) * 100) / 100;
    }
  }
  fs.writeFileSync(path.join(GEO, 'indicadores.json'), JSON.stringify({
    atualizadoEm: new Date().toISOString(),
    fonte: 'IBGE â€” Censo 2022 (4714/9923) e PIB dos MunicÃ­pios 2023 (5938), via SIDRA',
    anos: { populacao: 2022, pib: 2023 },
    municipios: ind,
  }));
  log('indicadores: ' + Object.keys(ind).length + ' municÃ­pios, ' + Math.round(fs.statSync(path.join(GEO, 'indicadores.json')).size / 1024) + ' KB');

  log('OK');
})().catch(e => { console.error('FALHA GERAL:', e); process.exit(1); });

