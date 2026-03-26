// firestoreGateway.js — StockFlow Pro v10.2
// ══════════════════════════════════════════════════════════════════
// GATEWAY ÚNICO DE ACESSO AO FIRESTORE
// ──────────────────────────────────────────────────────────────────
// v10.2 — CORREÇÃO DE QUEBRA:
//   [CRÍTICO] assertDb() substituído por verificação direta com
//             early-return null/[] — ZERO throws em qualquer função.
//   [CRÍTICO] _colRef: retorna null em vez de lançar. Todas as
//             funções que usam _colRef verificam o null antes de usar.
//   [ALTO]    gwSave/gwLoad/gwDelete: qualquer exceção é absorvida
//             internamente — nunca propagam para a UI.
//   [ALTO]    gwWatch: nunca lança — retorna noop () => {} em qualquer
//             condição de falha.
//   [MÉDIO]   gwLoad: retorna [] (nunca null) — callers podem usar
//             .length e .map sem verificação extra.
//
// v10.1 — Gateway criado: toda operação Firestore passa por aqui.
// ══════════════════════════════════════════════════════════════════

import {
    fbIsAvailable,
    fbGetUid,
    _getDb,
} from './firebase.js';

import {
    safeFirestoreCall,
    sfLog,
} from './firebase-safe.js';

import {
    collection,
    doc,
    setDoc,
    getDocs,
    deleteDoc,
    onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

const MOD = 'firestoreGateway';

// ── Helpers internos ──────────────────────────────────────────────

/**
 * Retorna referência de coleção ou null — NUNCA lança.
 * v10.2: assertDb substituído por verificações + return null.
 */
function _colRef(colecao) {
    if (!fbIsAvailable()) {
        sfLog.debug(MOD, `_colRef(${colecao}): Firebase indisponível.`);
        return null;
    }
    const db  = _getDb();
    const uid = fbGetUid();
    if (!db) {
        sfLog.error(MOD, `_colRef(${colecao}): _getDb() retornou null.`);
        return null;
    }
    if (!uid) {
        sfLog.error(MOD, `_colRef(${colecao}): fbGetUid() retornou null.`);
        return null;
    }
    try {
        return collection(db, 'users', uid, colecao);
    } catch (e) {
        sfLog.error(MOD, `_colRef(${colecao}): erro ao construir referência:`, e);
        return null;
    }
}

/**
 * Retorna referência de documento ou null — NUNCA lança.
 */
function _docRef(colecao, id) {
    const ref = _colRef(colecao);
    if (!ref) return null;
    try {
        return doc(ref, id);
    } catch (e) {
        sfLog.error(MOD, `_docRef(${colecao}/${id}): erro:`, e);
        return null;
    }
}

// ── CRUD ──────────────────────────────────────────────────────────

/**
 * Salva (upsert) um documento no Firestore.
 * v10.2: NUNCA lança — retorna false em caso de falha.
 */
export async function gwSave(colecao, id, dados) {
    const ref = _docRef(colecao, id);
    if (!ref) return false;

    sfLog.debug(MOD, `gwSave(${colecao}/${id})`);
    try {
        await safeFirestoreCall(
            () => setDoc(ref, dados, { merge: true }),
            { label: `gwSave(${colecao}/${id})`, tentativas: 2, timeoutMs: 10000 }
        );
        sfLog.info(MOD, `gwSave(${colecao}/${id}) ✓`);
        return true;
    } catch (e) {
        sfLog.error(MOD, `gwSave(${colecao}/${id}) erro absorvido:`, e);
        return false;
    }
}

/**
 * Carrega todos os documentos de uma coleção.
 * v10.2: SEMPRE retorna array (nunca null, nunca lança).
 */
export async function gwLoad(colecao) {
    const ref = _colRef(colecao);
    if (!ref) return [];

    sfLog.debug(MOD, `gwLoad(${colecao})`);
    try {
        const snap = await safeFirestoreCall(
            () => getDocs(ref),
            { label: `gwLoad(${colecao})`, tentativas: 2, timeoutMs: 10000, fallback: null }
        );
        if (!snap) {
            sfLog.warn(MOD, `gwLoad(${colecao}) retornou null — usando fallback [].`);
            return [];
        }
        const result = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        sfLog.debug(MOD, `gwLoad(${colecao}) ✓ — ${result.length} docs`);
        return result;
    } catch (e) {
        sfLog.error(MOD, `gwLoad(${colecao}) erro absorvido:`, e);
        return [];
    }
}

/**
 * Remove um documento.
 * v10.2: NUNCA lança — retorna false em caso de falha.
 */
export async function gwDelete(colecao, id) {
    const ref = _docRef(colecao, id);
    if (!ref) return false;

    sfLog.debug(MOD, `gwDelete(${colecao}/${id})`);
    try {
        await safeFirestoreCall(
            () => deleteDoc(ref),
            { label: `gwDelete(${colecao}/${id})`, tentativas: 2, timeoutMs: 8000 }
        );
        sfLog.info(MOD, `gwDelete(${colecao}/${id}) ✓`);
        return true;
    } catch (e) {
        sfLog.error(MOD, `gwDelete(${colecao}/${id}) erro absorvido:`, e);
        return false;
    }
}

/**
 * Observa mudanças em tempo real em uma coleção.
 * v10.2: NUNCA lança — retorna noop em qualquer condição de falha.
 */
export function gwWatch(colecao, callback) {
    if (!fbIsAvailable()) {
        sfLog.debug(MOD, `gwWatch(${colecao}): Firebase indisponível — noop.`);
        return () => {};
    }

    const ref = _colRef(colecao);
    if (!ref) return () => {};

    try {
        const unsub = onSnapshot(
            ref,
            snap => {
                try {
                    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
                } catch (cbErr) {
                    sfLog.error(MOD, `gwWatch(${colecao}): erro no callback:`, cbErr);
                }
            },
            e => {
                sfLog.error(MOD, `gwWatch(${colecao}): erro do listener Firestore:`, e);
            }
        );
        sfLog.debug(MOD, `gwWatch(${colecao}) listener ativo.`);
        return unsub ?? (() => {});
    } catch (e) {
        sfLog.error(MOD, `gwWatch(${colecao}): falha ao registrar onSnapshot:`, e);
        return () => {};
    }
}

/**
 * Verifica se o gateway está operacional.
 * Nunca lança.
 */
export function gwIsReady() {
    try {
        return fbIsAvailable();
    } catch (e) {
        return false;
    }
}
