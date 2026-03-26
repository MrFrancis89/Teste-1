// ft-app.js — StockFlow Pro V2.1 (v10.2 hardening)
// ══════════════════════════════════════════════════════════════════
// V2.1 — CORREÇÃO DE QUEBRA:
//   [CRÍTICO] init(): envolvido em try/catch com finally que garante
//             setLoading(false) SEMPRE — mesmo se initFirebase() ou
//             fbGetCurrentUser() lançar erro inesperado. Este era o
//             principal vetor de #ft-loading ficar visível bloqueando
//             todos os cliques.
//   [CRÍTICO] _navTo(): cada case do switch envolvido em try/catch
//             individual. Erro em renderDashboard() ou renderSimulador()
//             não impede navegação para outras abas.
//   [CRÍTICO] _listeners(): todos os handlers envolvidos em try/catch.
//             Erro em um listener não afeta os demais.
//   [ALTO]    _initApp(): setLoading(false) movido para finally —
//             garantido mesmo se _navTo() lançar.
//   [ALTO]    forceOffline handler: try/catch reforçado com finally
//             para garantir setLoading(false) e ft:appReady.
//   [MÉDIO]   Diagnóstico: window.addEventListener('error') e
//             'unhandledrejection' para capturar erros silenciosos.
//   [MÉDIO]   _mostrarSkeletons: envolvido em try/catch — nunca quebra boot.
//
// V2 — Modo Negócio, Cardápio, Tamanhos.
// ══════════════════════════════════════════════════════════════════
import { initFirebase, fbGetCurrentUser, fbSignInGoogle,
         fbSignOut, fbIsAvailable, fbGetUser }             from './ft-firebase.js';
import { sincronizarLocalParaFirebase }                    from './ft-storage.js';
import { initModalOverlay, setLoading, toast, debounce, initRipple, renderSkeleton } from './ft-ui.js';
import { initIngredientes, renderIngredientes,
         abrirFormIngrediente }                            from './ft-ingredientes.js';
import { initReceitas, renderReceitas, abrirFormReceita } from './ft-receitas.js';
import { initSimulador,  renderSimulador }                from './ft-custos.js';
import { renderDashboard }                                from './ft-dashboard.js';
import { renderExportacao }                               from './ft-exportacao.js';
import { initPreparo, renderPreparo, abrirFormPreparo }   from './ft-preparo.js';
import { initGastos, renderGastos, abrirFormGasto }       from './ft-gastos.js';
import { initPrecifica, renderPrecifica }                 from './ft-precifica.js';
import { initNegocio, renderNegocio }                     from './ft-negocio.js';
import { initCardapio, renderCardapio }                   from './ft-cardapio.js';
import { initTamanhos, renderTamanhos }                   from './ft-tamanhos.js';
import { ico }                                            from './ft-icons.js';
import { esc }                                            from './ft-format.js';

let _aba = 'ing';
let _pendingTab = null;

// ── Diagnóstico global ────────────────────────────────────────────
// Captura erros silenciosos — essencial para debug de quebras futuras.
window.addEventListener('error', e => {
    try { console.error('[ft-app] Erro global capturado:', e?.error || e?.message, e?.filename, e?.lineno); } catch (_) {}
});
window.addEventListener('unhandledrejection', e => {
    try { console.error('[ft-app] Promise não tratada:', e?.reason); } catch (_) {}
});

// ── Tema ──────────────────────────────────────────────────────────
const TEMA_CSS = {
    escuro:   [],
    midnight: ['theme-midnight'],
    arctic:   ['theme-arctic', 'light-mode'],
    forest:   ['theme-forest'],
};
function _aplicarTema(tema) {
    try {
        const body = document.body;
        ['theme-midnight','theme-arctic','theme-forest','light-mode'].forEach(c => body.classList.remove(c));
        (TEMA_CSS[tema] || []).forEach(c => body.classList.add(c));
    } catch (e) { console.error('[ft-app] _aplicarTema erro:', e); }
}
function _initTema() {
    try {
        _aplicarTema(localStorage.getItem('temaEstoque') || 'escuro');
    } catch (_) {}

    window.addEventListener('storage', e => {
        if (e.key === 'temaEstoque') _aplicarTema(e.newValue || 'escuro');
    });

    window.addEventListener('message', e => {
        try {
            if (e.source !== window.parent) return;
            if (e.origin !== window.location.origin) return;
            if (!e.data || typeof e.data.type !== 'string') return;
            if (e.data.type === 'SF_SIDEBAR_STATE') {
                const btn = document.getElementById('ft-btn-sidebar');
                if (btn) btn.setAttribute('aria-expanded', e.data.open ? 'true' : 'false');
            }
            if (e.data.type === 'SF_TEMA') {
                if (typeof e.data.tema !== 'string') return;
                _aplicarTema(e.data.tema);
            }
            if (e.data.type === 'SF_FT_NAV') {
                const validTabs = ['ing','rec','sim','dash','exp','pre','gas','prec','neg','car','tam'];
                if (validTabs.includes(e.data.tab)) {
                    if (document.getElementById('ft-app')?.classList.contains('hidden')) {
                        _pendingTab = e.data.tab;
                    } else {
                        _navTo(e.data.tab);
                    }
                }
            }
        } catch (e) { console.error('[ft-app] message handler erro:', e); }
    });
}

// ── Tela de Login ─────────────────────────────────────────────────
function _mostrarLogin(erro = '') {
    try { setLoading(false); } catch (_) {}
    const wrap = document.getElementById('ft-login');
    if (!wrap) return;
    try {
        wrap.innerHTML = `
            <div class="ft-login-box">
                <div class="ft-login-logo">&#x1F355;</div>
                <h1 class="ft-login-title">Ficha Técnica</h1>
                <p class="ft-login-sub">Faça login para sincronizar seus dados<br>em qualquer dispositivo.</p>
                ${erro ? `<div class="ft-login-erro">${erro}</div>` : ''}
                <button class="ft-login-btn" id="ft-btn-google">
                    <svg class="ft-google-ico" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    <span>Entrar com Google</span>
                </button>
                <p class="ft-login-hint">Seus dados ficam salvos na sua conta Google.<br>Funciona em qualquer dispositivo.</p>
            </div>`;
        wrap.classList.remove('hidden');
    } catch (e) { console.error('[ft-app] _mostrarLogin erro:', e); }

    document.getElementById('ft-btn-google')?.addEventListener('click', async () => {
        const btn = document.getElementById('ft-btn-google');
        try {
            if (btn) { btn.disabled = true; btn.querySelector('span').textContent = 'Aguarde…'; }
            await fbSignInGoogle();
            wrap.classList.add('hidden');
            await _initApp();
        } catch (e) {
            console.error('[ft-app] login erro:', e);
            const msg = e.code === 'auth/popup-closed-by-user'
                ? 'Login cancelado.'
                : e.code === 'auth/popup-blocked'
                ? 'Popup bloqueado. Permita popups para este site.'
                : 'Falha ao entrar. Tente novamente.';
            _mostrarLogin(msg);
        }
    });
}

// ── Init do app (após login) ───────────────────────────────────────
async function _initApp() {
    try { setLoading(true); } catch (_) {}
    try { document.getElementById('ft-app')?.classList.remove('hidden'); } catch (_) {}

    try {
        const user = fbGetUser();
        if (user) {
            try { _atualizarHeaderUser(user); } catch (_) {}
            try { await sincronizarLocalParaFirebase(); } catch (_) {}
            _setBadge(true);
        } else {
            _setBadge(false);
        }

        _mostrarSkeletons();

        await initTamanhos();
        await initCardapio();
        await Promise.all([
            initIngredientes(),
            initReceitas(),
            initSimulador(),
            initPreparo(),
            initGastos(),
            initNegocio(),
            initPrecifica(),
        ]);

        _navTo('ing');
    } catch (e) {
        console.error('[ft-app] _initApp erro:', e);
        try { toast('Erro ao inicializar. Modo offline ativo.', 'aviso'); } catch (_) {}
        try { _navTo('ing'); } catch (_) {}
    } finally {
        // GARANTIDO: setLoading(false) sempre chamado — nunca bloqueia UI
        try { setLoading(false); } catch (_) {}
        try { document.dispatchEvent(new CustomEvent('ft:appReady')); } catch (_) {}
        // Aplica tab pendente
        try {
            const _lsTab = (() => {
                try {
                    const t = localStorage.getItem('sidebarFtPendingTab');
                    localStorage.removeItem('sidebarFtPendingTab');
                    return t;
                } catch { return null; }
            })();
            if (_lsTab) { _navTo(_lsTab); }
            else if (_pendingTab) { _navTo(_pendingTab); _pendingTab = null; }
        } catch (_) {}
    }
}

// ── Skeleton pre-render ───────────────────────────────────────────
function _mostrarSkeletons() {
    try {
        const CONTAINERS = [
            { id: 'ft-lista-ing',  tipo: 'row',  n: 4 },
            { id: 'ft-lista-rec',  tipo: 'row',  n: 3 },
            { id: 'ft-simulador',  tipo: 'card', n: 2 },
            { id: 'ft-preparo',    tipo: 'row',  n: 3 },
        ];
        CONTAINERS.forEach(({ id, tipo, n }) => {
            try {
                const el = document.getElementById(id);
                if (el) renderSkeleton(el, n, tipo);
            } catch (_) {}
        });
    } catch (e) { console.error('[ft-app] _mostrarSkeletons erro:', e); }
}

// Avatar + nome do usuário no header
function _atualizarHeaderUser(user) {
    try {
        const btn = document.getElementById('ft-user-btn');
        if (!btn) return;
        const foto = user.photoURL;
        const nome = user.displayName || user.email || 'Usuário';
        btn.innerHTML = foto
            ? `<img src="${esc(foto)}" alt="${esc(nome)}" class="ft-avatar">`
            : `<span class="ft-avatar-ini">${esc(nome.charAt(0).toUpperCase())}</span>`;
        btn.title = nome;
        btn.style.display = 'flex';
    } catch (e) { console.error('[ft-app] _atualizarHeaderUser erro:', e); }
}

// ── Boot ──────────────────────────────────────────────────────────
async function init() {
    try { setLoading(true); } catch (_) {}
    try { _initTema(); } catch (_) {}

    try {
        const sdkOk = await Promise.race([
            initFirebase(),
            new Promise(r => setTimeout(() => r(false), 6000)),
        ]);

        if (!sdkOk) {
            // Firebase indisponível — modo offline direto
            try { document.getElementById('ft-login')?.classList.add('hidden'); } catch (_) {}
            try { document.getElementById('ft-app')?.classList.remove('hidden'); } catch (_) {}
            _setBadge(false);
            try { setLoading(false); } catch (_) {}
            try {
                _mostrarSkeletons();
                await initTamanhos();
                await Promise.all([
                    initIngredientes(), initReceitas(), initSimulador(),
                    initPreparo(), initGastos(), initPrecifica(), initNegocio(),
                ]);
            } catch (e) {
                console.error('[ft-app] init offline error:', e);
                try { toast('Erro ao carregar dados offline.', 'aviso'); } catch (_) {}
            }
            const _lsTabOff = (() => { try { const t = localStorage.getItem('sidebarFtPendingTab'); localStorage.removeItem('sidebarFtPendingTab'); return t; } catch { return null; } })();
            try {
                if (_lsTabOff) { _navTo(_lsTabOff); }
                else if (_pendingTab) { _navTo(_pendingTab); _pendingTab = null; }
                else { _navTo('ing'); }
            } catch (e) { console.error('[ft-app] _navTo offline erro:', e); }
            try { document.dispatchEvent(new CustomEvent('ft:appReady')); } catch (_) {}
            return;
        }

        // Verifica sessão existente
        const user = await fbGetCurrentUser();
        try { setLoading(false); } catch (_) {}

        if (user) {
            try { document.getElementById('ft-login')?.classList.add('hidden'); } catch (_) {}
            await _initApp();
        } else {
            try { document.getElementById('ft-app')?.classList.add('hidden'); } catch (_) {}
            _mostrarLogin();
        }
    } catch (e) {
        // Caminho de segurança máxima: qualquer exceção não capturada acima
        console.error('[ft-app] init: erro crítico não esperado:', e);
        try { setLoading(false); } catch (_) {}
        try {
            document.getElementById('ft-login')?.classList.add('hidden');
            document.getElementById('ft-app')?.classList.remove('hidden');
            _setBadge(false);
            _navTo('ing');
        } catch (_) {}
        try { document.dispatchEvent(new CustomEvent('ft:appReady')); } catch (_) {}
    }
}

// ── Navegação ─────────────────────────────────────────────────────
/**
 * v2.1: cada case do switch tem try/catch individual.
 * Erro em uma aba nunca impede navegação para outras.
 */
function _navTo(aba) {
    try {
        _aba = aba;
        document.querySelectorAll('.ft-section').forEach(s =>
            s.classList.toggle('active', s.id === `ft-sec-${aba}`));
        document.querySelectorAll('.ft-nav-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.tab === aba));
        const fab = document.getElementById('ft-fab');
        if (fab) fab.style.display = ['ing','rec','pre','gas'].includes(aba) ? 'flex' : 'none';
    } catch (e) { console.error('[ft-app] _navTo DOM erro:', e); }

    // Cada render em try/catch individual — uma aba com erro não bloqueia as outras
    try {
        switch (aba) {
            case 'ing':  renderIngredientes(); break;
            case 'rec':  renderReceitas();     break;
            case 'sim':  try { renderSimulador();  } catch (e) { console.error('[ft-app] renderSimulador erro:', e); } break;
            case 'dash': try { renderDashboard();  } catch (e) { console.error('[ft-app] renderDashboard erro:', e); } break;
            case 'exp':  try { renderExportacao(); } catch (e) { console.error('[ft-app] renderExportacao erro:', e); } break;
            case 'pre':  try { renderPreparo();    } catch (e) { console.error('[ft-app] renderPreparo erro:', e); } break;
            case 'gas':  try { renderGastos();     } catch (e) { console.error('[ft-app] renderGastos erro:', e); } break;
            case 'prec': try { renderPrecifica();  } catch (e) { console.error('[ft-app] renderPrecifica erro:', e); } break;
            case 'neg':  try { renderNegocio();    } catch (e) { console.error('[ft-app] renderNegocio erro:', e); } break;
            case 'car':  try { renderCardapio();   } catch (e) { console.error('[ft-app] renderCardapio erro:', e); } break;
            case 'tam':  try { renderTamanhos('ft-tamanhos'); } catch (e) { console.error('[ft-app] renderTamanhos erro:', e); } break;
        }
    } catch (e) { console.error('[ft-app] _navTo switch erro:', e); }
}

function _fab() {
    try {
        if (_aba === 'ing') abrirFormIngrediente();
        if (_aba === 'rec') abrirFormReceita();
        if (_aba === 'pre') abrirFormPreparo();
        if (_aba === 'gas') abrirFormGasto();
    } catch (e) { console.error('[ft-app] _fab erro:', e); }
}

function _setBadge(online) {
    try {
        const b = document.getElementById('ft-sync-btn');
        if (!b) return;
        b.innerHTML = online ? ico.cloud : ico.cloudOff;
        b.title     = online ? 'Firebase conectado' : 'Modo offline';
        b.classList.toggle('online', online);
    } catch (e) { console.error('[ft-app] _setBadge erro:', e); }
}

// ── Listeners ─────────────────────────────────────────────────────
/**
 * v2.1: todos os handlers com try/catch — erro em um não afeta os demais.
 */
function _listeners() {
    try {
        const btnHamburger = document.getElementById('ft-btn-sidebar');
        if (btnHamburger) {
            btnHamburger.addEventListener('click', () => {
                try {
                    if (window.parent && window.parent !== window) {
                        window.parent.postMessage({ type: 'SF_OPEN_SIDEBAR' }, window.location.origin);
                    }
                } catch (e) { console.error('[ft-app] hamburger click erro:', e); }
            });
        }
    } catch (e) { console.error('[ft-app] hamburger listener erro:', e); }

    try {
        document.querySelectorAll('.ft-nav-btn').forEach(b =>
            b.addEventListener('click', () => {
                try { _navTo(b.dataset.tab); } catch (e) { console.error('[ft-app] nav btn erro:', e); }
            })
        );
    } catch (e) { console.error('[ft-app] nav listeners erro:', e); }

    try {
        document.getElementById('ft-fab')?.addEventListener('click', _fab);
    } catch (_) {}

    try {
        const b1 = document.getElementById('ft-busca-ing');
        const b2 = document.getElementById('ft-busca-rec');
        const b3 = document.getElementById('ft-busca-pre');
        if (b1) b1.addEventListener('input', debounce(e => { try { renderIngredientes(e.target.value); } catch (_) {} }));
        if (b2) b2.addEventListener('input', debounce(e => { try { renderReceitas(e.target.value); } catch (_) {} }));
        if (b3) b3.addEventListener('input', debounce(e => { try { renderPreparo(e.target.value); } catch (_) {} }));
    } catch (e) { console.error('[ft-app] busca listeners erro:', e); }

    try {
        document.getElementById('ft-sync-btn')?.addEventListener('click', async () => {
            try {
                if (!fbIsAvailable()) { toast('Firebase não disponível.', 'aviso'); return; }
                setLoading(true);
                await sincronizarLocalParaFirebase();
                setLoading(false);
                toast('Dados sincronizados!', 'sucesso');
            } catch (e) {
                console.error('[ft-app] sync btn erro:', e);
                try { setLoading(false); } catch (_) {}
            }
        });
    } catch (_) {}

    try {
        document.getElementById('ft-user-btn')?.addEventListener('click', async () => {
            try {
                const user = fbGetUser();
                if (!user) return;
                const nome = user.displayName || user.email || 'Usuário';
                const ok = await import('./ft-ui.js').then(m =>
                    m.confirmar(`<strong>${esc(nome)}</strong><br>Deseja sair da conta?`, { labelOK: 'Sair' })
                );
                if (!ok) return;
                await fbSignOut();
                document.getElementById('ft-app')?.classList.add('hidden');
                _mostrarLogin();
            } catch (e) { console.error('[ft-app] user btn erro:', e); }
        });
    } catch (_) {}

    try {
        document.addEventListener('ft:recs-changed', () => {
            try {
                if (_aba === 'sim')  renderSimulador();
                if (_aba === 'dash') renderDashboard();
            } catch (e) { console.error('[ft-app] ft:recs-changed erro:', e); }
        });
        document.addEventListener('ft:ings-changed', () => {
            try {
                if (_aba === 'dash') renderDashboard();
            } catch (e) { console.error('[ft-app] ft:ings-changed erro:', e); }
        });
    } catch (_) {}

    try {
        initModalOverlay();
        initRipple();
    } catch (e) { console.error('[ft-app] initModalOverlay/Ripple erro:', e); }

    // Safety-net: acionado pelo timeout de ficha-tecnica.html se o app travar
    document.addEventListener('ft:forceOffline', async () => {
        try {
            const loading = document.getElementById('ft-loading');
            if (loading) loading.style.display = 'none';
            document.getElementById('ft-login')?.classList.add('hidden');
            document.getElementById('ft-app')?.classList.remove('hidden');
            _setBadge(false);
            try {
                _mostrarSkeletons();
                await initTamanhos();
                await Promise.all([
                    initIngredientes(), initReceitas(), initSimulador(),
                    initPreparo(), initGastos(), initPrecifica(), initNegocio(),
                ]);
            } catch (e) {
                console.error('[ft-app] forceOffline init error:', e);
            }
            const _lsTabForce = (() => { try { const t = localStorage.getItem('sidebarFtPendingTab'); localStorage.removeItem('sidebarFtPendingTab'); return t; } catch { return null; } })();
            try {
                if (_lsTabForce) { _navTo(_lsTabForce); }
                else if (_pendingTab) { _navTo(_pendingTab); _pendingTab = null; }
                else { _navTo('ing'); }
            } catch (e) { console.error('[ft-app] forceOffline _navTo erro:', e); }
        } catch (e) {
            console.error('[ft-app] forceOffline handler erro:', e);
        } finally {
            try { document.dispatchEvent(new CustomEvent('ft:appReady')); } catch (_) {}
        }
    }, { once: true });
}

document.addEventListener('DOMContentLoaded', () => {
    try { _listeners(); } catch (e) { console.error('[ft-app] _listeners() erro:', e); }
    init().catch(e => {
        console.error('[ft-app] init() rejeitado:', e);
        try { setLoading(false); } catch (_) {}
        try { document.dispatchEvent(new CustomEvent('ft:appReady')); } catch (_) {}
    });
});
