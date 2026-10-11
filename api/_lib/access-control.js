'use strict';

const INTERNAL_PAGES = new Map([
  ['painel.html', new Set(['admin', 'avancado', 'municipal', 'coordenador', 'analista', 'operador_campo', 'leitura'])],
  ['gestao.html', new Set(['admin', 'avancado', 'municipal', 'administrador_orgao', 'coordenador', 'analista', 'leitura'])],
  ['gestaodefrota.html', new Set(['admin', 'avancado', 'municipal', 'administrador_orgao', 'coordenador', 'operador_campo', 'leitura'])],
  ['vistoria.html', new Set(['admin', 'avancado', 'municipal', 'coordenador', 'operador_campo'])],
  ['meus-chamados.html', new Set(['admin', 'avancado', 'municipal', 'coordenador', 'analista', 'operador_campo', 'voluntario', 'leitura'])],
  ['cadastro-usuarios.html', new Set(['admin', 'administrador_orgao', 'coordenador'])],
]);

const PRIVATE_API_ROUTES = new Set([
  'gestao',
  'user-registrations',
]);

const WRITE_ROLES = new Set([
  'admin', 'avancado', 'municipal', 'administrador_orgao',
  'coordenador', 'analista', 'operador_campo'
]);

const ADMIN_ROLES = new Set(['admin', 'administrador_orgao']);
const COORDINATION_ROLES = new Set(['admin', 'avancado', 'administrador_orgao', 'coordenador']);

function pageRoles(page) {
  return INTERNAL_PAGES.get(String(page || '').toLowerCase()) || null;
}

function rolesFromLegacyProfile(profile) {
  if (profile === 'admin') return ['admin', 'administrador_orgao'];
  if (profile === 'avancado') return ['avancado', 'coordenador', 'analista'];
  if (profile === 'municipal') return ['municipal', 'operador_campo'];
  if (profile === 'comum') return ['comum'];
  return [];
}

function rolesForUser(user, access) {
  const assigned = access && Array.isArray(access.roles) ? access.roles : [];
  return [...new Set([...rolesFromLegacyProfile(user && user.perfil), ...assigned])];
}

function isCoordinator(user, access) {
  return rolesForUser(user, access).some(role => COORDINATION_ROLES.has(role));
}

function canManageOrganization(access, organizationId, parentOrganizationId) {
  return Boolean(access &&
    Array.isArray(access.directOrganizationIds) &&
    (access.directOrganizationIds.includes(String(organizationId)) ||
      (parentOrganizationId && access.directOrganizationIds.includes(String(parentOrganizationId)))) &&
    Array.isArray(access.roles) &&
    access.roles.some(role => ADMIN_ROLES.has(role) || role === 'coordenador'));
}

function apiPolicy(route, method) {
  const verb = String(method || 'GET').toUpperCase();
  if (route === 'user-registrations') {
    return verb === 'POST'
      ? { public: true, write: false }
      : { public: false, roles: ['admin', 'administrador_orgao', 'coordenador'], write: true };
  }
  if (PRIVATE_API_ROUTES.has(route)) {
    return { public: false, roles: [...WRITE_ROLES], write: verb !== 'GET' };
  }
  if ((route === 'areas' && verb !== 'GET') ||
      (route === 'occurrences' && verb !== 'GET') ||
      /^occurrences\/[^/]+$/.test(route) && verb !== 'GET' ||
      route === 'reports' && verb !== 'GET' ||
      route === 'pluv-alerta' && verb !== 'GET' ||
      route === 'pluv-alerta/avaliar') {
    return { public: false, roles: [...WRITE_ROLES], write: true };
  }
  return { public: true, write: false };
}

function databaseRolesForUser(user, access) {
  if (access && Array.isArray(access.roles)) return [...new Set(access.roles)];
  const legacy = {
    admin: ['admin', 'administrador_orgao'],
    avancado: ['avancado', 'coordenador', 'analista'],
    municipal: ['municipal', 'operador_campo'],
    comum: ['comum'],
  };
  return legacy[user && user.perfil] || [];
}

function canAccessPolicy(policy, context) {
  if (!policy || policy.public) return true;
  if (!context || context.authenticated !== true) return false;
  const roles = context.roles || [];
  if (!policy.roles || policy.roles.some(role => roles.includes(role))) return true;
  return false;
}

function inOrganizationScope(access, organizationId) {
  return Boolean(access &&
    Array.isArray(access.organizationIds) &&
    access.organizationIds.includes(String(organizationId)));
}

module.exports = {
  INTERNAL_PAGES,
  pageRoles,
  rolesForUser,
  databaseRolesForUser,
  isCoordinator,
  canManageOrganization,
  apiPolicy,
  canAccessPolicy,
  inOrganizationScope,
};
