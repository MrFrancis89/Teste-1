// ===== arquivo: ft-custos.js =====
// ft-custos.js — v4.0
// ══════════════════════════════════════════════════════════════════
// v4.0 — MIGRAÇÃO DA ENGINE (SAFE MODE):
//   [CRÍTICO] _calcInterno: usa calcularComEngine() de fichaService.js
//             em vez de calcCustoEfetivo() diretamente. Resultado é
//             validado antes de atualizar a UI. Fail-safe total.
//   [CRÍTICO] Modo SAFE ativo: engine validada por engineValidator antes
//             de ser usada. Fallback automático para legacy se inválida.
//   [ALTO]    precificarPorMarkup e precificarPorMargem de fichaService
//             substituem chamadas diretas a calcPrecoMarkup/Margem.
//   [MÉDIO]   Toda lógica de UI (renderSimulador, eventos, renderComparar)
//             permanece intacta — zero impacto visual.
//
// v3.5 — CORREÇÃO DE QUEBRA:
//   [CRÍTICO] renderSimulador: envolvido em try/catch externo.
//   [CRÍTICO] _calc: envolvido em try/catch externo.
//   [CRÍTICO] _renderComparacaoLive: try/catch externo adicionado.
//   [ALTO]    _bindPair: eventos nunca disparam erro não tratado.
//   [MÉDIO]   initSimulador: já tinha try/catch (v3.4) — mantido.
//   [MÉDIO]   _salvarCfgDebounced: .catch com log (v3.4) — mantido.
// ══════════════════════════════════════════════════════════════════
import { getReceitasAtivas } from './ft-receitas.js';

// Engine nova — via fichaService (adapter seguro)
import {
    calcularComEngine,
    precificarPorMarkup,
    precificarPorMargem,
    ENGINE_MODE,
} from './fichaService.js';

// Legacy — mantido para fallback hard no comparador e porção
import { calcPrecoMarkup, calcCustoEfetivo, calcLucro, calcMargemReal,
         calcMarkupImplicito, calcCustoPorcao } from './ft-calc.js';

import { formatCurrency, formatPercent, formatQtdUnid, parseNum, n2input,
         PORCOES_PADRAO, applyMaskDecimalConfig, esc } from './ft-format.js';
import { toast, renderTutorial, debounce, animateSection } from './ft-ui.js';
import { carregarConfig, salvarConfig } from './ft-storage.js';
import { ico } from './ft-icons.js';

const MOD = 'ft-custos';

let _cfg  = { markup: 200, margem: 40, overhead: 0, maoDeObra: 0, porcoes: 0 };
let _modo = 'markup';   // 'markup' | 'margem' | 'comparar'

// ── Helper seguro ─────────────────────────────────────────────────

/**
 * Converte para número finito seguro; NaN / null / undefined → 0.
 * @param {*} v
 * @returns {number}
 */
function _safeNum(v) {
    const n = Number(v);
    return (isFinite(n) && !isNaN(n)) ? n : 0;
}

// ── Salvar config ─────────────────────────────────────────────────

const _salvarCfgDebounced = debounce(() => {
    salvarConfig({
        markup_padrao:   _cfg.markup,
        margem_desejada: _cfg.margem,
        overhead_pct:    _cfg.overhead,
        mao_de_obra_r:   _cfg.maoDeObra,
        porcoes_padrao:  _cfg.porcoes,
    }).catch(e => console.error(`[${MOD}] _salvarCfgDebounced falhou:`, e));
}, 800);

// ── initSimulador ─────────────────────────────────────────────────
/**
 * Carrega configurações do usuário.
 * NUNCA lança — usa defaults em caso de falha.
 */
export async function initSimulador() {
    try {
        const c = await carregarConfig();
        if (c && typeof c === 'object') {
            _cfg.markup    = _safeNum(c.markup_padrao)    || 200;
            _cfg.margem    = _safeNum(c.margem_desejada)  || 40;
            _cfg.overhead  = _safeNum(c.overhead_pct)     || 0;
            _cfg.maoDeObra = _safeNum(c.mao_de_obra_r)    || 0;
            _cfg.porcoes   = _safeNum(c.porcoes_padrao)   || 0;
            console.info(`[${MOD}] ✓ Config carregada. Engine mode: ${ENGINE_MODE}`);
        }
    } catch (e) {
        console.error(`[${MOD}] initSimulador: carregarConfig falhou — usando defaults:`, e);
    }
}

// ── renderSimulador ───────────────────────────────────────────────
/**
 * v4.0: envolvido em try/catch externo.
 * Erros internos são logados mas nunca quebram a navegação.
 */
export function renderSimulador() {
    try {
        _renderSimuladorInterno();
    } catch (e) {
        console.error(`[${MOD}] renderSimulador erro:`, e);
        try {
            const wrap = document.getElementById('ft-simulador');
            if (wrap) {
                wrap.innerHTML = `<div class="ft-sim-empty" style="padding:24px 16px">
                    ${ico.warn}<span>Erro ao carregar simulador. Tente recarregar.</span>
                </div>`;
            }
        } catch (_) {}
    }
}

function _renderSimuladorInterno() {
    const recs = getReceitasAtivas();
    const wrap = document.getElementById('ft-simulador');
    if (!wrap) return;
    animateSection(wrap);
    renderTutorial('ft-sec-sim', 'sim', ico.simulator, 'Como usar o Simulador', [
        'Selecione uma pizza e ajuste markup ou margem para ver o preço sugerido.',
        'Overhead (%): acrescenta custo de gás, embalagem e energia sobre os ingredientes.',
        'Mão de obra (R$): valor fixo por pizza adicionado ao custo efetivo.',
        'Comparar: veja até 4 pizzas lado a lado com o mesmo markup.',
    ]);

    const opts = recs.length
        ? recs.map(r => `<option value="${r.id}">${esc(r.nome)} (${r.tamanho})</option>`).join('')
        : '';

    const tabs = ['markup','margem','comparar'].map(m =>
        `<button class="ft-sim-tab${_modo === m ? ' active' : ''}" data-m="${m}" type="button">
            ${m === 'markup' ? 'Markup' : m === 'margem' ? 'Margem' : 'Comparar'}
        </button>`).join('');

    wrap.innerHTML = `
        <!-- Seleção -->
        <div class="ft-sim-bloco" id="ft-sim-sel-bloco">
            <div class="ft-sim-bh">${ico.recipes}<span>Selecionar pizza</span></div>
            ${recs.length
                ? `<div class="ft-sim-pad">
                    <select id="ft-sim-sel" class="ft-input ft-select">
                        <option value="">— Selecione —</option>${opts}
                    </select>
                   </div>`
                : `<div class="ft-sim-empty">${ico.warn}
                    <span>Nenhuma receita ativa. Acesse <strong>Receitas</strong> e crie uma.</span>
                   </div>`}
        </div>

        <!-- Tabs -->
        <div class="ft-sim-bloco">
            <div class="ft-sim-tabs">${tabs}</div>

            <!-- Markup -->
            <div id="ft-sm-markup" class="${_modo !== 'markup' ? 'hidden' : ''}">
                <div class="ft-sim-pad">
                    <div class="ft-tip-banner">${ico.info}
                        <span>Markup de <strong>200%</strong> = preço 3× o custo.</span>
                    </div>
                    <input type="range" id="ft-mk-r" class="ft-slider" min="50" max="500" step="10" value="${_cfg.markup}">
                    <div class="ft-slider-val-row">
                        <span>Markup:</span>
                        <input id="ft-mk-i" class="ft-input ft-input-sm" type="number" value="${_cfg.markup}" min="0" step="10" inputmode="decimal">
                        <span>%</span>
                    </div>
                </div>
            </div>

            <!-- Margem -->
            <div id="ft-sm-margem" class="${_modo !== 'margem' ? 'hidden' : ''}">
                <div class="ft-sim-pad">
                    <div class="ft-tip-banner">${ico.info}
                        <span>Margem de <strong>40%</strong> = R$ 40 de lucro a cada R$ 100 vendido.</span>
                    </div>
                    <input type="range" id="ft-mg-r" class="ft-slider" min="5" max="90" step="5" value="${_cfg.margem}">
                    <div class="ft-slider-val-row">
                        <span>Margem:</span>
                        <input id="ft-mg-i" class="ft-input ft-input-sm" type="number" value="${_cfg.margem}" min="1" max="99" step="1" inputmode="decimal">
                        <span>%</span>
                    </div>
                </div>
            </div>

            <!-- Comparar -->
            <div id="ft-sm-comparar" class="${_modo !== 'comparar' ? 'hidden' : ''}">
                <div class="ft-sim-pad" id="ft-cmp-content">
                    ${_renderComparar(recs)}
                </div>
            </div>
        </div>

        <!-- Overhead + mão de obra -->
        <div class="ft-sim-bloco">
            <div class="ft-sim-bh">${ico.gear}<span>Custos operacionais</span></div>
            <div class="ft-sim-pad">
                <div class="ft-tip-banner">${ico.tip}
                    <span>Esses valores são somados ao custo dos ingredientes no cálculo do preço.</span>
                </div>
                <div class="ft-field-row">
                    <div class="ft-field">
                        <label for="ft-ovh">Overhead</label>
                        <div class="ft-input-suf-wrap">
                            <input id="ft-ovh" class="ft-input has-suf" type="text"
                                value="${_cfg.overhead > 0 ? n2input(_cfg.overhead) : ''}" inputmode="decimal" autocomplete="off">
                            <span class="ft-input-suf">%</span>
                        </div>
                        <span class="ft-field-hint">Gás, energia, embalagem…</span>
                    </div>
                    <div class="ft-field">
                        <label for="ft-mdo">Mão de obra</label>
                        <div class="ft-input-pre-wrap">
                            <span class="ft-input-pre">R$</span>
                            <input id="ft-mdo" class="ft-input has-pre" type="text"
                                value="${_cfg.maoDeObra > 0 ? n2input(_cfg.maoDeObra) : ''}" inputmode="decimal" autocomplete="off">
                        </div>
                        <span class="ft-field-hint">Valor fixo por pizza.</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Resultado -->
        <div id="ft-sim-res" class="hidden">
            <div class="ft-sim-bloco">
                <div class="ft-sim-bh">${ico.money}<span>Resultado</span></div>
                <div class="ft-sim-pad">
                    <div class="ft-custo-breakdown" id="ft-breakdown"></div>
                    <div class="ft-res-grid" id="ft-res-cards"></div>
                    <div class="ft-porcao-row">
                        <div class="ft-field">
                            <label for="ft-porcoes">Porções (fatias)</label>
                            <input id="ft-porcoes" class="ft-input ft-input-sm" type="number"
                                min="1" max="24" step="1" value="${_cfg.porcoes || ''}"
                                placeholder="Auto" inputmode="numeric">
                        </div>
                        <div class="ft-porcao-result" id="ft-porcao-val"></div>
                    </div>
                </div>
            </div>
            <div class="ft-sim-bloco">
                <div class="ft-sim-bh">${ico.tag}<span>Composição do custo</span></div>
                <div id="ft-sim-comp"></div>
            </div>
        </div>`;

    // ── Eventos ────────────────────────────────────────────────────
    document.getElementById('ft-sim-sel')?.addEventListener('change', _calc);
    document.querySelectorAll('.ft-sim-tab').forEach(b => b.addEventListener('click', () => {
        try {
            _modo = b.dataset.m;
            document.querySelectorAll('.ft-sim-tab').forEach(x => x.classList.toggle('active', x === b));
            document.getElementById('ft-sm-markup')?.  classList.toggle('hidden', _modo !== 'markup');
            document.getElementById('ft-sm-margem')?.  classList.toggle('hidden', _modo !== 'margem');
            document.getElementById('ft-sm-comparar')?.classList.toggle('hidden', _modo !== 'comparar');
            if (_modo !== 'comparar') _calc();
            else _renderComparacaoLive();
        } catch (e) {
            console.error(`[${MOD}] tab click erro:`, e);
        }
    }));

    _bindPair('ft-mk-r', 'ft-mk-i');
    _bindPair('ft-mg-r', 'ft-mg-i');

    const ovhEl = document.getElementById('ft-ovh');
    const mdoEl = document.getElementById('ft-mdo');
    if (ovhEl) applyMaskDecimalConfig(ovhEl);
    if (mdoEl) applyMaskDecimalConfig(mdoEl);

    document.getElementById('ft-ovh')?.addEventListener('input', () => {
        try {
            _cfg.overhead = parseNum(document.getElementById('ft-ovh')?.value) || 0;
            _calc();
        } catch (e) { console.error(`[${MOD}] ovh input erro:`, e); }
    });
    document.getElementById('ft-mdo')?.addEventListener('input', () => {
        try {
            _cfg.maoDeObra = parseNum(document.getElementById('ft-mdo')?.value) || 0;
            _calc();
        } catch (e) { console.error(`[${MOD}] mdo input erro:`, e); }
    });
    document.getElementById('ft-porcoes')?.addEventListener('input', _calc);

    if (recs.length === 1) {
        const s = document.getElementById('ft-sim-sel');
        if (s) { s.value = recs[0].id; _calc(); }
    }
}

function _bindPair(rid, iid) {
    try {
        const r = document.getElementById(rid), i = document.getElementById(iid);
        if (!r || !i) return;
        r.addEventListener('input', () => {
            try { if (i.value !== r.value) i.value = r.value; _calc(); } catch (_) {}
        });
        i.addEventListener('input', () => {
            try { if (r.value !== i.value) r.value = i.value; _calc(); } catch (_) {}
        });
    } catch (e) {
        console.error(`[${MOD}] _bindPair(${rid}, ${iid}) erro:`, e);
    }
}

// ── _calc ─────────────────────────────────────────────────────────
/**
 * v4.0: envolvido em try/catch externo — erros de cálculo não
 * interrompem a interação do usuário.
 */
function _calc() {
    try {
        _calcInterno();
    } catch (e) {
        console.error(`[${MOD}] _calc erro:`, e);
    }
}

// ── _calcInterno ─────────────────────────────────────────────────
/**
 * v4.0 — MIGRAÇÃO DA ENGINE (SAFE MODE):
 * Usa calcularComEngine() de fichaService para o custo efetivo.
 * Engine validada por engineValidator — fallback automático para legacy.
 * O resultado é sempre validado (nunca NaN na UI).
 */
function _calcInterno() {
    const selEl = document.getElementById('ft-sim-sel');
    const rec   = selEl?.value ? getReceitasAtivas().find(r => r.id === selEl.value) : null;
    const resEl = document.getElementById('ft-sim-res');
    if (!rec) { resEl?.classList.add('hidden'); return; }
    resEl?.classList.remove('hidden');

    const ovh = _safeNum(parseNum(document.getElementById('ft-ovh')?.value));
    const mdo = _safeNum(parseNum(document.getElementById('ft-mdo')?.value));
    _cfg.overhead  = ovh;
    _cfg.maoDeObra = mdo;

    // ── NOVO: calcula custo efetivo via engine ────────────────────
    // fichaService.calcularComEngine() respeita ENGINE_MODE e tem fallback
    // automático (via engineValidator) para o cálculo antigo se a engine
    // for inválida ou divergir.
    const engineResult = calcularComEngine({
        nome:         rec.nome        || '',
        ingredientes: Array.isArray(rec.ingredientes) ? rec.ingredientes : [],
        custo_total:  _safeNum(rec.custo_total),
        overhead_pct: ovh,
        mao_de_obra:  mdo,
        custo_fixo:   0,
        porcoes:      1,
        margem:       _safeNum(_cfg.margem),
        preco_venda:  0,
    });

    // Validação: custo_total nunca pode ser NaN na UI
    const custoIng = _safeNum(rec.custo_total);
    const custoEf  = _safeNum(engineResult?.custo_total) >= 0 && isFinite(_safeNum(engineResult?.custo_total))
        ? _safeNum(engineResult.custo_total)
        : calcCustoEfetivo(custoIng, ovh, mdo); // fallback hard: nunca NaN

    // ── Precificação (markup ou margem) ──────────────────────────
    let preco = 0;
    let lucro = 0;
    let marR  = 0;
    let mkImp = 0;

    if (_modo === 'markup') {
        const mk = _safeNum(parseNum(document.getElementById('ft-mk-i')?.value));
        const pf = precificarPorMarkup(custoEf, mk);
        preco = _safeNum(pf?.preco);
        lucro = _safeNum(pf?.lucro);
        marR  = _safeNum(pf?.margemReal);
        mkImp = _safeNum(pf?.markupImplicito);
        if (mk > 0) _cfg.markup = mk;
    } else if (_modo === 'margem') {
        const mg = _safeNum(parseNum(document.getElementById('ft-mg-i')?.value));
        if (mg >= 100) { toast('Margem deve ser menor que 100%.', 'aviso'); _salvarCfgDebounced(); return; }
        const pf = precificarPorMargem(custoEf, mg);
        preco = _safeNum(pf?.preco);
        lucro = _safeNum(pf?.lucro);
        marR  = _safeNum(pf?.margemReal);
        mkImp = _safeNum(pf?.markupImplicito);
        _cfg.margem = mg;
    } else {
        return;
    }

    // ── Breakdown de custos ──────────────────────────────────────
    const bdEl = document.getElementById('ft-breakdown');
    if (bdEl) {
        const ovhVal = custoIng * (ovh / 100);
        bdEl.innerHTML = `
            <div class="ft-bd-row">
                <span>Ingredientes</span><span>${formatCurrency(custoIng)}</span>
            </div>
            ${ovh > 0 ? `<div class="ft-bd-row">
                <span>Overhead (${ovh}%)</span><span>+${formatCurrency(_safeNum(ovhVal))}</span>
            </div>` : ''}
            ${mdo > 0 ? `<div class="ft-bd-row">
                <span>Mão de obra</span><span>+${formatCurrency(mdo)}</span>
            </div>` : ''}
            <div class="ft-bd-row ft-bd-total">
                <span>Custo efetivo</span><span>${formatCurrency(custoEf)}</span>
            </div>`;
    }

    // ── Cards de resultado ───────────────────────────────────────
    const cards = document.getElementById('ft-res-cards');
    if (cards) cards.innerHTML = `
        <div class="ft-rcard ft-rcard-preco">
            <div class="ft-rcard-lbl">Preço sugerido</div>
            <div class="ft-rcard-val">${formatCurrency(preco)}</div>
        </div>
        <div class="ft-rcard ft-rcard-lucro">
            <div class="ft-rcard-lbl">Lucro</div>
            <div class="ft-rcard-val">${formatCurrency(lucro)}</div>
        </div>
        <div class="ft-rcard">
            <div class="ft-rcard-lbl">Margem real</div>
            <div class="ft-rcard-val">${formatPercent(marR)}</div>
        </div>
        <div class="ft-rcard">
            <div class="ft-rcard-lbl">Markup impl.</div>
            <div class="ft-rcard-val">${formatPercent(mkImp)}</div>
        </div>`;

    // ── Por porção ───────────────────────────────────────────────
    const porcInput = document.getElementById('ft-porcoes');
    const tamPadr   = _safeNum(PORCOES_PADRAO?.[rec.tamanho]) || 8;
    const porcoes   = _safeNum(parseNum(porcInput?.value)) || tamPadr;
    _cfg.porcoes    = _safeNum(parseNum(porcInput?.value)) || 0;
    const custoPrc  = _safeNum(calcCustoPorcao(custoEf, porcoes));
    const precoPrc  = _safeNum(calcCustoPorcao(preco,   porcoes));
    const pvEl      = document.getElementById('ft-porcao-val');
    if (pvEl) pvEl.innerHTML = `
        <div class="ft-porcao-card">
            <div class="ft-porcao-n">${porcoes} fatias</div>
            <div class="ft-porcao-custo">Custo/fatia <strong>${formatCurrency(custoPrc)}</strong></div>
            <div class="ft-porcao-preco">Preço/fatia <strong>${formatCurrency(precoPrc)}</strong></div>
        </div>`;
    if (porcInput && !porcInput.value) porcInput.placeholder = `${tamPadr} (padrão ${rec.tamanho})`;

    // ── Composição de ingredientes ───────────────────────────────
    const comp = document.getElementById('ft-sim-comp');
    if (comp) {
        const ings = Array.isArray(rec.ingredientes) ? rec.ingredientes : [];
        comp.innerHTML = ings.length
            ? ings.map(ing => {
                if (!ing || typeof ing !== 'object') return '';
                const custoIng_ = _safeNum(ing.custo);
                const pct = custoIng > 0 ? (custoIng_ / custoIng * 100).toFixed(1) : 0;
                return `<div class="ft-comp-row">
                    <span class="ft-comp-nome">${esc(ing.nome || '')}</span>
                    <span class="ft-comp-qtd">${formatQtdUnid(ing.quantidade, ing.unidade)}</span>
                    <span class="ft-comp-bar-wrap"><span class="ft-comp-bar" style="width:${Math.min(pct,100)}%"></span></span>
                    <span class="ft-comp-cost">${formatCurrency(custoIng_)}</span>
                    <span class="ft-comp-pct">${pct}%</span>
                </div>`;
            }).join('')
            : `<div class="ft-sim-empty" style="padding:12px 0">Sem ingredientes.</div>`;
    }

    _salvarCfgDebounced();
}

// ── Comparação de receitas ────────────────────────────────────────
function _renderComparar(recs) {
    if (!recs.length) return `<div class="ft-sim-empty">${ico.warn}<span>Nenhuma receita ativa.</span></div>`;
    const opts = recs.map(r => `<option value="${r.id}">${esc(r.nome)} (${esc(r.tamanho)})</option>`).join('');
    return `
        <div class="ft-cmp-setup">
            <div class="ft-tip-banner">${ico.compare}
                <span>Selecione até 4 receitas para comparar lado a lado com o mesmo markup.</span>
            </div>
            <div class="ft-field-row ft-cmp-mk-row">
                <div class="ft-field">
                    <label for="ft-cmp-mk">Markup para comparação</label>
                    <div class="ft-input-suf-wrap">
                        <input id="ft-cmp-mk" class="ft-input has-suf" type="text"
                            value="${n2input(_cfg.markup)}" inputmode="decimal" autocomplete="off">
                        <span class="ft-input-suf">%</span>
                    </div>
                </div>
            </div>
            <select id="ft-cmp-sel" class="ft-input ft-select" multiple size="4">
                ${opts}
            </select>
            <button class="ft-btn ft-btn-primary" id="ft-cmp-btn" style="margin-top:10px">
                <span class="ft-bico">${ico.compare}</span><span>Comparar</span>
            </button>
        </div>
        <div id="ft-cmp-result"></div>`;
}

function _renderComparacaoLive() {
    try {
        const div = document.getElementById('ft-cmp-content');
        if (!div) return;
        const recs = getReceitasAtivas();
        div.innerHTML = _renderComparar(recs);

        const cmpMkEl = document.getElementById('ft-cmp-mk');
        if (cmpMkEl) applyMaskDecimalConfig(cmpMkEl);

        document.getElementById('ft-cmp-btn')?.addEventListener('click', () => {
            try {
                const sel   = document.getElementById('ft-cmp-sel');
                const mk    = _safeNum(parseNum(document.getElementById('ft-cmp-mk')?.value)) || _cfg.markup || 200;
                const ids   = sel ? [...sel.selectedOptions].map(o => o.value) : [];
                if (!ids.length) { toast('Selecione ao menos uma receita.', 'aviso'); return; }
                if (ids.length > 4) { toast('Máximo 4 receitas para comparar.', 'aviso'); return; }

                const ovh = _safeNum(parseNum(document.getElementById('ft-ovh')?.value));
                const mdo = _safeNum(parseNum(document.getElementById('ft-mdo')?.value));

                const resultEl = document.getElementById('ft-cmp-result');
                if (!resultEl) return;

                resultEl.innerHTML = `<div class="ft-cmp-grid">
                    ${ids.map(id => {
                        const r = recs.find(x => x.id === id);
                        if (!r) return '';

                        // Usa engine para custo efetivo no comparador (com fallback)
                        const engineRes = calcularComEngine({
                            nome:         r.nome        || '',
                            ingredientes: Array.isArray(r.ingredientes) ? r.ingredientes : [],
                            custo_total:  _safeNum(r.custo_total),
                            overhead_pct: ovh,
                            mao_de_obra:  mdo,
                            custo_fixo:   0,
                            porcoes:      1,
                        });

                        // Fallback hard se engine retornar inválido
                        const custoIngRef = _safeNum(r.custo_total);
                        const custoEf = _safeNum(engineRes?.custo_total) >= 0 && isFinite(_safeNum(engineRes?.custo_total))
                            ? _safeNum(engineRes.custo_total)
                            : calcCustoEfetivo(custoIngRef, ovh, mdo);

                        const preco  = _safeNum(calcPrecoMarkup(custoEf, mk));
                        const lucro  = _safeNum(calcLucro(preco, custoEf));
                        const marg   = _safeNum(calcMargemReal(preco, custoEf));

                        return `
                        <div class="ft-cmp-card">
                            <div class="ft-cmp-card-title">${esc(r.nome || '')} <span class="ft-tam-pill">${r.tamanho || ''}</span></div>
                            <div class="ft-cmp-row-data"><span>Custo</span><strong>${formatCurrency(custoEf)}</strong></div>
                            <div class="ft-cmp-row-data ft-cmp-preco"><span>Preço</span><strong>${formatCurrency(preco)}</strong></div>
                            <div class="ft-cmp-row-data"><span>Lucro</span><strong class="green">${formatCurrency(lucro)}</strong></div>
                            <div class="ft-cmp-row-data"><span>Margem</span><strong>${formatPercent(marg)}</strong></div>
                        </div>`;
                    }).join('')}
                </div>`;
            } catch (e) {
                console.error(`[${MOD}] comparar click erro:`, e);
            }
        });
    } catch (e) {
        console.error(`[${MOD}] _renderComparacaoLive erro:`, e);
    }
}
