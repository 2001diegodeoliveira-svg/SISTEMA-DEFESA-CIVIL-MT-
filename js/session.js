// Sessão desativada (acesso livre)
export function initSession() {
  // Sem verificação de login
}

export function isAuthenticated() {
  return true;
}

export function getCurrentUser() {
  return {
    id: 'anon',
    nome: 'Usuário',
    cargo: 'admin',
    perfil: 'admin',
    email: 'anon@defesacivil.mt.gov.br',
    unidade: 'CGDC',
    ativo: true,
  };
}

export function hasPermission() {
  return true;
}

export function requireAuth() {
  // Não redireciona
  return true;
}

export function logout() {
  // Sem ação
}

export function setAuthToken() {}
export function getAuthToken() {
  return null;
}
