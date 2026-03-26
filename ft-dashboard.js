// ===== arquivo: ft-dashboard.js =====
// ft-dashboard.js — StockFlow Pro V3.0
// ══════════════════════════════════════════════════════════════════
// V3.0 — MIGRAÇÃO DA ENGINE (SAFE MODE):
//   [PRINCIPAL] Dashboard usa APENAS valores pré-processados (r.custo_total,
//               r.preco_venda) armazenados nas receitas — zero recálculo direto
//               de ingredientes. O custo_total de cada receita já foi calculado
//               pela engine ao salvar a ficha técnica.
//   [INTEGRAÇÃO] fichaService importado para uso em funções que precisam
//                de cálculo on-the-fly (ex: ranking por markup de referência).
//                calcularComEngine() usado com fallback via calcPrecoMarkup().
//   [PRESERVADO] Toda lógica de UI, ranking, destaques, rendimento e badge
//                permanece intacta — zero impacto visual.
//
// V2.2 — CORREÇÃO DE QUEBRA:
//   [CRÍTICO] renderDashboard: envolvido em try/catch externo.
//   [CRÍTICO] _renderRendimento: try/catch externo adicionado.
//   [ALTO]    _atualizarBadgeAlerta: try/catch adicionado.
//   [MÉDIO]   renderInsightsPanel: já tinha try/catch (V2.1) — mantido.
// ══════════════════════════════════════════════════════════════════
import { getReceitasAtivas } from './ft-receitas.js';
import { getIngredientes } from './ft-ingredientes.js';

// fichaService: usado para cálculos on-the-fly onde necessário
import { calcularComEngine } from './fichaService.js';

// ft-calc: funções de precificação de referência (markup para ranking/display)
import { calcPrecoMarkup, calcLucro, calcMargemReal, calcRendimento } from './ft-calc.js';

import { formatCurrency, formatPercent, formatQtdUnid, formatNum, esc } from './ft-format.js';
import { renderEmpty, renderTutorial, animateSection } from './ft-ui.js';
import { ico } from './ft-icons.js';
import { renderInsightsPanel } from './ft-ia.js';

const MOD = 'ft-dashboard';

// ── Helpers de acesso seguro ──────────────────────────────────────

/**
 * Acesso seguro a valores numéricos.
 * Nunca retorna NaN — sempre um número finito.
 * @param {*} v
 * @param {number} [fallback=0]
 * @returns {number}
 */
function _safeNum(v, fallback = 0) {
    const n = Number(v);
    return (isFinite(n) && !isNaN(n)) ? n : fallback;
}

/**
 * Obtém o custo total de uma receita usando o valor pré-processado.
 *
 * O dashboard NÃO recalcula custos — usa apenas o r.custo_total
 * que foi calculado e salvo ao editar a ficha técnica.
 * Esta é a fonte canônica de verdade para custos no dashboard.
 *
 * @param {Object} receita
 * @returns {number}
 */
function _getCustoTotal(receita) {
    return _safeNum(receita?.custo_total, 0);
}

// ── renderDashboard ───────────────────────────────────────────────
/**
 * V3.0: envolvido em try/catch externo.
 * Erros internos são logados mas nunca quebram a navegação.
 */
export function renderDashboard() {
    try {
        _renderDashboardInterno();
    } catch (e) {
        console.error(`[${MOD}] renderDashboard erro:`, e);
        // Fallback mínimo: exibe mensagem sem travar
        try {
            const wrap = document.getElementById('ft-dashboard');
            if (wrap) {
                wrap.innerHTML = `<div class="ft-sim-empty" style="padding:24px 16px">
                    ${ico.warn}<span>Erro ao carregar dashboard. Tente recarregar.</span>
                </div>`;
            }
        } catch (_) {}
    }
}

function _renderDashboardInterno() {
    const recs = getReceitasAtivas();
    const ings = getIngredientes();
    const wrap = document.getElementById('ft-dashboard');
    if (!wrap) return;

    renderTutorial('ft-sec-dash', 'dash', ico.dashboard, 'Entendendo o Dashboard', [
        'O dashboard usa <strong>markup 200%</strong> como referência para comparações.',
        'KPIs mostram um panorama rápido do seu cardápio.',
        'O ranking lista as pizzas da mais lucrativa para a menos lucrativa.',
        'Receitas com <strong>margem negativa</strong> são sinalizadas para correção.',
        '<strong>V3:</strong> Custos vêm diretamente da ficha técnica (pré-processados pela engine).',
    ]);

    if (!recs.length) {
        renderEmpty(wrap, ico.dashboard,
            'Dashboard vazio',
            'Cadastre receitas para ver as estatísticas de lucratividade.');
        return;
    }

    // Markup de referência para comparações no ranking
    const MK = 200;

    // ── Leitura de valores pré-processados ──────────────────────
    // REGRA: Dashboard usa APENAS r.custo_total (salvo pela engine ao editar).
    // Nunca recalcula a partir de ingredientes aqui.
    const custos = recs.map(r => _getCustoTotal(r));
    const precos = custos.map(c => {
        try {
            const p = calcPrecoMarkup(_safeNum(c), MK);
            return _safeNum(p);
        } catch (_) { return 0; }
    });
    const lucros = precos.map((p, i) => {
        try {
            const l = calcLucro(_safeNum(p), _safeNum(custos[i]));
            return _safeNum(l);
        } catch (_) { return 0; }
    });
    const margs = precos.map((p, i) => {
        try {
            const m = calcMargemReal(_safeNum(p), _safeNum(custos[i]));
            return _safeNum(m);
        } catch (_) { return 0; }
    });
    const n = recs.length;

    // ── KPIs ─────────────────────────────────────────────────────
    const custoMed = n > 0
        ? _safeNum(custos.reduce((a, b) => a + _safeNum(b), 0) / n)
        : 0;
    const margMed = n > 0
        ? _safeNum(margs.reduce((a, b) => a + _safeNum(b), 0) / n)
        : 0;

    // Preço médio de venda real (onde definido pelo usuário)
    const comPreco = recs.filter(r => _safeNum(r?.preco_venda) > 0);
    const precoMedVenda = comPreco.length
        ? _safeNum(comPreco.reduce((s, r) => s + _safeNum(r?.preco_venda), 0) / comPreco.length)
        : 0;

    // ── Destaques ─────────────────────────────────────────────────
    const iMC = custos.reduce((mi, v, i, a) => _safeNum(v) > _safeNum(a[mi]) ? i : mi, 0);
    const imc = custos.reduce((mi, v, i, a) => _safeNum(v) < _safeNum(a[mi]) ? i : mi, 0);
    const iML = lucros.reduce((mi, v, i, a) => _safeNum(v) > _safeNum(a[mi]) ? i : mi, 0);

    // ── Ranking ───────────────────────────────────────────────────
    const ranking = recs
        .map((r, i) => ({
            r,
            c: _safeNum(custos[i]),
            p: _safeNum(precos[i]),
            l: _safeNum(lucros[i]),
            m: _safeNum(margs[i]),
        }))
        .sort((a, b) => _safeNum(b.l) - _safeNum(a.l));

    // ── Alertas de margem negativa ────────────────────────────────
    const negativas = ranking.filter(it => _safeNum(it.m) <= 0 || _safeNum(it.c) === 0);
    _atualizarBadgeAlerta(negativas.length);

    const alertaHtml = negativas.length ? `
        <div class="ft-alerta-margem">
            <div class="ft-alerta-ico">${ico.warn}</div>
            <div class="ft-alerta-body">
                <div class="ft-alerta-titulo">Atenção: margem negativa</div>
                <div class="ft-alerta-sub">
                    ${negativas.map(it =>
                        `<span class="ft-alerta-nome">${esc(it.r?.nome || '')}</span>`
                    ).join('')}
                </div>
                <div class="ft-alerta-hint">Verifique os custos no Simulador.</div>
            </div>
        </div>` : '';

    // ── Render principal ──────────────────────────────────────────
    wrap.innerHTML = `
        ${alertaHtml}

        <div class="ft-kpis">
            <div class="ft-kpi">
                <div class="ft-kpi-ico">${ico.recipes}</div>
                <div class="ft-kpi-val">${n}</div>
                <div class="ft-kpi-lbl">Receitas</div>
            </div>
            <div class="ft-kpi">
                <div class="ft-kpi-ico">${ico.ingredients}</div>
                <div class="ft-kpi-val">${Array.isArray(ings) ? ings.length : 0}</div>
                <div class="ft-kpi-lbl">Ingredientes</div>
            </div>
            <div class="ft-kpi">
                <div class="ft-kpi-ico">${ico.tag}</div>
                <div class="ft-kpi-val">${formatCurrency(custoMed)}</div>
                <div class="ft-kpi-lbl">Custo médio</div>
            </div>
            ${precoMedVenda > 0 ? `
            <div class="ft-kpi ft-kpi-hi">
                <div class="ft-kpi-ico">${ico.money}</div>
                <div class="ft-kpi-val">${formatCurrency(precoMedVenda)}</div>
                <div class="ft-kpi-lbl">Preço médio venda</div>
            </div>` : `
            <div class="ft-kpi${_safeNum(margMed) < 0 ? ' ft-kpi-danger' : ' ft-kpi-hi'}">
                <div class="ft-kpi-ico">${ico.money}</div>
                <div class="ft-kpi-val">${formatPercent(_safeNum(margMed))}</div>
                <div class="ft-kpi-lbl">Margem média</div>
            </div>`}
        </div>

        <div id="ft-ia-insights-container"></div>

        <div class="ft-dash-sec-title section-enter">Destaques</div>
        <div class="ft-destaques">
            <div class="ft-dest ft-dest-green">
                <div class="ft-dest-ico">${ico.trophy}</div>
                <div>
                    <div class="ft-dest-lbl">Mais lucrativa</div>
                    <div class="ft-dest-name">${esc(recs[iML]?.nome || '')}</div>
                    <div class="ft-dest-val">${formatCurrency(_safeNum(lucros[iML]))} lucro</div>
                </div>
            </div>
            ${n > 1 ? `
            <div class="ft-dest ft-dest-amber">
                <div class="ft-dest-ico">${ico.star}</div>
                <div>
                    <div class="ft-dest-lbl">Mais cara (custo)</div>
                    <div class="ft-dest-name">${esc(recs[iMC]?.nome || '')}</div>
                    <div class="ft-dest-val">${formatCurrency(_safeNum(custos[iMC]))} custo</div>
                </div>
            </div>
            <div class="ft-dest ft-dest-blue">
                <div class="ft-dest-ico">${ico.check}</div>
                <div>
                    <div class="ft-dest-lbl">Mais barata (custo)</div>
                    <div class="ft-dest-name">${esc(recs[imc]?.nome || '')}</div>
                    <div class="ft-dest-val">${formatCurrency(_safeNum(custos[imc]))} custo</div>
                </div>
            </div>` : ''}
        </div>

        <div class="ft-dash-sec-title">
            Ranking <span class="ft-dash-sec-sub">markup ${MK}%</span>
        </div>
        <div class="ft-ranking">
            ${ranking.map((it, pos) => {
                const maxL  = _safeNum(ranking[0]?.l);
                const barW  = maxL > 0 ? (_safeNum(it.l) / maxL * 100).toFixed(1) : 0;
                const medal = pos === 0 ? '1.' : pos === 1 ? '2.' : pos === 2 ? '3.' : '';
                const negCls = _safeNum(it.m) <= 0 ? 'ft-rank-item-neg' : '';
                return `
                <div class="ft-rank-item ${negCls}">
                    <div class="ft-rank-pos">${medal || pos + 1}</div>
                    <div class="ft-rank-body">
                        <div class="ft-rank-name">
                            ${esc(it.r?.nome || '')}
                            <span class="ft-tam-pill">${it.r?.tamanho || ''}</span>
                            ${_safeNum(it.m) <= 0 ? `<span class="ft-warn-badge">${ico.warn}</span>` : ''}
                        </div>
                        <div class="ft-rank-sub">Custo ${formatCurrency(_safeNum(it.c))} · Preço ${formatCurrency(_safeNum(it.p))}</div>
                        <div class="ft-rank-bar-wrap">
                            <div class="ft-rank-bar${_safeNum(it.m) <= 0 ? ' red' : ''}" style="width:${barW}%"></div>
                        </div>
                    </div>
                    <div class="ft-rank-right">
                        <div class="ft-rank-lucro${_safeNum(it.l) <= 0 ? ' neg' : ''}">${formatCurrency(_safeNum(it.l))}</div>
                        <div class="ft-rank-marg">${formatPercent(_safeNum(it.m))}</div>
                    </div>
                </div>`;
            }).join('')}
        </div>

        ${_renderRendimento(recs, ings)}`;

    // V3: painel IA renderizado após DOM montado
    // Os dados para a IA usam apenas valores pré-processados
    const receitasParaIA = recs.map(r => ({
        nome:        r?.nome        || '',
        custo_total: _getCustoTotal(r),
        preco_venda: _safeNum(r?.preco_venda),
    }));
    try {
        renderInsightsPanel('ft-ia-insights-container', receitasParaIA, { margem_alvo: 30 });
    } catch (e) {
        console.error(`[${MOD}] renderInsightsPanel falhou:`, e);
    }
}

// ── Bloco de rendimento ───────────────────────────────────────────
/**
 * Renderiza bloco de rendimento de ingredientes por embalagem.
 * Usa dados de ingredientes pré-carregados (getIngredientes()).
 * Nunca recalcula custo — apenas exibe rendimento de unidades.
 */
function _renderRendimento(recs, ings) {
    try {
        if (!Array.isArray(ings) || !ings.length) return '';

        const ingsUsados = ings.filter(ig =>
            ig && ig.id &&
            recs.some(r => Array.isArray(r?.ingredientes) &&
                r.ingredientes.some(i => i && i.ingrediente_id === ig.id)
            )
        );

        if (!ingsUsados.length) return '';

        return `
            <div class="ft-dash-sec-title">Rendimento de ingredientes</div>
            <div class="ft-rendilist">
                ${ingsUsados
                    .sort((a, b) => (a?.nome || '').localeCompare(b?.nome || '', 'pt-BR'))
                    .map(ig => {
                        const usos = recs.flatMap(r =>
                            (Array.isArray(r?.ingredientes) ? r.ingredientes : [])
                                .filter(i => i && i.ingrediente_id === ig.id)
                                .map(i => ({ pizza: r?.nome || '', qtd: _safeNum(i?.quantidade) }))
                        );

                        const embQtd = _safeNum(ig?.quantidade_embalagem);

                        return `
                        <div class="ft-rend-card">
                            <div class="ft-rend-hd">
                                <span class="ft-rend-nome">${esc(ig?.nome || '')}</span>
                                <span class="ft-rend-emb">${formatQtdUnid(embQtd, ig?.unidade || '')}/emb.</span>
                            </div>
                            ${usos.map(u => {
                                const rend = embQtd > 0 && _safeNum(u?.qtd) > 0
                                    ? _safeNum(calcRendimento(embQtd, _safeNum(u.qtd))) : 0;
                                return `
                                <div class="ft-rend-row">
                                    <span>${esc(u?.pizza || '')}</span>
                                    <span class="ft-rend-qtd">${formatQtdUnid(_safeNum(u?.qtd), ig?.unidade || '')}/pizza</span>
                                    <span class="ft-rend-res">${formatNum(_safeNum(rend), 1)} pizzas/emb.</span>
                                </div>`;
                            }).join('')}
                        </div>`;
                    }).join('')}
            </div>`;
    } catch (e) {
        console.error(`[${MOD}] _renderRendimento erro:`, e);
        return '';
    }
}

// ── Badge de alerta ───────────────────────────────────────────────
function _atualizarBadgeAlerta(n) {
    try {
        const btn = document.querySelector('.ft-nav-btn[data-tab="dash"]');
        if (!btn) return;
        let badge = btn.querySelector('.ft-nav-badge');
        if (n > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'ft-nav-badge';
                btn.appendChild(badge);
            }
            badge.textContent = n;
        } else {
            badge?.remove();
        }
    } catch (e) {
        console.error(`[${MOD}] _atualizarBadgeAlerta erro:`, e);
    }
}
