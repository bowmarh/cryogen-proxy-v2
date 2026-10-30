'use strict';
// What the automation changed, with a way back. Each automatic step (placing riders, picking a line-up, importing a result) records a short
// summary and the commands that put the data back as it was; staff can undo a step once from the This week page. Only plain data commands on
// the club's own keys are accepted, so the log can never be used to run anything else.
module.exports = function createAutoLog({ redis, HttpError, requireRole }) {
  const KEY = 'cg:auto:log', MAX = 60;
  const allowed = c => Array.isArray(c) && ['HSET', 'HDEL', 'SET', 'DEL'].includes(c[0]) && typeof c[1] === 'string' && c[1].startsWith('cg:') && c.every(x => typeof x === 'string');

  async function record({ series, by = 'automatic', summary, undo }) {
    const cmds = (undo || []).filter(allowed);
    if (!cmds.length) return null;
    const entry = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ts: new Date().toISOString(), series, by, summary: String(summary || '').slice(0, 240), undo: cmds, undone: false };
    await redis([['LPUSH', KEY, JSON.stringify(entry)], ['LTRIM', KEY, 0, MAX - 1]]);
    return entry.id;
  }
  const list = async () => ((await redis([['LRANGE', KEY, 0, MAX - 1]]))[0] || []).map(v => { try { return JSON.parse(v); } catch (e) { return null; } }).filter(Boolean);

  const routes = {
    'GET /api/auto': async req => {
      requireRole(req, ['admin', 'mod']);
      return { entries: (await list()).map(({ undo, ...e }) => ({ ...e, steps: undo.length })) };
    },
    // Puts the data back as it was before one automatic step. An entry can be undone once; later changes to the same rider, team or match are overwritten.
    'POST /api/auto/undo': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const entries = await list(), i = entries.findIndex(e => e.id === String(body.id || ''));
      if (i < 0) throw new HttpError(404, 'That entry is no longer in the log.');
      const e = entries[i];
      if (e.undone) throw new HttpError(409, 'That was already undone.');
      if (!e.undo.every(allowed)) throw new HttpError(400, 'That entry cannot be undone.');
      await redis([...e.undo, ['LSET', KEY, i, JSON.stringify({ ...e, undone: true, undoneAt: new Date().toISOString() })]]);
      return { undone: e.id, steps: e.undo.length };
    },
  };
  return { routes, record, list, KEY };
};
