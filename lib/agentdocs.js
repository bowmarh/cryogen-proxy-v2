'use strict';
// What AI agents read: Markdown versions of the public pages, the MCP server card and a small read-only MCP server.
// Public information only. Nothing here touches member data.

const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'support@club.cryogen.team';
const NAME = 'Team CRYO-GEN';
const SUMMARY = 'Team CRYO-GEN is a friendly Zwift cycling club. Members race the Zwift Racing League (ZRL), weekly team time trials (TTT), a club Ladder and a DIRT series, and ride together on weekly social rides.';

// [path, short title, description]
const PAGES = [
  ['/', 'Member portal', 'Sign in, sign up for races and rides'],
  ['/club.html', 'Races and results', 'Public season tables, results and next races'],
  ['/join.html', 'Join Team CRYO-GEN', 'Ask to join the club; a club volunteer replies'],
  ['/live.html', 'Race day board', 'What is racing next and where the teams stand'],
  ['/about.html', 'About the club', 'Who Team CRYO-GEN is and what we do'],
  ['/contact.html', 'Contact', 'How to reach the club'],
  ['/terms.html', 'Terms of use', 'Terms for using this site'],
  ['/privacy.html', 'Privacy', 'What the site collects and how it is used'],
];

function markdownFor(pathname, origin){
  const p = pathname === '/index.html' ? '/' : pathname;
  const page = PAGES.find(x => x[0] === p);
  if (!page) return null;
  const links = PAGES.filter(x => x[0] !== p).map(([u, t, d]) => `- [${t}](${origin}${u}): ${d}`).join('\n');
  return `# ${page[0] === '/' ? NAME + ' member portal' : page[1] + ' | ' + NAME}\n\n${SUMMARY}\n\n${page[2]}.\n\nHuman version: ${origin}${p}\n\n## Other pages\n\n${links}\n\n## Notes\n\n- Rider names and personal details are only shown to signed-in members; public pages show team totals and results.\n- Contact: [${CONTACT_EMAIL}](mailto:${CONTACT_EMAIL})\n`;
}

function serverCard(origin){
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    name: 'club.cryogen.team',
    version: '1.0.0',
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'club.cryogen.team', title: NAME + ' public information', version: '1.0.0' },
    description: 'Read-only public information about Team CRYO-GEN, a Zwift cycling club.',
    documentationUrl: origin + '/llms.txt',
    endpoint: origin + '/api/mcp',
    transport: { type: 'streamable-http', endpoint: origin + '/api/mcp' },
    capabilities: { tools: { listChanged: false } },
    authentication: { required: false },
    contact: { email: CONTACT_EMAIL },
  };
}

const TOOLS = [
  { name: 'get_club_info', description: 'Short description of Team CRYO-GEN and what it races.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_public_pages', description: 'The public pages of the site with a one-line description of each.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_contact', description: 'How to contact the club, and where to ask to join.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

function toolText(name, origin){
  if (name === 'get_club_info') return SUMMARY;
  if (name === 'list_public_pages') return PAGES.map(([u, t, d]) => `${t}: ${origin}${u} (${d})`).join('\n');
  if (name === 'get_contact') return `Email ${CONTACT_EMAIL}. To ask to join, use ${origin}/join.html and a club volunteer will reply.`;
  return null;
}

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// One JSON-RPC message in, one reply out (null for notifications).
function rpc(msg, origin){
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: (msg && msg.id) ?? null, error: { code: -32600, message: 'Invalid request' } };
  if (msg.id === undefined) return null;
  const ok = result => ({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') {
    const asked = msg.params && msg.params.protocolVersion;
    return ok({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'club.cryogen.team', version: '1.0.0' } });
  }
  if (msg.method === 'ping') return ok({});
  if (msg.method === 'tools/list') return ok({ tools: TOOLS });
  if (msg.method === 'tools/call') {
    const text = toolText(msg.params && msg.params.name, origin);
    if (text === null) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool' } };
    return ok({ content: [{ type: 'text', text }] });
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
}

function handleMcp(body, origin){
  if (Array.isArray(body)) { const out = body.map(m => rpc(m, origin)).filter(Boolean); return out.length ? out : null; }
  return rpc(body, origin);
}

module.exports = { CONTACT_EMAIL, NAME, SUMMARY, PAGES, markdownFor, serverCard, handleMcp };
