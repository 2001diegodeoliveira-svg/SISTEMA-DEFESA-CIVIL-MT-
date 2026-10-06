/* ============================================================
   Proteção básica de interface — trava a cópia simples e os
   atalhos de inspeção (F12, Ctrl+U, Ctrl+Shift+I/J/C/K).

   Não substitui controle de acesso no servidor: é apenas uma
   barreira contra inspeção acidental/rankeira da interface.

   ATIVO = false desativa tudo (útil em desenvolvimento).
   ============================================================ */
(function (global) {
    'use strict';

    var ATIVO = true;
    var documento = global.document;
    if (!ATIVO || !documento) return;

    var CAMPOS = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

    /* Chave de atalho proibida (Ctrl/Shift + tecla). */
    var TECLAS_COMB = ['I', 'J', 'C', 'K'];

    function emCampo(alvo) {
        if (!alvo) return false;
        if (alvo.nodeType === 3) alvo = alvo.parentNode;
        return !!(alvo && typeof alvo.closest === 'function' && alvo.closest(CAMPOS));
    }

    function alvoDoEvento(evento) {
        return evento.target || (documento.activeElement) || null;
    }

    function bloquear(evento) {
        if (evento && evento.preventDefault) evento.preventDefault();
        if (evento && evento.stopPropagation) evento.stopPropagation();
        return false;
    }

    function protegerChave(evento) {
        var tecla = String((evento && evento.key) || '').toUpperCase();
        if (!tecla) return;
        var ctrl = evento.ctrlKey || evento.metaKey;
        var shift = evento.shiftKey;

        if (tecla === 'F12') return bloquear(evento);
        if (ctrl && shift && TECLAS_COMB.indexOf(tecla) !== -1) return bloquear(evento);
        if (ctrl && !shift && (tecla === 'U' || tecla === 'S')) return bloquear(evento);
    }

    function protegerMenu(evento) {
        if (emCampo(alvoDoEvento(evento))) return;
        bloquear(evento);
    }

    function protegerCopia(evento) {
        if (emCampo(alvoDoEvento(evento))) return;
        bloquear(evento);
    }

    function protegerArraste(evento) {
        var alvo = alvoDoEvento(evento);
        if (emCampo(alvo)) return;
        var tag = alvo && alvo.tagName ? alvo.tagName.toUpperCase() : '';
        if (tag === 'IMG' || tag === 'A' || (alvo && alvo.draggable === true)) bloquear(evento);
    }

    documento.addEventListener('contextmenu', protegerMenu, { capture: true, passive: false });
    documento.addEventListener('keydown', protegerChave, { capture: true, passive: false });
    documento.addEventListener('copy', protegerCopia, { capture: true, passive: false });
    documento.addEventListener('cut', protegerCopia, { capture: true, passive: false });
    documento.addEventListener('dragstart', protegerArraste, { capture: true, passive: false });

    /* Selecionar/copiar texto só dentro de campos de formulário. */
    var estilo = documento.createElement('style');
    estilo.setAttribute('data-protecao', 'dcmt');
    estilo.textContent = [
        'html, body, body * { -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none; }',
        CAMPOS + ' { -webkit-user-select: text; -moz-user-select: text; -ms-user-select: text; user-select: text; }',
        'body, a, img, button, [role="button"] { -webkit-touch-callout: none; }'
    ].join('\n');

    function injetar() {
        var pai = documento.head || documento.documentElement;
        if (pai && !pai.querySelector('style[data-protecao="dcmt"]')) pai.appendChild(estilo);
    }
    if (documento.head) injetar();
    else documento.addEventListener('DOMContentLoaded', injetar, { once: true });
})(window);
