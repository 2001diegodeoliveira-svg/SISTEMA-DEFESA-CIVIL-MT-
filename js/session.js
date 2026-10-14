/* ============================================================
   Sessão da SGI PROTEGE — modo público (sem login).
   ============================================================ */

function dcLoginExigido() {
    return false;
}

function dcSessaoDemo() {
    return {
        id: 'demo',
        usuario: 'visitante',
        nome: 'Acesso Público',
        perfil: 'admin',
        unidade: 'CGDC',
        municipio: '',
        demo: true,
    };
}

function dcGetSession() {
    return dcSessaoDemo();
}

function dcNorm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function dcMuniRestricao() {
    return null;
}

function dcGetToken() {
    return null;
}

function dcLogout() {
    // no-op in public mode
}

async function dcLogin(usuario, senha) {
    return { ok: false, erro: 'Login desativado — modo público.' };
}

function dcRenderUserArea() {
    const el = document.getElementById('userArea');
    if (!el) return;
    el.innerHTML = `
        <span style="color:var(--text-muted);font-size:12.5px;font-weight:600;padding:8px 14px;">
            Acesso Público
        </span>`;
    if (window.lucide) lucide.createIcons();
}

/* Navegação completa sempre visível no modo público. */
function dcAplicarNav() {
    // no-op: everything is visible
}

document.addEventListener('DOMContentLoaded', dcRenderUserArea);
document.addEventListener('DOMContentLoaded', dcAplicarNav);