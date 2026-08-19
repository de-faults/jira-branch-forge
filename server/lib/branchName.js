import { config } from '../config.js';

const TYPE_MAP = {
  bug: 'bugfix',
  defect: 'bugfix',
  'sub-task': 'feature',
  subtask: 'feature',
  story: 'feature',
  task: 'feature',
  epic: 'epic',
  spike: 'spike',
  improvement: 'feature',
  'new feature': 'feature',
  hotfix: 'hotfix',
};

export function branchType(issueType = '') {
  return TYPE_MAP[String(issueType).toLowerCase()] || 'feature';
}

export function slugify(text = '', maxLen = 60) {
  const s = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= maxLen) return s;
  // Cut on a word boundary so the branch still reads.
  return s.slice(0, maxLen).replace(/-[^-]*$/, '').replace(/-+$/, '');
}

export function buildBranchName({ key, summary, issueType, template = config.branchTemplate }) {
  const name = template
    .replaceAll('{type}', branchType(issueType))
    .replaceAll('{key}', String(key || '').toUpperCase())
    .replaceAll('{slug}', slugify(summary))
    .replaceAll('{summary}', slugify(summary));
  return sanitizeRef(name);
}

/** git check-ref-format rules that actually bite in practice. */
export function sanitizeRef(name) {
  let n = String(name)
    .trim()
    .replace(/[\s~^:?*\[\\]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/@\{/g, '-')
    .replace(/^[-/.]+/, '')
    .replace(/[-/.]+$/, '')
    .replace(/\.lock($|\/)/g, '-lock$1');
  if (!n) throw Object.assign(new Error('branch name is empty'), { statusCode: 400 });
  if (n.length > 200) n = n.slice(0, 200).replace(/[-/.]+$/, '');
  return n;
}

export function isValidRef(name) {
  try {
    return sanitizeRef(name) === name;
  } catch {
    return false;
  }
}
