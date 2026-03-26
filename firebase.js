// firebase.js — StockFlow Pro v10.2
// ══════════════════════════════════════════════════════════════════
// v10.2 — CORREÇÃO DE QUEBRA + HARDENING SEGURO:
//   [CRÍTICO] fbSave/fbLoad/fbDelete: removido "throw e" dos blocos
//             catch. Erros são logados mas NUNCA relançados — a UI
//             nunca para por falha de infraestrutura Firebase.
//   [CRÍTICO] _colRef: removido "throw new Error" — substituído por
//             retorno null com log descritivo. Callers protegidos.
//   [CRÍTICO] fbSave/fbLoad/fbDelete: guards "if (!fbIsAvailable())"
//             agora retornam null/[] em vez de lançar erro.
//   [ALTO]    fbSignOut: não relança erro — apenas loga. Estado é
//             limpo mesmo se signOut falhar no SDK.
//   [MÉDIO]   fbSignInGoogle: mantém throw pois o login flow do
//             ft-app.js/auth.js trata o erro explicitamente.
//   [MÉDIO]   Todos os throws internos substituídos por console.error
//             + return de valor seguro.
//
// v10.1 — HARDENING: singleton blindado, logs estruturados, fbWatch
//         com fallback silencioso.
// v10.0 — Migração para Firebase SDK v10 Modular.
// ══════════════════════════════════════════════════════════════════

import { initializeApp, getApps, getApp }
    from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
import { getFirestore, collection, doc,
         setDoc, getDocs, deleteDoc, onSnapshot }
    from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';
import { getAuth, GoogleAuthProvider,
         signInWithPopup, signOut, onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';

// ── CONFIGURAÇÃO ──────────────────────────────────────────────────
const FIREBASE_CONFIG = {
    apiKey:            'AIzaSyCyEkDlF-9zYG6N-QoibYCCeyyNjr7YQ8I',
    authDomain:        'stockflow-pro-274d7.firebaseapp.com',
    projectId:         'stockflow-pro-274d7',
    storageBucket:     'stockflow-pro-274d7.firebasestorage.app',
    messagingSenderId: '1081617701534',
    appId:             '1:1081617701534:web:d2b8a296ddeaacc961f98f',
};

// ── Estado interno (privado) ──────────────────────────────────────
let _app   = null;
let _db    = null;
let _auth  = null;
let _uid   = null;
let _user  = null;
let _ready = false;
const _readyListeners = [];

let _initCalled = false;

// ── Exports de estado ─────────────────────────────────────────────
export function fbIsAvailable() { return _ready && !!_uid; }
export function fbGetUid()      { return _uid; }
export function fbGetUser()     { return _user; }

/**
 * Retorna a instância do Firestore db.
 * Nunca lança — retorna null se não inicializado.
 */
export function _getDb() { return _db; }

// ── Singleton Firebase ────────────────────────────────────────────
/**
 * Inicializa o Firebase SDK de forma IDEMPOTENTE.
 * Nunca lança erro — retorna false em caso de falha.
 */
export async function initFirebase() {
    if (_initCalled && _app && _db && _auth) {
        return true;
    }

    try {
        _app  = getApps().length === 0
            ? initializeApp(FIREBASE_CONFIG)
            : getApp();

        _db   = getFirestore(_app);
        _auth = getAuth(_app);

        _initCalled = true;
        console.info('[firebase] ✓ SDK inicializado (singleton seguro).');
        return true;
    } catch (e) {
        console.error('[firebase] ✗ Erro ao inicializar SDK:', e);
        return false;  // ← NUNCA lança — UI continua funcionando offline
    }
}

// ── Autenticação ──────────────────────────────────────────────────
export function fbGetCurrentUser() {
    return new Promise(resolve => {
        if (!_auth) { resolve(null); return; }
        try {
            const unsub = onAuthStateChanged(_auth, user => {
                try { unsub(); } catch (_) {}
                if (user) { _uid = user.uid; _user = user; _ready = true; }
                resolve(user || null);
            }, () => resolve(null));
        } catch (e) {
            console.error('[firebase] fbGetCurrentUser erro:', e);
            resolve(null);
        }
    });
}

export async function fbSignInGoogle() {
    // Login PODE lançar — o caller (ft-app.js / auth.js) trata explicitamente
    if (!_auth) throw new Error('[firebase] Firebase não inicializado.');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await signInWithPopup(_auth, provider);
    _uid   = cred.user.uid;
    _user  = cred.user;
    _ready = true;
    _readyListeners.forEach(fn => { try { fn(_user); } catch (_) {} });
    console.info(`[firebase] ✓ Login Google — UID: ${_uid}`);
    return cred.user;
}

export async function fbSignOut() {
    if (!_auth) return;
    try {
        await signOut(_auth);
    } catch (e) {
        // Loga mas NÃO relança — estado local é limpo de qualquer forma
        console.error('[firebase] ✗ Erro no logout (continuando limpeza local):', e);
    }
    // Limpa estado local independentemente de erro no SDK
    _uid        = null;
    _user       = null;
    _ready      = false;
    _initCalled = false;
    console.info('[firebase] ✓ Logout realizado (estado local limpo).');
}

export function onFirebaseReady(cb) {
    if (typeof cb === 'function') _readyListeners.push(cb);
}

// ── Referências internas ──────────────────────────────────────────
/**
 * Retorna referência de coleção ou null — NUNCA lança.
 * v10.2: substituído throw por log + return null.
 */
function _colRef(colecao) {
    if (!_db) {
        console.error(`[firebase] _colRef(${colecao}): _db é null — initFirebase() falhou ou não foi chamado.`);
        return null;
    }
    if (!_uid) {
        console.error(`[firebase] _colRef(${colecao}): _uid é null — usuário não autenticado.`);
        return null;
    }
    try {
        return collection(_db, 'users', _uid, colecao);
    } catch (e) {
        console.error(`[firebase] _colRef(${colecao}): erro ao construir referência:`, e);
        return null;
    }
}

// ── CRUD ──────────────────────────────────────────────────────────

/**
 * Salva (upsert) um documento.
 * v10.2: NUNCA lança — retorna false em caso de falha.
 */
export async function fbSave(colecao, id, dados) {
    if (!fbIsAvailable()) {
        console.error(`[firebase] fbSave(${colecao}/${id}): usuário não autenticado — operação ignorada.`);
        return false;
    }
    const ref = _colRef(colecao);
    if (!ref) return false;
    try {
        await setDoc(doc(ref, id), dados, { merge: true });
        return true;
    } catch (e) {
        console.error(`[firebase] ✗ fbSave(${colecao}/${id}):`, e);
        return false;  // ← NUNCA relança
    }
}

/**
 * Carrega todos os documentos de uma coleção.
 * v10.2: NUNCA lança — retorna [] em caso de falha.
 */
export async function fbLoad(colecao) {
    if (!fbIsAvailable()) {
        console.error(`[firebase] fbLoad(${colecao}): usuário não autenticado — retornando [].`);
        return [];
    }
    const ref = _colRef(colecao);
    if (!ref) return [];
    try {
        const snap = await getDocs(ref);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error(`[firebase] ✗ fbLoad(${colecao}):`, e);
        return [];  // ← NUNCA relança
    }
}

/**
 * Remove um documento.
 * v10.2: NUNCA lança — retorna false em caso de falha.
 */
export async function fbDelete(colecao, id) {
    if (!fbIsAvailable()) {
        console.error(`[firebase] fbDelete(${colecao}/${id}): usuário não autenticado — operação ignorada.`);
        return false;
    }
    const ref = _colRef(colecao);
    if (!ref) return false;
    try {
        await deleteDoc(doc(ref, id));
        return true;
    } catch (e) {
        console.error(`[firebase] ✗ fbDelete(${colecao}/${id}):`, e);
        return false;  // ← NUNCA relança
    }
}

/**
 * Observa mudanças em tempo real em uma coleção.
 * NUNCA lança — retorna noop em qualquer caso de falha.
 */
export function fbWatch(colecao, callback) {
    if (!fbIsAvailable()) {
        if (location.hostname === 'localhost' || new URLSearchParams(location.search).has('debug')) {
            console.debug(`[firebase] fbWatch(${colecao}): Firebase ainda não disponível — noop.`);
        }
        return () => {};
    }

    const ref = _colRef(colecao);
    if (!ref) return () => {};

    try {
        return onSnapshot(
            ref,
            snap => {
                try {
                    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
                } catch (cbErr) {
                    console.error(`[firebase] ✗ fbWatch(${colecao}): erro no callback:`, cbErr);
                }
            },
            e => {
                console.error(`[firebase] ✗ fbWatch(${colecao}): erro do listener Firestore:`, e);
            }
        );
    } catch (e) {
        console.error(`[firebase] ✗ fbWatch(${colecao}): falha ao registrar onSnapshot:`, e);
        return () => {};
    }
}
