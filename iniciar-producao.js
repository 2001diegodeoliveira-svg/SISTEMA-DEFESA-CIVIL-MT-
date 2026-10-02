/* ============================================================
   Inicia o servidor em modo PRODUÇÃO (servidor próprio).
   Carrega .env.producao -> .env -> variáveis já existentes.

   Uso:  node iniciar-producao.js
   ============================================================ */
const fs = require('fs');
const path = require('path');

const RAIZ = __dirname;

function aplicarArquivo(nome) {
  const p = path.join(RAIZ, nome);
  if (!fs.existsSync(p)) return false;
  for (const linha of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const valor = m[2].replace(/^["']|["']$/g, '');
    // .env só preenche o que ainda não estiver definido.
    if (process.env[m[1]] === undefined) process.env[m[1]] = valor;
  }
  return true;
}

aplicarArquivo('.env.producao');
aplicarArquivo('.env.producao.local');
aplicarArquivo('.env');

// Este script é exclusivamente para servidor próprio:_flags da Vercel não
// devem vazar para o processo (elas alteram as regras de validação).
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
process.env.NODE_ENV = 'production';

const FALTANDO = ['JWT_SECRET', 'DATABASE_URL', 'CORS_ORIGIN', 'PROXY_HOSTS'];
const ausentes = FALTANDO.filter((chave) => !process.env[chave]);
if (ausentes.length) {
  console.error('Configuração de produção incompleta. Faltam: ' + ausentes.join(', '));
  console.error('Preencha o arquivo .env.producao (veja .env.example).');
  process.exit(1);
}

console.log('Iniciando em modo produção (PostgreSQL) na porta ' + (process.env.PORT || 3000));
require('./server.js');
