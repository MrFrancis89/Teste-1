// ===== arquivo: engineValidator.js =====
// engineValidator.js — StockFlow Pro v10.0
// ══════════════════════════════════════════════════════════════════
// VALIDADOR DE CONSISTÊNCIA — Engine vs Legacy
// ──────────────────────────────────────────────────────────────────
// RESPONSABILIDADES:
//   1. Validar estrutura do resultado da engine (campos obrigatórios).
//   2. Validar consistência numérica entre engine e legacy.
//   3. Nunca lançar — retorna sempre booleano ou objeto seguro.
//   4. Logar divergências sem interromper o fluxo.
//
// CONTRATO:
//   validarResultadoEngine(resultEngine, resultLegacy, ficha) → boolean
//   validarEstrutura(result)                                  → boolean
//   criarResultadoSeguro()                                    → Object
// ══════════════════════════════════════════════════════════════════

const MOD = 'engineValidator';

// Limiar de divergência aceitável entre engine e legacy (em R$)
const DIVERGENCIA_THRESHOLD = 0.01;

// ── Helpers internos ──────────────────────────────────────────────

/**
 * Verifica se um valor é número finito e não-NaN.
 * @param {*} v
 * @returns {boolean}
 */
function _isNumFinito(v) {
    const n = Number(v);
    return isFinite(n) && !isNaN(n);
}

/**
 * Converte para número seguro; NaN / null / undefined → fallback.
 * @param {*} v
 * @param {number} [fallback=0]
 * @returns {number}
 */
function _n(v, fallback = 0) {
    const n = Number(v);
    return (isFinite(n) && !isNaN(n)) ? n : fallback;
}

// ══════════════════════════════════════════════════════════════════
// VALIDAÇÃO DE ESTRUTURA
// ══════════════════════════════════════════════════════════════════

/**
 * Valida se um resultado de engine possui estrutura mínima válida.
 *
 * Verifica:
 *   - custo_total:    número finito ≥ 0
 *   - custo_unitario: número finito ≥ 0
 *
 * NUNCA lança — retorna false em caso de erro interno.
 *
 * @param {*} result — saída de calcularEngine() ou mapFromEngine()
 * @returns {boolean}
 */
export function validarEstrutura(result) {
    try {
        if (!result || typeof result !== 'object') return false;

        if (!_isNumFinito(result.custo_total))    return false;
        if (!_isNumFinito(result.custo_unitario)) return false;
        if (_n(result.custo_total)    < 0)        return false;
        if (_n(result.custo_unitario) < 0)        return false;

        return true;
    } catch (_) {
        return false;
    }
}

// ══════════════════════════════════════════════════════════════════
// VALIDAÇÃO DE CONSISTÊNCIA
// ══════════════════════════════════════════════════════════════════

/**
 * Valida se o resultado da engine é consistente com o cálculo legacy.
 *
 * Critérios:
 *   1. Estrutura válida (via validarEstrutura).
 *   2. Delta de custo_total vs legacy ≤ DIVERGENCIA_THRESHOLD.
 *
 * NUNCA lança — retorna false em qualquer erro interno.
 *
 * @param {Object} resultEngine  — saída de mapFromEngine()
 * @param {Object} resultLegacy  — saída de _calcularLegacy()
 * @param {Object} [ficha]       — ficha original (para log)
 * @returns {boolean} true se engine é válida e consistente
 */
export function validarResultadoEngine(resultEngine, resultLegacy, ficha) {
    try {
        // Passo 1: validação estrutural
        if (!validarEstrutura(resultEngine)) {
            console.warn(
                `[${MOD}] ⚠️ estrutura inválida — engine rejeitada`,
                {
                    custo_total:    resultEngine?.custo_total,
                    custo_unitario: resultEngine?.custo_unitario,
                }
            );
            return false;
        }

        // Passo 2: legacy deve ter estrutura mínima para comparar
        if (!resultLegacy || typeof resultLegacy !== 'object') {
            // Sem legacy para comparar — aceita engine se estrutura ok
            return true;
        }

        // Passo 3: validação de consistência numérica
        const engCusto = _n(resultEngine.custo_total);
        const legCusto = _n(resultLegacy.custo_total);
        const delta    = Math.abs(engCusto - legCusto);

        if (delta > DIVERGENCIA_THRESHOLD) {
            console.warn(
                `[${MOD}] 🔍 DIVERGÊNCIA engine vs legacy — engine rejeitada`,
                {
                    receita:      ficha?.nome || '(sem nome)',
                    engine_custo: engCusto.toFixed(4),
                    legacy_custo: legCusto.toFixed(4),
                    delta:        delta.toFixed(4),
                    overhead_pct: ficha?.overhead_pct,
                    mao_de_obra:  ficha?.mao_de_obra,
                    porcoes:      ficha?.porcoes,
                }
            );
            return false;
        }

        return true;

    } catch (_) {
        // Qualquer erro interno → rejeita engine por segurança
        return false;
    }
}

// ══════════════════════════════════════════════════════════════════
// RESULTADO SEGURO
// ══════════════════════════════════════════════════════════════════

/**
 * Retorna um resultado zerado e seguro para uso como fallback total.
 * Nunca contém NaN — todos os campos são números finitos.
 *
 * @returns {{ custo_total: number, custo_unitario: number, margem: number, markup: number, sugestoes: Array }}
 */
export function criarResultadoSeguro() {
    return {
        custo_total:    0,
        custo_unitario: 0,
        margem:         0,
        markup:         0,
        sugestoes:      [],
    };
}
