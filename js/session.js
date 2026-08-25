/* ============================================================
   Sessão demo — perfis da proposta técnica (item 9).
   Autenticação real ficará no backend; aqui apenas simulamos.
   ============================================================ */

function dcGetSession() {
    try { return JSON.parse(localStorage.getItem('dcmt_session')); } catch (e) { return null; }
}
function dcLogout() {
    localStorage.removeItem('dcmt_session');
    location.reload();
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
    } else {
        const perfilLabel = PERFIS[s.perfil]?.label || s.perfil;
        el.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:6px;padding:6px 8px 6px 12px;">
                <i class="fa-solid ${PERFIS[s.perfil]?.icone || 'fa-user'}" style="color:var(--accent-orange);font-size:13px;"></i>
                <div style="line-height:1.2;">
                    <div style="font-size:12px;font-weight:600;">${s.nome || perfilLabel}</div>
                    <div style="font-size:9.5px;color:var(--text-muted);">${perfilLabel}${s.municipio ? ' · ' + s.municipio : ''}</div>
                </div>
                <button onclick="dcLogout()" title="Sair" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:4px 6px;font-size:12px;">
                    <i class="fa-solid fa-right-from-bracket"></i>
                </button>
            </div>`;
    }
}

document.addEventListener('DOMContentLoaded', dcRenderUserArea);
