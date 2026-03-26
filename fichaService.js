// ===== arquivo: fichaService.js =====
// fichaService.js — StockFlow Pro v10.0
// ══════════════════════════════════════════════════════════════════
// ADAPTER + FEATURE FLAG — Integração App ↔ Engine
// ──────────────────────────────────────────────────────────────────
// RESPONSABILIDADES:
//   1. Converter dados do app para o formato da engine (mapToEngine).
//   2. Converter saída da engine para o formato do app (mapFromEngine).
//   3. Controlar qual engine é usada via ENGINE_MODE.
//   4. Validar engine vs legacy via engineValidator em modo safe.
//   5. Garantir fallback automático se a nova engine falhar.
//
// ENGINE_MODE:
//   "legacy"  → usa apenas cálculo antigo (ft-calc.js)
//   "safe"    → valida engine vs legacy; se válido usa engine, senão legacy
//   "hybrid"  → compara antigo vs novo, loga divergências, usa NOVO
//   "full"    → usa apenas a nova engine (ft-engine.js)
//
// REGRA DE OURO:
//   calcularComEngine() NUNCA lança — sempre retorna um resultado válido.
// ══════════════════════════════════════════════════════════════════

import { calcularEngine, saidaVazia } from './ft-engine.js';
import { calcCustoEfetivo, calcPrecoMarkup, calcPrecoMargem,
         calcLucro, calcMargemReal, calcMarkupImplicito } from './ft-calc.js';
import { validarResultadoEngine, criarResultadoSeguro } from './engineValidator.js';

const MOD = 'fichaService';

// ── Feature Flag ──────────────────────────────────────────────────
// Altere aqui para controlar o comportamento da migração:
//   "legacy"  → rollback imediato (cálculo antigo)
//   "safe"    → valida engine vs legacy; usa engine só se consistente (SEGURO)
//   "hybrid"  → migração com comparação e log (RECOMENDADO para debug)
//   "full"    → somente nova engine
export const ENGINE_MODE = 'hybrid';

// Limiar (em R$) para log de divergência entre engines (modo hybrid).
const DIVERGENCIA_THRESHOLD = 0.01;

// ══════════════════════════════════════════════════════════════════
// ADAPTER: App → Engine
// ══════════════════════════════════════════════════════════════════

/**
 * Converte dados do app (ficha/receita) para o input da engine.
 *
 * O app pode fornecer os ingredientes com custo pré-calculado (ing.custo)
 * OU um custo total agregado (ficha.custo_total). A engine aceita ambos:
 * se custo_total for fornecido sem ingredientes detalhados, cria um
 * ingrediente virtual representando o custo total.
 *
 * @param {Object} ficha — objeto receita ou config do simulador
 * @param {Array}  [ficha.ingredientes]    — ingredientes com {custo}
 * @param {number} [ficha.custo_total]     — custo total pré-calculado (fallback)
 * @param {number} [ficha.overhead_pct]    — overhead %
 * @param {number} [ficha.mao_de_obra]     — mão de obra R$
 * @param {number} [ficha.custo_fixo]      — custo fixo rateado R$
 * @param {number} [ficha.porcoes]         — número de porções
 * @param {number} [ficha.margem]          — margem desejada %
 * @param {number} [ficha.preco_venda]     — preço de venda R$
 * @param {number} [ficha.perda_pct]       — % perda no preparo
 *
 * @returns {Object} Input normalizado para ft-engine.calcularEngine()
 */
export function mapToEngine(ficha) {
    if (!ficha || typeof ficha !== 'object') {
        return {
            ingredientes:  [],
            overhead_pct:  0,
            mao_de_obra:   0,
            custo_fixo:    0,
            porcoes:       1,
            margem:        0,
            preco_venda:   0,
            perda_pct:     0,
        };
    }

    // Ingredientes: usa lista detalhada ou cria virtual a partir do custo_total
    let ingredientes = Array.isArray(ficha.ingredientes) && ficha.ingredientes.length > 0
        ? ficha.ingredientes
        : [];

    if (ingredientes.length === 0 && Number(ficha.custo_total) > 0) {
        ingredientes = [{ nome: '_custo_total', custo: Number(ficha.custo_total) || 0 }];
    }

    return {
        ingredientes,
        overhead_pct: Number(ficha.overhead_pct)  || 0,
        mao_de_obra:  Number(ficha.mao_de_obra)   || 0,
        custo_fixo:   Number(ficha.custo_fixo)    || 0,
        porcoes:      Number(ficha.porcoes)       || 1,
        margem:       Number(ficha.margem)        || 0,
        preco_venda:  Number(ficha.preco_venda)   || 0,
        perda_pct:    Number(ficha.perda_pct)     || 0,
    };
}

// ══════════════════════════════════════════════════════════════════
// ADAPTER: Engine → App
// ══════════════════════════════════════════════════════════════════

/**
 * Converte a saída da engine para o formato esperado pelo app.
 *
 * @param {Object} result — saída de calcularEngine()
 * @returns {{
 *   custo_total:    number,
 *   custo_unitario: number,
 *   margem:         number,
 *   markup:         number,
 *   sugestoes:      Array
 * }}
 */
export function mapFromEngine(result) {
    if (!result || typeof result !== 'object') {
        return criarResultadoSeguro();
    }

    const _safe = v => {
        const n = Number(v);
        return (isFinite(n) && !isNaN(n)) ? n : 0;
    };

    return {
        custo_total:    _safe(result.custo_total),
        custo_unitario: _safe(result.custo_unitario),
        margem:         _safe(result.margem),
        markup:         _safe(result.markup),
        sugestoes:      Array.isArray(result.sugestoes) ? result.sugestoes : [],
    };
}

// ══════════════════════════════════════════════════════════════════
// LEGADO — Cálculo antigo (mantido para fallback e validação)
// ══════════════════════════════════════════════════════════════════

/**
 * Executa o cálculo usando a engine LEGADA (ft-calc.js).
 * Mantida para validação em modo safe e fallback em modo full.
 *
 * @param {Object} ficha
 * @returns {{ custo_total: number, custo_unitario: number, margem: number, markup: number, sugestoes: Array }}
 */
function _calcularLegacy(ficha) {
    try {
        const custoIng    = Number(ficha?.custo_total)    || 0;
        const overheadPct = Number(ficha?.overhead_pct)   || 0;
        const maoDeObra   = Number(ficha?.mao_de_obra)    || 0;
        const porcoes     = Math.max(1, Number(ficha?.porcoes) || 1);

        const custo_total    = calcCustoEfetivo(custoIng, overheadPct, maoDeObra);
        const custo_unitario = custo_total / porcoes;

        return {
            custo_total:    isFinite(custo_total)    ? custo_total    : 0,
            custo_unitario: isFinite(custo_unitario) ? custo_unitario : 0,
            margem:    0,
            markup:    0,
            sugestoes: [],
        };
    } catch (e) {
        console.error(`[${MOD}] _calcularLegacy falhou:`, e);
        return criarResultadoSeguro();
    }
}

// ══════════════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL — calcularComEngine
// ══════════════════════════════════════════════════════════════════

/**
 * Calcula os custos de uma ficha técnica usando a engine configurada
 * pelo ENGINE_MODE. NUNCA lança — sempre retorna um resultado válido.
 *
 * Modos:
 *   "legacy"  → usa _calcularLegacy()
 *   "safe"    → valida engine vs legacy via engineValidator; usa engine se ok
 *   "hybrid"  → usa ambas, compara, loga divergência, retorna nova engine
 *   "full"    → usa apenas calcularEngine() com fallback para legacy
 *
 * @param {Object} ficha — receita/config com campos descritos em mapToEngine()
 * @returns {{ custo_total, custo_unitario, margem, markup, sugestoes }}
 */
export function calcularComEngine(ficha) {
    if (ENGINE_MODE === 'legacy') {
        return _calcularLegacy(ficha);
    }

    if (ENGINE_MODE === 'safe') {
        return _calcularSafe(ficha);
    }

    if (ENGINE_MODE === 'hybrid') {
        return _calcularHybrid(ficha);
    }

    return _calcularFull(ficha);
}

// ── Modo SAFE ─────────────────────────────────────────────────────

/**
 * Calcula com a nova engine e valida contra o legacy via engineValidator.
 * Se válida e consistente → retorna engine.
 * Se divergir ou falhar   → retorna legacy.
 * Fallback total em erro inesperado.
 */
function _calcularSafe(ficha) {
    let resultEngine;
    let resultLegacy;

    // Passo 1: tenta calcular com a nova engine
    try {
        const input  = mapToEngine(ficha);
        const raw    = calcularEngine(input);
        resultEngine = mapFromEngine(raw);
    } catch (e) {
        console.error(`[${MOD}] safe: engine falhou — fallback legacy:`, e);
        return _calcularLegacy(ficha);
    }

    // Passo 2: calcula com legacy para validação
    try {
        resultLegacy = _calcularLegacy(ficha);
    } catch (e) {
        console.error(`[${MOD}] safe: legacy falhou durante validação — usando engine sem comparar:`, e);
        // Sem legacy: aceita engine se estruturalmente válida
        const n = Number(resultEngine?.custo_total) || 0;
        if (isFinite(n) && n >= 0) return resultEngine;
        return criarResultadoSeguro();
    }

    // Passo 3: valida engine vs legacy via engineValidator
    const valido = validarResultadoEngine(resultEngine, resultLegacy, ficha);

    return valido ? resultEngine : resultLegacy;
}

// ── Modo HYBRID ───────────────────────────────────────────────────

/**
 * Calcula com ambas as engines, compara e loga divergências.
 * Retorna o resultado da NOVA engine independente de divergência.
 */
function _calcularHybrid(ficha) {
    let resultNovo;
    let resultLegacy;

    try {
        const input = mapToEngine(ficha);
        const raw   = calcularEngine(input);
        resultNovo  = mapFromEngine(raw);
    } catch (e) {
        console.error(`[${MOD}] hybrid: nova engine falhou — usando legacy:`, e);
        return _calcularLegacy(ficha);
    }

    try {
        resultLegacy = _calcularLegacy(ficha);
    } catch (e) {
        console.error(`[${MOD}] hybrid: legacy falhou — nova engine sem comparação:`, e);
        return resultNovo;
    }
_compararResultados(resultNovo, resultLegacy, ficha);

console.debug(`[${MOD}] HYBRID RESULT`, {
    engine: resultNovo,
    legacy: resultLegacy
});
return resultNovo;
}

// ── Modo FULL ─────────────────────────────────────────────────────

/**
 * Usa apenas a nova engine com fallback automático para legacy.
 */
function _calcularFull(ficha) {
    try {
        const input  = mapToEngine(ficha);
        const raw    = calcularEngine(input);
        const result = mapFromEngine(raw);

        const n = Number(result?.custo_total) || 0;
        if (!isFinite(n) || isNaN(n)) {
            console.warn(`[${MOD}] full: resultado inválido — fallback legacy`);
            return _calcularLegacy(ficha);
        }

        return result;
    } catch (e) {
        console.error(`[${MOD}] full: nova engine falhou — fallback legacy:`, e);
        return _calcularLegacy(ficha);
    }
}

// ── Modo FULL ─────────────────────────────────────────────────────
function _calcularFull(ficha) {
   ...
}


// ✅ COLE AQUI 👇👇👇
function _mostrarTelaErro(divergencias, ficha) {
    try {
        const antigo = document.getElementById('sf-erro-engine');
        if (antigo) antigo.remove();

        const overlay = document.createElement('div');
        overlay.id = 'sf-erro-engine';
        overlay.style = `
            position: fixed;
            top:0; left:0;
            width:100%; height:100%;
            background: rgba(0,0,0,0.7);
            z-index:9999;
            display:flex;
            align-items:center;
            justify-content:center;
        `;

        const box = document.createElement('div');
        box.style = `
            background:#111;
            color:#fff;
            padding:20px;
            border-radius:12px;
            width:90%;
            max-width:500px;
            font-family: monospace;
        `;

        let html = `
            <h2 style="color:#ff4444;">⚠️ Divergência na Engine</h2>
            <p><b>Ficha:</b> ${ficha?.nome || 'Sem nome'}</p>
            <table style="width:100%; margin-top:10px;">
        `;

        divergencias.forEach(d => {
            html += `
                <tr>
                    <td>${d.campo}</td>
                    <td>${d.novo.toFixed(2)}</td>
                    <td>${d.legacy.toFixed(2)}</td>
                    <td style="color:red;">${d.delta.toFixed(2)}</td>
                </tr>
            `;
        });

        html += `</table>
            <button id="sf-fechar-erro" style="margin-top:15px;">Fechar</button>
        `;

        box.innerHTML = html;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        document.getElementById('sf-fechar-erro').onclick = () => {
            overlay.remove();
        };

    } catch (e) {
        console.error('Erro ao mostrar tela de erro', e);
    }
}

// ── Comparação de resultados (modo hybrid) ────────────────────────

/**
 * Compara os resultados das duas engines e loga divergências.
 * NUNCA lança — erros são suprimidos silenciosamente.
 */function _compararResultados(novo, legacy, ficha) {
    try {
        const safe = v => Number(v) || 0;

        const campos = [
            'custo_total',
            'custo_unitario',
            'margem',
            'markup'
        ];

        const divergencias = [];

        for (const campo of campos) {
            const vNovo = safe(novo?.[campo]);
            const vOld  = safe(legacy?.[campo]);

            const delta = Math.abs(vNovo - vOld);

            if (delta > DIVERGENCIA_THRESHOLD) {
                divergencias.push({
                    campo,
                    novo: vNovo,
                    legacy: vOld,
                    delta
                });
            }
        }

        if (divergencias.length > 0) {
            _mostrarTelaErro(divergencias, ficha);
        }

    } catch (e) {
        console.error(`[${MOD}] erro ao comparar resultados`, e);
    }
}

// ══════════════════════════════════════════════════════════════════
// HELPERS PÚBLICOS — Precificação (para uso em ft-custos.js)
// ══════════════════════════════════════════════════════════════════

/**
 * Calcula preço de venda, lucro e margem real dado um custo efetivo e markup.
 * @param {number} custoEfetivo — custo total por unidade
 * @param {number} markup_pct   — markup %
 * @returns {{ preco, lucro, margemReal, markupImplicito }}
 */
export function precificarPorMarkup(custoEfetivo, markup_pct) {
    try {
        const c    = Number(custoEfetivo) || 0;
        const mk   = Number(markup_pct)  || 0;
        const preco           = calcPrecoMarkup(c, mk);
        const lucro           = calcLucro(preco, c);
        const margemReal      = calcMargemReal(preco, c);
        const markupImplicito = calcMarkupImplicito(preco, c);
        return { preco, lucro, margemReal, markupImplicito };
    } catch (e) {
        console.error(`[${MOD}] precificarPorMarkup falhou:`, e);
        return { preco: 0, lucro: 0, margemReal: 0, markupImplicito: 0 };
    }
}

/**
 * Calcula preço de venda, lucro e margem real dado um custo efetivo e margem.
 * @param {number} custoEfetivo — custo total por unidade
 * @param {number} margem_pct   — margem desejada %
 * @returns {{ preco, lucro, margemReal, markupImplicito }}
 */
export function precificarPorMargem(custoEfetivo, margem_pct) {
    try {
        const c    = Number(custoEfetivo) || 0;
        const mg   = Number(margem_pct)  || 0;
        const preco           = calcPrecoMargem(c, mg);
        const lucro           = calcLucro(preco, c);
        const margemReal      = calcMargemReal(preco, c);
        const markupImplicito = calcMarkupImplicito(preco, c);
        return { preco, lucro, margemReal, markupImplicito };
    } catch (e) {
        console.error(`[${MOD}] precificarPorMargem falhou:`, e);
        return { preco: 0, lucro: 0, margemReal: 0, markupImplicito: 0 };
    }
}

// Limiar (em R$) para log de divergência entre engines (modo hybrid).
const DIVERGENCIA_THRESHOLD = 0.01;

// ══════════════════════════════════════════════════════════════════
// ADAPTER: App → Engine
// ══════════════════════════════════════════════════════════════════

/**
 * Converte dados do app (ficha/receita) para o input da engine.
 *
 * O app pode fornecer os ingredientes com custo pré-calculado (ing.custo)
 * OU um custo total agregado (ficha.custo_total). A engine aceita ambos:
 * se custo_total for fornecido sem ingredientes detalhados, cria um
 * ingrediente virtual representando o custo total.
 *
 * @param {Object} ficha — objeto receita ou config do simulador
 * @param {Array}  [ficha.ingredientes]    — ingredientes com {custo}
 * @param {number} [ficha.custo_total]     — custo total pré-calculado (fallback)
 * @param {number} [ficha.overhead_pct]    — overhead %
 * @param {number} [ficha.mao_de_obra]     — mão de obra R$
 * @param {number} [ficha.custo_fixo]      — custo fixo rateado R$
 * @param {number} [ficha.porcoes]         — número de porções
 * @param {number} [ficha.margem]          — margem desejada %
 * @param {number} [ficha.preco_venda]     — preço de venda R$
 * @param {number} [ficha.perda_pct]       — % perda no preparo
 *
 * @returns {Object} Input normalizado para ft-engine.calcularEngine()
 */
export function mapToEngine(ficha) {
    if (!ficha || typeof ficha !== 'object') {
        return {
            ingredientes:  [],
            overhead_pct:  0,
            mao_de_obra:   0,
            custo_fixo:    0,
            porcoes:       1,
            margem:        0,
            preco_venda:   0,
            perda_pct:     0,
        };
    }

    // Ingredientes: usa lista detalhada ou cria virtual a partir do custo_total
    let ingredientes = Array.isArray(ficha.ingredientes) && ficha.ingredientes.length > 0
        ? ficha.ingredientes
        : [];

    if (ingredientes.length === 0 && Number(ficha.custo_total) > 0) {
        ingredientes = [{ nome: '_custo_total', custo: Number(ficha.custo_total) || 0 }];
    }

    return {
        ingredientes,
        overhead_pct: Number(ficha.overhead_pct)  || 0,
        mao_de_obra:  Number(ficha.mao_de_obra)   || 0,
        custo_fixo:   Number(ficha.custo_fixo)    || 0,
        porcoes:      Number(ficha.porcoes)       || 1,
        margem:       Number(ficha.margem)        || 0,
        preco_venda:  Number(ficha.preco_venda)   || 0,
        perda_pct:    Number(ficha.perda_pct)     || 0,
    };
}

// ══════════════════════════════════════════════════════════════════
// ADAPTER: Engine → App
// ══════════════════════════════════════════════════════════════════

/**
 * Converte a saída da engine para o formato esperado pelo app.
 *
 * @param {Object} result — saída de calcularEngine()
 * @returns {{
 *   custo_total:    number,
 *   custo_unitario: number,
 *   margem:         number,
 *   markup:         number,
 *   sugestoes:      Array
 * }}
 */
export function mapFromEngine(result) {
    if (!result || typeof result !== 'object') {
        return criarResultadoSeguro();
    }

    const _safe = v => {
        const n = Number(v);
        return (isFinite(n) && !isNaN(n)) ? n : 0;
    };

    return {
        custo_total:    _safe(result.custo_total),
        custo_unitario: _safe(result.custo_unitario),
        margem:         _safe(result.margem),
        markup:         _safe(result.markup),
        sugestoes:      Array.isArray(result.sugestoes) ? result.sugestoes : [],
    };
}

// ══════════════════════════════════════════════════════════════════
// LEGADO — Cálculo antigo (mantido para fallback e validação)
// ══════════════════════════════════════════════════════════════════

/**
 * Executa o cálculo usando a engine LEGADA (ft-calc.js).
 * Mantida para validação em modo safe e fallback em modo full.
 *
 * @param {Object} ficha
 * @returns {{ custo_total: number, custo_unitario: number, margem: number, markup: number, sugestoes: Array }}
 */
function _calcularLegacy(ficha) {
    try {
        const custoIng    = Number(ficha?.custo_total)    || 0;
        const overheadPct = Number(ficha?.overhead_pct)   || 0;
        const maoDeObra   = Number(ficha?.mao_de_obra)    || 0;
        const porcoes     = Math.max(1, Number(ficha?.porcoes) || 1);

        const custo_total    = calcCustoEfetivo(custoIng, overheadPct, maoDeObra);
        const custo_unitario = custo_total / porcoes;

        return {
            custo_total:    isFinite(custo_total)    ? custo_total    : 0,
            custo_unitario: isFinite(custo_unitario) ? custo_unitario : 0,
            margem:    0,
            markup:    0,
            sugestoes: [],
        };
    } catch (e) {
        console.error(`[${MOD}] _calcularLegacy falhou:`, e);
        return criarResultadoSeguro();
    }
}

// ══════════════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL — calcularComEngine
// ══════════════════════════════════════════════════════════════════

/**
 * Calcula os custos de uma ficha técnica usando a engine configurada
 * pelo ENGINE_MODE. NUNCA lança — sempre retorna um resultado válido.
 *
 * Modos:
 *   "legacy"  → usa _calcularLegacy()
 *   "safe"    → valida engine vs legacy via engineValidator; usa engine se ok
 *   "hybrid"  → usa ambas, compara, loga divergência, retorna nova engine
 *   "full"    → usa apenas calcularEngine() com fallback para legacy
 *
 * @param {Object} ficha — receita/config com campos descritos em mapToEngine()
 * @returns {{ custo_total, custo_unitario, margem, markup, sugestoes }}
 */
export function calcularComEngine(ficha) {
    if (ENGINE_MODE === 'legacy') {
        return _calcularLegacy(ficha);
    }

    if (ENGINE_MODE === 'safe') {
        return _calcularSafe(ficha);
    }

    if (ENGINE_MODE === 'hybrid') {
        return _calcularHybrid(ficha);
    }

    return _calcularFull(ficha);
}

// ── Modo SAFE ─────────────────────────────────────────────────────

/**
 * Calcula com a nova engine e valida contra o legacy via engineValidator.
 * Se válida e consistente → retorna engine.
 * Se divergir ou falhar   → retorna legacy.
 * Fallback total em erro inesperado.
 */
function _calcularSafe(ficha) {
    let resultEngine;
    let resultLegacy;

    // Passo 1: tenta calcular com a nova engine
    try {
        const input  = mapToEngine(ficha);
        const raw    = calcularEngine(input);
        resultEngine = mapFromEngine(raw);
    } catch (e) {
        console.error(`[${MOD}] safe: engine falhou — fallback legacy:`, e);
        return _calcularLegacy(ficha);
    }

    // Passo 2: calcula com legacy para validação
    try {
        resultLegacy = _calcularLegacy(ficha);
    } catch (e) {
        console.error(`[${MOD}] safe: legacy falhou durante validação — usando engine sem comparar:`, e);
        // Sem legacy: aceita engine se estruturalmente válida
        const n = Number(resultEngine?.custo_total) || 0;
        if (isFinite(n) && n >= 0) return resultEngine;
        return criarResultadoSeguro();
    }

    // Passo 3: valida engine vs legacy via engineValidator
    const valido = validarResultadoEngine(resultEngine, resultLegacy, ficha);

    return valido ? resultEngine : resultLegacy;
}

// ── Modo HYBRID ───────────────────────────────────────────────────

/**
 * Calcula com ambas as engines, compara e loga divergências.
 * Retorna o resultado da NOVA engine independente de divergência.
 */
function _calcularHybrid(ficha) {
    let resultNovo;
    let resultLegacy;

    try {
        const input = mapToEngine(ficha);
        const raw   = calcularEngine(input);
        resultNovo  = mapFromEngine(raw);
    } catch (e) {
        console.error(`[${MOD}] hybrid: nova engine falhou — usando legacy:`, e);
        return _calcularLegacy(ficha);
    }

    try {
        resultLegacy = _calcularLegacy(ficha);
    } catch (e) {
        console.error(`[${MOD}] hybrid: legacy falhou — nova engine sem comparação:`, e);
        return resultNovo;
    }
_compararResultados(resultNovo, resultLegacy, ficha);

try {
    console.debug(`[${MOD}] HYBRID RESULT`, {
        engine: resultNovo,
        legacy: resultLegacy,
        ficha: ficha
    });
} catch {}

return resultNovo;
}

// ── Modo FULL ─────────────────────────────────────────────────────

/**
 * Usa apenas a nova engine com fallback automático para legacy.
 */
function _calcularFull(ficha) {
    try {
        const input  = mapToEngine(ficha);
        const raw    = calcularEngine(input);
        const result = mapFromEngine(raw);

        const n = Number(result?.custo_total) || 0;
        if (!isFinite(n) || isNaN(n)) {
            console.warn(`[${MOD}] full: resultado inválido — fallback legacy`);
            return _calcularLegacy(ficha);
        }

        return result;
    } catch (e) {
        console.error(`[${MOD}] full: nova engine falhou — fallback legacy:`, e);
        return _calcularLegacy(ficha);
    }
}

// ── Comparação de resultados (modo hybrid) ────────────────────────

/**
 * Compara os resultados das duas engines e loga divergências.
 * NUNCA lança — erros são suprimidos silenciosamente.
 */
function _compararResultados(novo, legacy, ficha) {
    try {
        const delta = Math.abs((Number(novo?.custo_total)   || 0) -
                               (Number(legacy?.custo_total) || 0));

        if (delta > DIVERGENCIA_THRESHOLD) {
            console.warn(
                `[${MOD}] 🔍 HYBRID DIVERGÊNCIA detectada:`,
                {
                    receita:      ficha?.nome || '(sem nome)',
                    novo_custo:   (Number(novo?.custo_total)   || 0).toFixed(4),
                    legacy_custo: (Number(legacy?.custo_total) || 0).toFixed(4),
                    delta:        delta.toFixed(4),
                    overhead_pct: ficha?.overhead_pct,
                    mao_de_obra:  ficha?.mao_de_obra,
                    porcoes:      ficha?.porcoes,
                }
            );
        }
    } catch (_) {
        // Suprime — nunca interrompe o fluxo
    }
}

// ══════════════════════════════════════════════════════════════════
// HELPERS PÚBLICOS — Precificação (para uso em ft-custos.js)
// ══════════════════════════════════════════════════════════════════

/**
 * Calcula preço de venda, lucro e margem real dado um custo efetivo e markup.
 * @param {number} custoEfetivo — custo total por unidade
 * @param {number} markup_pct   — markup %
 * @returns {{ preco, lucro, margemReal, markupImplicito }}
 */
export function precificarPorMarkup(custoEfetivo, markup_pct) {
    try {
        const c    = Number(custoEfetivo) || 0;
        const mk   = Number(markup_pct)  || 0;
        const preco           = calcPrecoMarkup(c, mk);
        const lucro           = calcLucro(preco, c);
        const margemReal      = calcMargemReal(preco, c);
        const markupImplicito = calcMarkupImplicito(preco, c);
        return { preco, lucro, margemReal, markupImplicito };
    } catch (e) {
        console.error(`[${MOD}] precificarPorMarkup falhou:`, e);
        return { preco: 0, lucro: 0, margemReal: 0, markupImplicito: 0 };
    }
}

/**
 * Calcula preço de venda, lucro e margem real dado um custo efetivo e margem.
 * @param {number} custoEfetivo — custo total por unidade
 * @param {number} margem_pct   — margem desejada %
 * @returns {{ preco, lucro, margemReal, markupImplicito }}
 */
export function precificarPorMargem(custoEfetivo, margem_pct) {
    try {
        const c    = Number(custoEfetivo) || 0;
        const mg   = Number(margem_pct)  || 0;
        const preco           = calcPrecoMargem(c, mg);
        const lucro           = calcLucro(preco, c);
        const margemReal      = calcMargemReal(preco, c);
        const markupImplicito = calcMarkupImplicito(preco, c);
        return { preco, lucro, margemReal, markupImplicito };
    } catch (e) {
        console.error(`[${MOD}] precificarPorMargem falhou:`, e);
        return { preco: 0, lucro: 0, margemReal: 0, markupImplicito: 0 };
    }
}
