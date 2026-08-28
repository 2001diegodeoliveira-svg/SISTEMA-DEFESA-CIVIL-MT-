/* ============================================================
   Sessão da Defesa Civil MT.
   Autenticação real via backend: token JWT (dcmt_token) +
   perfil do usuário (dcmt_session). Se o backend estiver
   indisponível, mantém compatibilidade com a sessão demo local.
   ============================================================ */

function dcGetSession() {
    try { return JSON.parse(localStorage.getItem('dcmt_session')); } catch (e) { return null; }
}
function dcGetToken() {
    try { return localStorage.getItem('dcmt_token'); } catch (e) { return null; }
}

function dcLogout() {
    // encerra sessão no backend (best-effort) e limpa local
    if (window.dcApi) { window.dcApi.logout(); }
    localStorage.removeItem('dcmt_token');
    localStorage.removeItem('dcmt_session');
    location.reload();
}

/* Autentica no backend e guarda token + perfil.
   Retorna { ok, erro } para a página de login tratar. */
async function dcLogin(usuario, senha) {
    if (window.dcApi && window.dcApi.login) {
        try {
            const r = await window.dcApi.login(usuario, senha);
            if (r.ok && r.data && r.data.token) {
                localStorage.setItem('dcmt_token', r.data.token);
                localStorage.setItem('dcmt_session', JSON.stringify(r.data.user));
                return { ok: true, user: r.data.user };
            }
            return { ok: false, erro: (r.data && r.data.erro) || 'Credenciais inválidas.' };
        } catch (e) {
            return { ok: false, erro: 'Falha ao conectar com o servidor de autenticação.' };
        }
    }
    return { ok: false, erro: 'API indisponível.' };
}

function dcRenderUserArea() {
    const el = document.getElementById('userArea');
    if (!el) return;
    const s = dcGetSession();
    if (!s) {
        el.innerHTML = `
            <a href="login.html" style="display:flex;align-items:center;gap:7px;color:var(--text-muted);text-decoration:none;font-size:12.5px;font-weight:600;padding:8px 14px;border:1px solid var(--border-color);border-radius:6px;transition:all .2s;"
               onmouseover="this.style.color='#fff';this.style.borderColor='rgba(249,99,28,.5)'"
               onmouseout="this.style.color='var(--text-muted)';this.style.borderColor='var(--border-color)'">
                <i class="fa-solid fa-right-to-bracket"></i> Área restrita
            </a>`;
        return;
    }
    const perfilLabel = (typeof PERFIS !== 'undefined' && PERFIS[s.perfil]) ? PERFIS[s.perfil].label : (s.perfil || 'Usuário');
    const icone = (typeof PERFIS !== 'undefined' && PERFIS[s.perfil]) ? PERFIS[s.perfil].icone : 'user';
    el.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:6px;padding:6px 8px 6px 12px;">
            <i data-lucide="${icone}" style="color:var(--accent-orange);width:16px;height:16px;"></i>
            <div style="line-height:1.2;">
                <div style="font-size:12px;font-weight:600;">${s.nome || perfilLabel}</div>
                <div style="font-size:9.5px;color:var(--text-muted);">${perfilLabel}${s.municipio ? ' · ' + s.municipio : ''}</div>
            </div>
            <button onclick="dcLogout()" title="Sair" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:4px 6px;font-size:12px;">
                <i data-lucide="log-out" style="width:14px;height:14px;"></i>
            </button>
        </div>`;
    if (window.lucide) lucide.createIcons();
}

document.addEventListener('DOMContentLoaded', dcRenderUserArea);
