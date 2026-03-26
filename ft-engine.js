// ===== arquivo: ft-engine.js =====
// ft-engine.js — StockFlow Pro v10.0
// ══════════════════════════════════════════════════════════════════
// ENGINE PURA DE CÁLCULO — Ficha Técnica
// ──────────────────────────────────────────────────────────────────
// PRINCÍPIOS ABSOLUTOS:
//   1. ZERO fetch() — nenhuma chamada de rede.
//   2. ZERO localStorage — nenhum efeito colateral de armazenamento.
//   3. ZERO firebase — isolado completamente da camada de dados.
//   4. ZERO console com efeito colateral — apenas logs puros de debug.
//   5. ZERO acesso ao DOM — funções puras, testáveis, portáveis.
//
// CONTRATO DE SAÍDA (sempre retorna este shape):
//   {
//     custo_total:    number,   — custo total do lote em R$
//     custo_unitario: number,   — custo por porção em R$
//     margem:         number,   — margem real % sobre preço de venda
//     markup:         number,   — markup implícito %
//     sugestoes:      Array     — diagnósticos automáticos
//   }
//
// API PRINCIPAL:
//   calcularEngine(input)         — cálculo completo
//   calcularPrecoSugeridoEngine   — preço de venda a partir de margem
//   calcularMarkupEngine          — preço de venda a partir de markup
//   calcularMargemEngine          — margem real %
//   calcularSugestoes             — diagnósticos automáticos
// ══════════════════════════════════════════════════════════════════

// ── Utilitários internos ──────────────────────────────────────────

/** Garante número finito ≥ 0; NaN / null / undefined → 0 */
const _n = v => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) && !isNaN(n) ? Math.max(0, n) : 0;
};

/** Arredonda para N casas decimais */
const _round = (v, dec = 4) => Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec);

// ── Saída vazia (fail-safe universal) ────────────────────────────

/**
 * Retorna a saída padrão zerada.
 * Usada como fallback em qualquer erro interno.
 * @returns {{ custo_total, custo_unitario, margem, markup, sugestoes }}
 */
export function saidaVazia() {
    return {
        custo_total:    0,
        custo_unitario: 0,
        margem:         0,
        markup:         0,
        sugestoes:      [],
    };
}

// ══════════════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL — calcularEngine
// ══════════════════════════════════════════════════════════════════

/**
 * Calcula todos os valores financeiros de uma ficha técnica.
 *
 * @param {Object} input
 * @param {Array<{custo?: number}>} input.ingredientes    — lista de ingredientes com custo por item
 * @param {number} [input.overhead_pct]   — overhead em % sobre custo de ingredientes (ex: 15)
 * @param {number} [input.mao_de_obra]    — mão de obra fixa em R$ por lote
 * @param {number} [input.custo_fixo]     — custo fixo rateado em R$ (ex: aluguel proporcional)
 * @param {number} [input.porcoes]        — número de porções/unidades (default: 1)
 * @param {number} [input.margem]         — margem desejada em % (usado para sugestões)
 * @param {number} [input.preco_venda]    — preço de venda atual em R$ (para calcular margem real)
 * @param {number} [input.perda_pct]      — % de perda no preparo (ex: 5 = +5% sobre matérias)
 *
 * @returns {{
 *   custo_total:    number,
 *   custo_unitario: number,
 *   margem:         number,
 *   markup:         number,
 *   sugestoes:      Array<{tipo: string, mensagem: string}>
 * }}
 */
export function calcularEngine(input) {
    // Validação de entrada — nunca lança, retorna vazio
    if (!input || typeof input !== 'object') {
        return saidaVazia();
    }

    // ── 1. Custo bruto dos ingredientes ──────────────────────────
    const ingredientes = Array.isArray(input.ingredientes) ? input.ingredientes : [];
    const custo_ingredientes = ingredientes.reduce((soma, ing) => {
        return soma + _n(ing && ing.custo != null ? ing.custo : 0);
    }, 0);

    // ── 2. Parâmetros de produção ─────────────────────────────────
    const overhead_pct = _n(input.overhead_pct);
    const mao_de_obra  = _n(input.mao_de_obra);
    const custo_fixo   = _n(input.custo_fixo);
    const perda_pct    = _n(input.perda_pct);
    const porcoes      = Math.max(1, _n(input.porcoes) || 1);

    // ── 3. Fator de perda no preparo ─────────────────────────────
    // Ex: perda_pct = 5 → ingredientes custam 5% a mais na prática
    const fator_perda = 1 + (perda_pct / 100);
    const custo_ings_com_perda = custo_ingredientes * fator_perda;

    // ── 4. Overhead sobre ingredientes (com perda) ────────────────
    const custo_overhead = custo_ings_com_perda * (overhead_pct / 100);

    // ── 5. Custo total do lote ────────────────────────────────────
    const custo_total = custo_ings_com_perda + custo_overhead + mao_de_obra + custo_fixo;

    // ── 6. Custo unitário (por porção) ────────────────────────────
    const custo_unitario = porcoes > 0 ? custo_total / porcoes : custo_total;

    // ── 7. Margem real e markup ───────────────────────────────────
    const preco_venda = _n(input.preco_venda);
    const margem_real = preco_venda > 0 && custo_unitario >= 0
        ? ((preco_venda - custo_unitario) / preco_venda) * 100
        : _n(input.margem); // fallback: margem desejada

    const markup = custo_unitario > 0 && preco_venda > 0
        ? ((preco_venda - custo_unitario) / custo_unitario) * 100
        : 0;

    // ── 8. Sugestões automáticas ──────────────────────────────────
    const sugestoes = calcularSugestoes({
        custo_ingredientes,
        custo_total,
        custo_unitario,
        margem_real,
        preco_venda,
        margem_desejada: _n(input.margem),
    });

    return {
        custo_total:    _round(custo_total),
        custo_unitario: _round(custo_unitario),
        margem:         _round(margem_real),
        markup:         _round(markup),
        sugestoes,
    };
}

// ══════════════════════════════════════════════════════════════════
// FUNÇÕES AUXILIARES DE PRECIFICAÇÃO
// ══════════════════════════════════════════════════════════════════

/**
 * Calcula preço de venda a partir de custo e margem desejada.
 * Fórmula: custo / (1 − margem/100)
 *
 * @param {number} custo_unitario — custo por unidade em R$
 * @param {number} margem_pct     — margem desejada em % (deve ser < 100)
 * @returns {number} Preço sugerido em R$ (0 se margem ≥ 100)
 */
export function calcularPrecoSugeridoEngine(custo_unitario, margem_pct) {
    const c = _n(custo_unitario);
    const m = _n(margem_pct) / 100;
    if (m >= 1) return 0;
    return _round(c / (1 - m));
}

/**
 * Calcula preço de venda a partir de custo e markup.
 * Fórmula: custo × (1 + markup/100)
 *
 * @param {number} custo_unitario — custo por unidade em R$
 * @param {number} markup_pct     — markup em % (ex: 200 = preço 3× o custo)
 * @returns {number} Preço sugerido em R$
 */
export function calcularMarkupEngine(custo_unitario, markup_pct) {
    return _round(_n(custo_unitario) * (1 + _n(markup_pct) / 100));
}

/**
 * Calcula a margem real % sobre o preço de venda.
 * Fórmula: ((preco - custo) / preco) × 100
 *
 * @param {number} preco — preço de venda em R$
 * @param {number} custo — custo unitário em R$
 * @returns {number} Margem em % (0 se preco ≤ 0)
 */
export function calcularMargemEngine(preco, custo) {
    const p = _n(preco);
    if (p <= 0) return 0;
    return _round(((p - _n(custo)) / p) * 100);
}

// ══════════════════════════════════════════════════════════════════
// DIAGNÓSTICOS — Sugestões automáticas
// ══════════════════════════════════════════════════════════════════

/**
 * Gera lista de sugestões baseadas nos resultados do cálculo.
 * Nunca lança — retorna array vazio em caso de erro.
 *
 * @param {Object} params
 * @returns {Array<{tipo: string, mensagem: string, prioridade: number}>}
 */
export function calcularSugestoes({
    custo_ingredientes = 0,
    custo_total        = 0,
    custo_unitario     = 0,
    margem_real        = 0,
    preco_venda        = 0,
    margem_desejada    = 0,
} = {}) {
    const sugestoes = [];

    // Sem ingredientes cadastrados
    if (custo_ingredientes <= 0 && custo_total <= 0) {
        sugestoes.push({
            tipo:       'sem_ingredientes',
            prioridade: 1,
            mensagem:   'Adicione ingredientes para calcular o custo da receita.',
        });
        return sugestoes;
    }

    // Sem preço de venda definido
    if (preco_venda <= 0) {
        sugestoes.push({
            tipo:       'sem_preco',
            prioridade: 2,
            mensagem:   'Defina um preço de venda para visualizar a margem real.',
        });
        return sugestoes;
    }

    // Preço abaixo do custo (prejuízo)
    if (preco_venda > 0 && preco_venda <= custo_unitario) {
        sugestoes.push({
            tipo:       'prejuizo',
            prioridade: 1,
            mensagem:   `⚠️ Preço de venda (R$ ${preco_venda.toFixed(2)}) está abaixo do custo (R$ ${custo_unitario.toFixed(2)}). Ajuste urgente necessário.`,
        });
        return sugestoes;
    }

    // Margem crítica (< 15%)
    if (margem_real < 15) {
        sugestoes.push({
            tipo:       'margem_critica',
            prioridade: 1,
            mensagem:   `Margem de ${margem_real.toFixed(1)}% está abaixo do mínimo recomendado (15%). Revise os custos ou aumente o preço.`,
        });
    }

    // Margem baixa (15% - 25%)
    else if (margem_real < 25) {
        sugestoes.push({
            tipo:       'margem_baixa',
            prioridade: 2,
            mensagem:   `Margem de ${margem_real.toFixed(1)}% está aceitável, mas pode melhorar. Meta recomendada: 25-40%.`,
        });
    }

    // Margem dentro do alvo
    else if (margem_real >= 25 && margem_real < 40) {
        sugestoes.push({
            tipo:       'margem_boa',
            prioridade: 3,
            mensagem:   `Margem de ${margem_real.toFixed(1)}% está saudável. Mantenha ou expanda essa receita.`,
        });
    }

    // Margem excelente
    else if (margem_real >= 40) {
        sugestoes.push({
            tipo:       'margem_otima',
            prioridade: 3,
            mensagem:   `Margem de ${margem_real.toFixed(1)}% excelente! Produto estratégico para o cardápio.`,
        });
    }

    // Divergência entre margem real e desejada
    if (margem_desejada > 0 && preco_venda > 0) {
        const delta = Math.abs(margem_real - margem_desejada);
        if (delta > 5) {
            const precoIdeal = calcularPrecoSugeridoEngine(custo_unitario, margem_desejada);
            sugestoes.push({
                tipo:       'divergencia_margem',
                prioridade: 2,
                mensagem:   `Para atingir ${margem_desejada}% de margem, o preço ideal seria R$ ${precoIdeal.toFixed(2)}.`,
            });
        }
    }

    return sugestoes;
}
