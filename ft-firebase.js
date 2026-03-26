// ft-firebase.js — StockFlow Pro v10.2
// ══════════════════════════════════════════════════════════════════
// Re-exporta tudo do módulo Firebase unificado.
// A Ficha Técnica usa este alias para compatibilidade com imports
// existentes em ft-app.js, ft-ingredientes.js, ft-receitas.js,
// ft-gastos.js, ft-preparo.js, ft-negocio.js, ft-tamanhos.js,
// ft-exportacao.js e outros módulos da Ficha Técnica.
//
// v10.2 — Sem alteração de API. Todas as correções de breaking changes
//         (remoção de throws, safe-fail em fbSave/fbLoad/fbDelete,
//         _colRef retornando null) estão em firebase.js v10.2.
//         Este alias recebe automaticamente todas as correções.
// ══════════════════════════════════════════════════════════════════
export * from './firebase.js';
