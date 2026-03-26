// ft-storage.js — StockFlow Pro v10.2
// ══════════════════════════════════════════════════════════════════
// CAMADA DE DADOS — Ficha Técnica
// ──────────────────────────────────────────────────────────────────
// v10.2 — CORREÇÃO DE QUEBRA:
//   [CRÍTICO] fbSave/fbLoad/fbDelete agora retornam valores seguros
//             em vez de lançar (corrigido em firebase.js v10.2).
//             ft-storage.js não precisa mais de try/catch agressivo —
//             mas mantém os wrappers para segurança em profundidade.
//   [ALTO]    carregar(): fbLoad agora retorna [] em falha (v10.2) —
//             a atualização do LS só é feita se retornou dados reais.
//             Evita sobrescrever dados locais bons com [] vazio.
//   [ALTO]    salvar/remover: catch local mantido como segunda camada
//             de proteção — não propaga erro para a UI.
//   [MÉDIO]   sincronizarLocalParaFirebase: cada fbSave retorna
//             boolean — contabilizado em ok/fail sem try/catch por item.
//   [MÉDIO]   carregarConfig: proteção reforçada contra JSON inválido
//             no LS e campos ausentes.
//   [LEVE]    lsGetAll/lsSetAll: proteções extras para ambientes
//             (Safari privado) onde localStorage pode ser restrito.
//
// v10.1 — HARDENING: console.warn → console.error em erros reais.
// v10.0 — Separação dados ↔ lógica. LocalStorage primário + Firebase espelho.
// ══════════════════════════════════════════════════════════════════

import { fbSave, fbLoad, fbDelete, fbIsAvailable } from './firebase.js';

const LS_PREFIX = 'ft_';
const MOD = 'ft-storage';

// ── LocalStorage helpers ──────────────────────────────────────────
function lsKey(col) { return LS_PREFIX + col; }

function lsGetAll(col) {
    try {
        const raw = localStorage.getItem(lsKey(col));
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            ? parsed
            : {};
    } catch {
        return {};
    }
}

function lsSetAll(col, dados) {
    try {
        localStorage.setItem(lsKey(col), JSON.stringify(dados));
    } catch (e) {
        // QuotaExceededError → esperado em LS cheio, não é erro fatal
        console.warn(`[${MOD}] lsSetAll(${col}): localStorage cheio ou bloqueado.`, e);
    }
}

// ── CRUD principal ────────────────────────────────────────────────

/**
 * Salva (upsert) um item.
 * Escreve no LS imediatamente; espelha no Firebase em background.
 * NUNCA lança — falha silenciosa com log.
 */
export async function salvar(colecao, id, dados) {
    if (dados === null || dados === undefined) {
        console.error(`[${MOD}] salvar(${colecao}/${id}): dados são null/undefined — abortado.`);
        return;
    }
    const item = { ...dados, id };

    // 1. Persiste local primeiro — resposta imediata
    try {
        const local = lsGetAll(colecao);
        local[id] = item;
        lsSetAll(colecao, local);
    } catch (e) {
        console.error(`[${MOD}] salvar(${colecao}/${id}): falha no LS:`, e);
    }

    // 2. Espelha no Firebase (não-bloqueante)
    // fbSave v10.2 nunca lança — retorna boolean
    if (fbIsAvailable()) {
        const ok = await fbSave(colecao, id, item);
        if (!ok) {
            console.error(`[${MOD}] fbSave falhou (${colecao}/${id}) — dado salvo no LS mas cloud out-of-sync.`);
        }
    }
}

/**
 * Carrega todos os itens de uma coleção.
 * Prioridade: Firebase → LS como fallback automático.
 * NUNCA lança — retorna [] em qualquer caso de falha.
 */
export async function carregar(colecao) {
    if (fbIsAvailable()) {
        // fbLoad v10.2 nunca lança — retorna [] em falha
        const fbDados = await fbLoad(colecao);
        if (fbDados && fbDados.length > 0) {
            // Só atualiza LS se Firebase retornou dados reais
            // (evita sobrescrever cache local com [] em caso de falha silenciosa)
            try {
                const mapa = {};
                fbDados.forEach(d => { mapa[d.id] = d; });
                lsSetAll(colecao, mapa);
            } catch (e) {
                console.error(`[${MOD}] carregar(${colecao}): falha ao atualizar LS:`, e);
            }
            return fbDados;
        }
        // fbLoad retornou [] — pode ser coleção vazia ou falha silenciosa
        // Usa LS como fallback seguro
        const lsData = Object.values(lsGetAll(colecao));
        if (lsData.length > 0) {
            console.warn(`[${MOD}] carregar(${colecao}): Firebase retornou vazio — usando LS como fallback.`);
            return lsData;
        }
        return [];
    }
    return Object.values(lsGetAll(colecao));
}

/**
 * Remove um item.
 * Remove do LS imediatamente; tenta remover do Firebase em background.
 * NUNCA lança.
 */
export async function remover(colecao, id) {
    try {
        const local = lsGetAll(colecao);
        delete local[id];
        lsSetAll(colecao, local);
    } catch (e) {
        console.error(`[${MOD}] remover(${colecao}/${id}): falha no LS:`, e);
    }

    // fbDelete v10.2 nunca lança — retorna boolean
    if (fbIsAvailable()) {
        const ok = await fbDelete(colecao, id);
        if (!ok) {
            console.error(`[${MOD}] fbDelete falhou (${colecao}/${id}) — removido do LS mas cloud pode ter inconsistência.`);
        }
    }
}

// ── Configurações ─────────────────────────────────────────────────
const CFG_KEY = LS_PREFIX + 'config';

/**
 * Salva configurações do usuário.
 * NUNCA lança.
 */
export async function salvarConfig(dados) {
    if (!dados || typeof dados !== 'object') {
        console.error(`[${MOD}] salvarConfig: dados inválidos — abortado.`);
        return;
    }
    try {
        localStorage.setItem(CFG_KEY, JSON.stringify(dados));
    } catch (e) {
        console.warn(`[${MOD}] salvarConfig LS falhou:`, e);
    }
    if (fbIsAvailable()) {
        // fbSave v10.2 nunca lança
        await fbSave('configuracoes', 'default', dados);
    }
}

/**
 * Carrega configurações do usuário.
 * NUNCA lança — retorna null como fallback seguro.
 */
export async function carregarConfig() {
    if (fbIsAvailable()) {
        // fbLoad v10.2 nunca lança — retorna [] em falha
        try {
            const lista = await fbLoad('configuracoes');
            if (Array.isArray(lista)) {
                const cfg = lista.find(d => d && d.id === 'default');
                if (cfg) return cfg;
            }
        } catch (e) {
            console.error(`[${MOD}] carregarConfig Firebase falhou — usando LS:`, e);
        }
    }
    try {
        const raw = localStorage.getItem(CFG_KEY);
        if (!raw) return null;
        return JSON.parse(raw) || null;
    } catch (e) {
        console.error(`[${MOD}] carregarConfig LS corrompido — retornando null:`, e);
        return null;
    }
}

// ── Sincronização ─────────────────────────────────────────────────

/**
 * Push completo LS → Firebase.
 * NUNCA lança — falhas individuais são logadas.
 * fbSave v10.2 retorna boolean — sem try/catch por item necessário.
 */
export async function sincronizarLocalParaFirebase() {
    if (!fbIsAvailable()) return;

    const colecoes = ['ingredientes', 'receitas', 'preparos', 'gastos'];
    let ok = 0, fail = 0;

    for (const col of colecoes) {
        const local = lsGetAll(col);
        for (const [id, item] of Object.entries(local)) {
            if (!item || typeof item !== 'object') continue;
            const saved = await fbSave(col, id, item);
            if (saved) { ok++; } else { fail++; console.error(`[${MOD}] sync falhou (${col}/${id}).`); }
        }
    }
    console.info(`[${MOD}] ✓ Sync concluído: ${ok} ok, ${fail} falhas.`);
}

/**
 * Limpa todos os dados de uma coleção no LS.
 * NUNCA lança.
 */
export function limparColecaoLocal(colecao) {
    try {
        lsSetAll(colecao, {});
    } catch (e) {
        console.error(`[${MOD}] limparColecaoLocal(${colecao}):`, e);
    }
}
