// WebMCP: tools that in-browser AI agents can call on this page. Public information and plain navigation only.
(function () {
  var mc = navigator.modelContext;
  if (!mc || typeof mc.registerTool !== 'function') return;
  var PAGES = { portal: '/', results: '/club.html', join: '/join.html', raceday: '/live.html', about: '/about.html', contact: '/contact.html', terms: '/terms.html', privacy: '/privacy.html' };
  var text = function (t) { return { content: [{ type: 'text', text: t }] }; };
  function reg(tool) { try { mc.registerTool(tool); } catch (e) { /* already registered or unsupported */ } }
  reg({
    name: 'get_club_info',
    description: 'Short description of Team CRYO-GEN, a friendly Zwift cycling club, and what it races.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: function () { return Promise.resolve(text('Team CRYO-GEN is a friendly Zwift cycling club. Members race the Zwift Racing League (ZRL), weekly team time trials, a club Ladder and a DIRT series, and ride together on weekly social rides. Contact: support@club.cryogen.team')); }
  });
  reg({
    name: 'open_page',
    description: 'Go to a public page of this site: portal, results, join, raceday, about, contact, terms or privacy.',
    inputSchema: { type: 'object', properties: { page: { type: 'string', enum: Object.keys(PAGES), description: 'Which page to open' } }, required: ['page'], additionalProperties: false },
    execute: function (args) {
      var path = PAGES[args && args.page];
      if (!path) return Promise.resolve(text('Unknown page.'));
      location.assign(path);
      return Promise.resolve(text('Opening ' + path));
    }
  });
})();
