/* Shared network configuration for every TradeSphere page.
 *
 * Single source of truth for the Cloudflare Worker proxy and the public
 * CORS-proxy fallback chain. Pages keep their own fetch/timeout logic; they
 * only read these values, so to change the worker URL or add/remove/reorder
 * fallback proxies you edit this file once instead of ~20 pages.
 *
 * Must be loaded with a plain <script src="net-config.js"></script> in <head>
 * before any page script that uses TS_NET.
 */
(function(root){
  var WORKER_URL = 'https://newsyt.justfagame9.workers.dev';

  // Ordered by reliability. Each builder takes the target URL and returns the
  // proxied URL. (thingproxy was dropped - it no longer responds.)
  var PROXIES = [
    { label: 'codetabs',   build: function(u){ return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); } },
    { label: 'corsfix',    build: function(u){ return 'https://proxy.corsfix.com/?' + u; } },
    { label: 'allorigins', build: function(u){ return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } }
  ];

  root.TS_NET = {
    WORKER_URL: WORKER_URL,
    // Worker URL for a given target.
    workerUrl: function(u){ return WORKER_URL + '/?url=' + encodeURIComponent(u); },
    // Fresh array of (u) => proxiedUrl builders (callers may mutate their copy).
    corsProxies: function(){ return PROXIES.map(function(p){ return p.build; }); },
    // Fresh array of { label, build } for pages that show which proxy answered.
    corsProxyEntries: function(){ return PROXIES.map(function(p){ return { label: p.label, build: p.build }; }); }
  };
})(typeof window !== 'undefined' ? window : this);
