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

/* ============================================================
   Zeca — mascotinha animada fixa no canto inferior direito.
   Aparece em todas as páginas que carregam session.js.
   ============================================================ */
(function initZecaWidget() {
    const style = document.createElement('style');
    style.textContent = `
        #zecaWidget {
            position: fixed; bottom: 20px; right: 20px; z-index: 9000;
            display: flex; flex-direction: column; align-items: center; gap: 6px;
            cursor: pointer; pointer-events: auto;
            animation: zecaEntry .6s cubic-bezier(.2,1.4,.4,1) both;
        }
        @keyframes zecaEntry { from { opacity:0; transform:translateY(24px) scale(.7); } to { opacity:1; transform:none; } }
        #zecaWidget:hover .zeca-video { transform: scale(1.08); box-shadow: 0 6px 28px rgba(249,99,28,.45); }
        .zeca-video {
            width: 80px; height: 80px; border-radius: 50%; object-fit: cover;
            border: 2.5px solid var(--accent-orange, #f9631c);
            box-shadow: 0 4px 18px rgba(249,99,28,.3);
            transition: transform .25s, box-shadow .25s;
            background: #000;
        }
        .zeca-label {
            font-size: 10px; font-weight: 700; color: var(--accent-orange, #f9631c);
            background: rgba(16,28,61,.92); backdrop-filter: blur(6px);
            padding: 3px 10px; border-radius: 10px;
            border: 1px solid rgba(249,99,28,.35);
            white-space: nowrap;
            animation: zecaPulse 2.8s ease-in-out infinite;
        }
        @keyframes zecaPulse { 0%,100%{ box-shadow:none; } 50%{ box-shadow:0 0 10px rgba(249,99,28,.25); } }
        #zecaWidget.zeca-expanded .zeca-video {
            width: 220px; height: auto; aspect-ratio: 16/9;
            border-radius: 14px; object-fit: contain;
        }
        #zecaWidget.zeca-expanded .zeca-label { display: none; }
    `;
    document.head.appendChild(style);

    const widget = document.createElement('div');
    widget.id = 'zecaWidget';
    widget.title = 'Zeca — Mascote da Defesa Civil';
    widget.innerHTML = `
        <video class="zeca-video" autoplay loop muted playsinline>
            <source src="zeca/zeca.mp4" type="video/mp4">
        </video>
        <span class="zeca-label">Sou o Zeca!</span>
    `;
    document.body.appendChild(widget);

    widget.addEventListener('click', function() {
        const modal = document.getElementById('orientModal');
        if (modal) {
            modal.classList.add('open');
            const vid = modal.querySelector('video');
            if (vid) vid.play().catch(() => {});
        } else {
            widget.classList.toggle('zeca-expanded');
        }
    });
})();
