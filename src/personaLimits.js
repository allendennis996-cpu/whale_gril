'use strict';

// File/storage guard only. Model context and output budgets remain independent.
const MAX_CARD_BYTES = 256 * 1024;
const CARD_LIMIT_LABEL = '256 KB';

module.exports = { MAX_CARD_BYTES, CARD_LIMIT_LABEL };
