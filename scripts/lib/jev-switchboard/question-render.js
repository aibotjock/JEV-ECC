/**
 * Render Jev `noul` questions and compact task state for the switchboard.
 *
 * Questions stay within the 60-word budget from docs/JEV-SWITCHBOARD.md
 * (292 skills ~= 12k tokens, well inside Jev's 64k/request budget) and always
 * reference task state fields with backticks (e.g. `objective`). Backticks are
 * stripped from capability-provided text so registry/overlay content cannot
 * forge extra state-field references inside a question.
 */

'use strict';

const MAX_QUESTION_WORDS = 60;
const MAX_STATE_ARRAY_ITEMS = 5;
const MAX_STATE_STRING_CHARS = 400;
const TRUNCATION_MARKER = '...[truncated]';
const STATE_FIELD_REFS = Object.freeze([
  'objective',
  'phase',
  'repoContext',
  'activeCapabilities',
  'explicitRequests',
  'failureSignals',
]);

function cleanText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function takeWords(text, budget) {
  const trimmed = String(text || '').trim();
  if (!trimmed || budget <= 0) return '';
  const words = trimmed.split(/\s+/);
  if (words.length <= budget) return trimmed;
  return words.slice(0, budget).join(' ');
}

function triggerSentence(label, triggers) {
  if (!Array.isArray(triggers)) return '';
  const items = triggers.map(cleanText).filter(Boolean);
  if (items.length === 0) return '';
  return `${label}: ${items.join('; ')}.`;
}

/**
 * Render one capability as a Jev `noul` question.
 * @param {object} capability - registry entry ({id, type, name, description, positiveTriggers, negativeTriggers})
 * @returns {{type: 'noul', instructions: string}}
 */
function renderQuestion(capability) {
  const cap = capability && typeof capability === 'object' ? capability : {};
  const name = cleanText(cap.name) || cleanText(cap.id) || 'capability';
  const type = cleanText(cap.type) || 'capability';
  const refs = STATE_FIELD_REFS.map(field => '`' + field + '`').join(', ');
  const header = `Probability (0-1) that the "${name}" ${type} capability is needed for the current task, considering ${refs} from the task state.`;
  const positive = triggerSentence('Needed when', cap.positiveTriggers);
  const negative = triggerSentence('Not needed when', cap.negativeTriggers);
  const description = cleanText(cap.description);
  const descriptionSentence = description ? `Capability: ${description}.` : '';

  let budget = MAX_QUESTION_WORDS;
  const parts = [];
  for (const segment of [header, positive, negative, descriptionSentence]) {
    if (!segment) continue;
    if (budget < 3) break; // avoid dangling one-word fragments
    const fitted = takeWords(segment, budget);
    if (!fitted) break;
    parts.push(fitted);
    budget -= countWords(fitted);
    if (budget <= 0) break;
  }
  return { type: 'noul', instructions: parts.join(' ') };
}

function compactValue(value) {
  if (value === undefined || value === null) return undefined;
  const type = typeof value;
  if (type === 'string') {
    if (value.trim() === '') return undefined;
    if (value.length > MAX_STATE_STRING_CHARS) {
      return value.slice(0, MAX_STATE_STRING_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
    }
    return value;
  }
  if (type === 'number') return Number.isFinite(value) ? value : undefined;
  if (type === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_STATE_ARRAY_ITEMS).map(compactValue).filter(item => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (type === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const compacted = compactValue(value[key]);
      if (compacted !== undefined) out[key] = compacted;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

/**
 * Compact a task state object into a JSON-ready shape: drop empty fields,
 * cap arrays at 5 items, cap strings at 400 chars, sort object keys so the
 * serialized form is deterministic.
 * @param {object} taskState
 * @returns {object} compact JSON-ready state
 */
function renderState(taskState) {
  const compacted = compactValue(taskState);
  return compacted === undefined ? {} : compacted;
}

module.exports = {
  MAX_QUESTION_WORDS,
  MAX_STATE_ARRAY_ITEMS,
  MAX_STATE_STRING_CHARS,
  STATE_FIELD_REFS,
  renderQuestion,
  renderState,
};
