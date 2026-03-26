// firebase-safe.js — StockFlow Pro v10.2
// ══════════════════════════════════════════════════════════════════
// CAMADA DE SEGURANÇA — Wrappers, retry, timeout e logging profissional
// ──────────────────────────────────────────────────────────────────
// v10.2 — CORREÇÃO DE QUEBRA:
//   [CRÍTICO] safeFirestoreCall: removido "throw e" final — agora
//             SEMPRE retorna fallback (default null) em caso de falha.
//             Nunca relança erro para o caller. UI nunca para.
//   [CRÍTICO] assertDb: substituído throw por console.error + return
//             false. Código que chamava assertDb deve verificar o
//             retorno booleano — não depender de exception.
//   [CRÍTICO] withRetry: substituído "throw ultimoErro" por
//             return null. Erros de retry são logados, não propagados.
//   [ALTO]    withTimeout: timeout loga e rejeita internamente, mas
//             safeFirestoreCall absorve isso — nunca escapa.
//   [MÉDIO]   sfLog: try/catch interno — nunca quebra por console
//             indisponível (ex: Safari em modo privado).
//
// v10.1 — Novidades: safeFirestoreCall, assertDb, withRetry,
//         withTimeout, sfLog, isSafari/isIOS.
// ══════════════════════════════════════════════════════════════════

// ── Detecção de plataforma ────────────────────────────────────────
export const isIOS    = /iphone|ipad|ipod/i.test(navigator.userAgent);
export const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// ── Logging estruturado ───────────────────────────────────────────
// Nunca exibe alertas ou modais — apenas registra no console.
// try/catch interno: console pode estar bloqueado em Safari privado.
const LOG_PREFIX = '[StockFlow]';

export const sfLog = {
    info:  (modulo, msg, ...extra) => {
        try { console.info(`${LOG_PREFIX} [${modulo}] ✓ ${msg}`, ...extra); } catch (_) {}
    },
    warn:  (modulo, msg, ...extra) => {
        try { console.warn(`${LOG_PREFIX} [${modulo}] ⚠ ${msg}`, ...extra); } catch (_) {}
    },
    error: (modulo, msg, ...extra) => {
        try { console.error(`${LOG_PREFIX} [${modulo}] ✗ ${msg}`, ...extra); } catch (_) {}
    },
    debug: (modulo, msg, ...extra) => {
        try {
            if (location.hostname === 'localhost' || new URLSearchParams(location.search).has('debug')) {
                console.debug(`${LOG_PREFIX} [${modulo}] ⟳ ${msg}`, ...extra);
            }
        } catch (_) {}
    },
};

// ── Timeout ───────────────────────────────────────────────────────
/**
 * Aplica um timeout a qualquer Promise.
 * Rejeita internamente — absorvido pelo safeFirestoreCall.
 */
export function withTimeout(promise, ms = 10000, label = 'operação') {
    let timerId;
    const timeout = new Promise((_, reject) => {
        timerId = setTimeout(
            () => reject(new Error(`[firebase-safe] Timeout em "${label}" após ${ms}ms`)),
            ms
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}

// ── Retry leve ────────────────────────────────────────────────────
/**
 * Executa fn() com retry exponencial em caso de falha.
 * v10.2: NUNCA lança — retorna null após esgotar tentativas.
 * Máximo 2 retries reais (tentativas=3 → 1 tentativa + 2 retries).
 */
export async function withRetry(fn, { tentativas = 3, baseDelayMs = 500, label = '' } = {}) {
    for (let i = 0; i < tentativas; i++) {
        try {
            return await fn();
        } catch (e) {
            // Não retenta erros de permissão ou auth — são definitivos
            if (e?.code === 'permission-denied' || e?.code === 'unauthenticated') {
                sfLog.error('firebase-safe', `${label}: erro de permissão/auth — sem retry.`, e?.message);
                return null;  // ← Não relança
            }
            if (i < tentativas - 1) {
                const delay = baseDelayMs * Math.pow(2, i);
                sfLog.warn('firebase-safe', `${label} falhou (tentativa ${i + 1}/${tentativas}) — retry em ${delay}ms`, e?.message);
                await new Promise(r => setTimeout(r, delay));
            } else {
                sfLog.error('firebase-safe', `${label} esgotou ${tentativas} tentativas.`, e?.message);
            }
        }
    }
    return null;  // ← v10.2: retorna null em vez de throw ultimoErro
}

// ── assertDb ──────────────────────────────────────────────────────
/**
 * Verifica se Firebase está pronto.
 * v10.2: NUNCA lança — retorna false e loga. Callers devem checar
 *        o retorno booleano em vez de depender de exception.
 *
 * @param {boolean} disponivel — resultado de fbIsAvailable()
 * @param {string}  contexto   — nome da operação chamadora
 * @returns {boolean} true se disponível, false caso contrário
 */
export function assertDb(disponivel, contexto = 'operação') {
    if (!disponivel) {
        sfLog.error('firebase-safe',
            `assertDb falhou em "${contexto}": Firebase não inicializado ou usuário não autenticado.`
        );
        return false;  // ← v10.2: não lança, retorna false
    }
    return true;
}

// ── safeFirestoreCall ─────────────────────────────────────────────
/**
 * Wrapper universal: executa chamada Firestore com retry + timeout.
 * v10.2: SEMPRE retorna fallback em caso de falha — NUNCA relança.
 *        A UI nunca para por erro de Firestore.
 *
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {string} [opts.label]
 * @param {number} [opts.tentativas]   padrão: 2 (leve, sem sobrecarregar)
 * @param {number} [opts.timeoutMs]    padrão: 10000
 * @param {T}      [opts.fallback]     valor retornado em falha definitiva (padrão: null)
 * @returns {Promise<T|null>}
 */
export async function safeFirestoreCall(fn, {
    label      = 'Firestore',
    tentativas = 2,
    timeoutMs  = 10000,
    fallback   = null,
} = {}) {
    try {
        const result = await withRetry(
            () => withTimeout(fn(), timeoutMs, label),
            { tentativas, label }
        );
        // withRetry retorna null em caso de falha — trata como fallback
        if (result === null && fallback !== null && fallback !== undefined) {
            return fallback;
        }
        return result;
    } catch (e) {
        // Caminho de segurança: nunca deve chegar aqui (withRetry absorve),
        // mas se chegar, loga e retorna fallback — NUNCA relança.
        sfLog.error('firebase-safe', `${label} — erro não esperado absorvido:`, e);
        return fallback ?? null;
    }
}

// ── Verificação de conectividade ──────────────────────────────────
/**
 * Retorna true se o navegador reporta online.
 * Usar apenas para UI informativa — NÃO para suprimir erros Firestore.
 */
export function isOnline() {
    return navigator.onLine !== false;
}
