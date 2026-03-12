// ==UserScript==
// @name         WhatsApp Group ID Finder
// @namespace    https://github.com/danpeguine
// @version      3.0.0
// @description  Shows WhatsApp group IDs inline below group names in the sidebar. Click to copy.
// @author       Dan Peguine
// @match        https://web.whatsapp.com/*
// @grant        none
// @run-at       document-idle
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';

  const LOG_PREFIX = '[WA Group ID Finder]';
  const STYLE_ID = 'wa-group-id-styles';
  const ATTR_INJECTED = 'data-group-id-injected';
  const DEBOUNCE_MS = 500;

  function log(...args) { console.log(LOG_PREFIX, ...args); }
  function warn(...args) { console.warn(LOG_PREFIX, ...args); }

  // ── Styles ───────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .wa-group-id {
        display: block;
        font-size: 11px;
        color: #8696a0;
        cursor: pointer;
        line-height: 1.3;
        margin-top: 1px;
        user-select: none;
        transition: color 0.15s;
        font-family: monospace;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wa-group-id:hover {
        color: #00a884;
      }
      .wa-group-id.copied {
        color: #00a884;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Group ID storage ──────────────────────────────────────────────────
  let groupIdMap = new Map(); // name -> groupId

  // ── Strategy 1: Access WhatsApp's internal Store via webpack cache ────
  // Instead of pushing fake chunks or loading all modules, we safely
  // inspect only already-cached modules for the Chat model store.
  function findWAStore() {
    try {
      const chunkName = Object.keys(window).find(k => k.startsWith('webpackChunk'));
      if (!chunkName) {
        log('No webpack chunk found');
        return false;
      }

      let requireFn = null;
      const origPush = window[chunkName].push.bind(window[chunkName]);

      // Temporarily intercept push to get the require function
      // This is safer than pushing a fake chunk entry
      try {
        window[chunkName].push([
          ['wa-group-id-finder'],
          {},
          (e) => { requireFn = e; },
        ]);
      } catch (e) {
        log('Could not get webpack require:', e.message);
        return false;
      }

      if (!requireFn || !requireFn.c) {
        log('No webpack cache available');
        return false;
      }

      // Only iterate the MODULE CACHE (already loaded modules)
      // This avoids side effects from loading uninitialized modules
      const cache = requireFn.c;
      const cacheKeys = Object.keys(cache);
      log(`Scanning ${cacheKeys.length} cached webpack modules`);

      let found = 0;

      for (const id of cacheKeys) {
        try {
          const mod = cache[id];
          if (!mod || !mod.exports) continue;
          const exports = mod.exports;

          // Look for chat store patterns
          const targets = [
            exports,
            exports.default,
            exports.ChatStore,
            exports.Chat,
          ];

          for (const target of targets) {
            if (!target) continue;
            found += extractFromStore(target);
            if (found > 0) break;
          }

          if (found > 0) break;
        } catch (e) {
          // Skip inaccessible modules
        }
      }

      if (found === 0) {
        // Broader scan: look for any object with getModelsArray that contains @g.us IDs
        for (const id of cacheKeys) {
          try {
            const mod = cache[id];
            if (!mod || !mod.exports) continue;

            // Check all exported properties
            const allExports = [mod.exports, mod.exports.default];
            for (const exp of allExports) {
              if (!exp || typeof exp !== 'object') continue;
              for (const key of Object.keys(exp)) {
                try {
                  const val = exp[key];
                  if (val && typeof val === 'object') {
                    found += extractFromStore(val);
                    if (found > 0) break;
                  }
                } catch (e) {}
              }
              if (found > 0) break;
            }
            if (found > 0) break;
          } catch (e) {}
        }
      }

      if (found > 0) {
        log(`Webpack cache: found ${found} groups`);
        return true;
      }

      log('Webpack cache: no groups found');
      return false;
    } catch (e) {
      warn('Webpack approach failed:', e.message);
      return false;
    }
  }

  function extractFromStore(target) {
    let found = 0;

    // Try getModelsArray()
    if (typeof target.getModelsArray === 'function') {
      try {
        const models = target.getModelsArray();
        if (Array.isArray(models)) {
          for (const chat of models) {
            if (addGroupFromChat(chat)) found++;
          }
        }
      } catch (e) {}
    }

    // Try getAll()
    if (found === 0 && typeof target.getAll === 'function') {
      try {
        const items = target.getAll();
        if (Array.isArray(items)) {
          for (const chat of items) {
            if (addGroupFromChat(chat)) found++;
          }
        }
      } catch (e) {}
    }

    // Try forEach
    if (found === 0 && typeof target.forEach === 'function') {
      try {
        target.forEach((chat) => {
          if (addGroupFromChat(chat)) found++;
        });
      } catch (e) {}
    }

    // Try _models array
    if (found === 0 && Array.isArray(target._models)) {
      for (const chat of target._models) {
        if (addGroupFromChat(chat)) found++;
      }
    }

    // Try models array
    if (found === 0 && Array.isArray(target.models)) {
      for (const chat of target.models) {
        if (addGroupFromChat(chat)) found++;
      }
    }

    return found;
  }

  function addGroupFromChat(chat) {
    if (!chat) return false;
    const id = getGroupJid(chat);
    if (!id) return false;

    const name =
      chat.name ||
      chat.formattedTitle ||
      chat.subject ||
      chat.title ||
      chat.displayName ||
      chat.contact?.name ||
      chat.contact?.pushname ||
      chat.groupMetadata?.subject;

    if (name) {
      groupIdMap.set(name.trim(), id);
      return true;
    }
    return false;
  }

  function getGroupJid(obj) {
    if (!obj) return null;
    // Check various ID formats
    const id = obj.id;
    if (typeof id === 'string' && id.endsWith('@g.us')) return id;
    if (id && id._serialized && id._serialized.endsWith('@g.us')) return id._serialized;
    if (id && id.user && id.server === 'g.us') return `${id.user}@g.us`;
    if (obj.jid && typeof obj.jid === 'string' && obj.jid.endsWith('@g.us')) return obj.jid;
    return null;
  }

  // ── Strategy 2: IndexedDB ──────────────────────────────────────────────
  function loadGroupIdsFromIDB() {
    return new Promise((resolve) => {
      // List all databases and find WhatsApp's
      if (indexedDB.databases) {
        indexedDB.databases().then((dbs) => {
          log('Available IndexedDB databases:', dbs.map(d => d.name));
          const waDBs = dbs.filter(d =>
            d.name && (
              d.name.includes('model') ||
              d.name.includes('wawc') ||
              d.name.includes('whatsapp') ||
              d.name.includes('wa_') ||
              d.name.includes('signal')
            )
          );
          if (waDBs.length > 0) {
            scanDatabases(waDBs.map(d => d.name), resolve);
          } else {
            // Try known names as fallback
            scanDatabases(['model-storage', 'wawc', 'wawc_db_enc'], resolve);
          }
        }).catch(() => {
          scanDatabases(['model-storage', 'wawc', 'wawc_db_enc'], resolve);
        });
      } else {
        scanDatabases(['model-storage', 'wawc', 'wawc_db_enc'], resolve);
      }
    });
  }

  function scanDatabases(dbNames, resolve) {
    let remaining = dbNames.length;
    if (remaining === 0) { resolve(false); return; }
    let resolved = false;

    for (const dbName of dbNames) {
      const req = indexedDB.open(dbName);
      req.onerror = () => {
        remaining--;
        if (remaining <= 0 && !resolved) { resolved = true; resolve(groupIdMap.size > 0); }
      };
      req.onsuccess = (event) => {
        if (resolved) return;
        const db = event.target.result;
        const storeNames = Array.from(db.objectStoreNames);
        log(`IDB "${dbName}" stores:`, storeNames);

        // Scan all stores for group chat records
        let storePending = storeNames.length;
        if (storePending === 0) {
          db.close();
          remaining--;
          if (remaining <= 0 && !resolved) { resolved = true; resolve(groupIdMap.size > 0); }
          return;
        }

        for (const storeName of storeNames) {
          try {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const getAll = store.getAll();
            getAll.onsuccess = () => {
              const records = getAll.result || [];
              for (const rec of records) {
                extractGroupFromRecord(rec);
              }
              storePending--;
              if (storePending <= 0 || (groupIdMap.size > 0 && !resolved)) {
                if (!resolved && groupIdMap.size > 0) {
                  resolved = true;
                  log(`IDB "${dbName}": found ${groupIdMap.size} groups`);
                  db.close();
                  resolve(true);
                } else if (storePending <= 0) {
                  db.close();
                  remaining--;
                  if (remaining <= 0 && !resolved) {
                    resolved = true;
                    resolve(groupIdMap.size > 0);
                  }
                }
              }
            };
            getAll.onerror = () => {
              storePending--;
              if (storePending <= 0) {
                db.close();
                remaining--;
                if (remaining <= 0 && !resolved) { resolved = true; resolve(groupIdMap.size > 0); }
              }
            };
          } catch (e) {
            storePending--;
            if (storePending <= 0) {
              db.close();
              remaining--;
              if (remaining <= 0 && !resolved) { resolved = true; resolve(groupIdMap.size > 0); }
            }
          }
        }
      };
    }

    // Safety timeout
    setTimeout(() => {
      if (!resolved) { resolved = true; resolve(groupIdMap.size > 0); }
    }, 8000);
  }

  function extractGroupFromRecord(rec) {
    if (!rec) return;
    const candidates = [rec, rec.value, rec.data, rec.chat];
    for (const obj of candidates) {
      if (!obj || typeof obj !== 'object') continue;
      const id = getGroupJid(obj);
      if (id) {
        const name =
          obj.name || obj.subject || obj.formattedTitle ||
          obj.title || obj.displayName ||
          obj.contact?.name || obj.groupMetadata?.subject;
        if (name) {
          groupIdMap.set(name.trim(), id);
        }
      }
    }
  }

  // ── Strategy 3: React fiber traversal ─────────────────────────────────
  function getGroupIdFromFiber(element) {
    try {
      const fiberKey = Object.keys(element).find(k =>
        k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey) return null;

      let fiber = element[fiberKey];
      let depth = 0;
      while (fiber && depth < 25) {
        const id = extractIdFromFiber(fiber);
        if (id) return id;
        fiber = fiber.return;
        depth++;
      }
    } catch (e) {}
    return null;
  }

  function extractIdFromFiber(fiber) {
    if (!fiber) return null;

    // Check props
    for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
      if (!props || typeof props !== 'object') continue;
      const id = searchPropsForGroupId(props, 3);
      if (id) return id;
    }

    // Check memoizedState (hooks chain)
    let state = fiber.memoizedState;
    let hookDepth = 0;
    while (state && hookDepth < 8) {
      if (state.memoizedState && typeof state.memoizedState === 'object') {
        const id = searchPropsForGroupId(state.memoizedState, 2);
        if (id) return id;
      }
      state = state.next;
      hookDepth++;
    }

    return null;
  }

  function searchPropsForGroupId(obj, maxDepth) {
    if (!obj || maxDepth <= 0) return null;
    if (typeof obj === 'string') {
      return obj.endsWith('@g.us') ? obj : null;
    }
    if (typeof obj !== 'object') return null;

    // Check direct serialized IDs
    if (obj._serialized && typeof obj._serialized === 'string' && obj._serialized.endsWith('@g.us')) {
      return obj._serialized;
    }

    // Check known fields first (fast path)
    const quickFields = ['chatId', 'id', 'jid', 'conversationId', 'groupId'];
    for (const f of quickFields) {
      const val = obj[f];
      if (typeof val === 'string' && val.endsWith('@g.us')) return val;
      if (val && val._serialized && val._serialized.endsWith('@g.us')) return val._serialized;
      if (val && val.user && val.server === 'g.us') return `${val.user}@g.us`;
    }

    // Check nested objects (chat, data, contact, item)
    const nestedFields = ['chat', 'data', 'contact', 'item', 'row'];
    for (const f of nestedFields) {
      if (obj[f] && typeof obj[f] === 'object') {
        const id = searchPropsForGroupId(obj[f], maxDepth - 1);
        if (id) return id;
      }
    }

    // Broad search at reduced depth
    if (maxDepth > 1) {
      for (const key of Object.keys(obj)) {
        if (quickFields.includes(key) || nestedFields.includes(key)) continue;
        try {
          const val = obj[key];
          if (typeof val === 'string' && val.endsWith('@g.us')) return val;
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            const id = searchPropsForGroupId(val, maxDepth - 2);
            if (id) return id;
          }
        } catch (e) {}
      }
    }

    return null;
  }

  // ── Strategy 4: React props key (alternative fiber access) ────────────
  function getGroupIdFromReactProps(element) {
    try {
      const propsKey = Object.keys(element).find(k => k.startsWith('__reactProps$'));
      if (!propsKey) return null;
      const props = element[propsKey];
      return searchPropsForGroupId(props, 3);
    } catch (e) {}
    return null;
  }

  // ── Clipboard ─────────────────────────────────────────────────────────
  function copyToClipboard(text, element) {
    navigator.clipboard.writeText(text).then(() => {
      showCopied(element, text);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showCopied(element, text);
    });
  }

  function showCopied(element, originalText) {
    element.textContent = 'Copied!';
    element.classList.add('copied');
    setTimeout(() => {
      element.textContent = originalText;
      element.classList.remove('copied');
    }, 1200);
  }

  // ── DOM injection ─────────────────────────────────────────────────────
  function createIdElement(groupId) {
    const span = document.createElement('span');
    span.className = 'wa-group-id';
    span.textContent = groupId;
    span.title = 'Click to copy group ID';
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      copyToClipboard(groupId, span);
    });
    return span;
  }

  function getChatTitle(row) {
    const selectors = [
      '[data-testid="cell-frame-title"] span[title]',
      'span[data-testid="conversation-info-header-chat-title"]',
      'span[title][dir]',
    ];
    for (const sel of selectors) {
      const el = row.querySelector(sel);
      if (el) {
        return (el.getAttribute('title') || el.textContent)?.trim();
      }
    }
    return null;
  }

  function injectGroupIds() {
    const chatRows = document.querySelectorAll(
      '[role="listitem"], [data-testid="cell-frame-container"], [role="row"]'
    );

    let injected = 0;

    for (const row of chatRows) {
      if (row.getAttribute(ATTR_INJECTED)) continue;

      let groupId = null;

      // Strategy A: Name lookup from pre-loaded map
      if (groupIdMap.size > 0) {
        const title = getChatTitle(row);
        if (title && groupIdMap.has(title)) {
          groupId = groupIdMap.get(title);
        }
      }

      // Strategy B: React fiber traversal on the row itself
      if (!groupId) {
        groupId = getGroupIdFromFiber(row);
      }

      // Strategy C: React props on the row
      if (!groupId) {
        groupId = getGroupIdFromReactProps(row);
      }

      // Strategy D: Walk parent elements for fiber data
      if (!groupId) {
        let el = row.parentElement;
        for (let i = 0; i < 3 && el; i++) {
          groupId = getGroupIdFromFiber(el);
          if (groupId) break;
          groupId = getGroupIdFromReactProps(el);
          if (groupId) break;
          el = el.parentElement;
        }
      }

      // Strategy E: Check child elements with fiber data
      if (!groupId) {
        const children = row.querySelectorAll('div[class]');
        for (const child of children) {
          groupId = getGroupIdFromFiber(child);
          if (groupId) break;
          groupId = getGroupIdFromReactProps(child);
          if (groupId) break;
        }
      }

      if (!groupId) {
        // Only mark as skip if we have map data loaded (otherwise we might be too early)
        if (groupIdMap.size > 0) {
          row.setAttribute(ATTR_INJECTED, 'skip');
        }
        continue;
      }

      // Find injection point
      const titleContainer =
        row.querySelector('[data-testid="cell-frame-title"]') ||
        row.querySelector('span[title][dir]')?.closest('div');

      if (titleContainer && !titleContainer.querySelector('.wa-group-id')) {
        titleContainer.appendChild(createIdElement(groupId));
        row.setAttribute(ATTR_INJECTED, groupId);
        injected++;
      }
    }

    if (injected > 0) {
      log(`Injected ${injected} group IDs`);
    }
  }

  // ── Observer ──────────────────────────────────────────────────────────
  let debounceTimer = null;
  function debouncedInject() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(injectGroupIds, DEBOUNCE_MS);
  }

  function observeSidebar() {
    const pane =
      document.getElementById('pane-side') ||
      document.querySelector('[data-testid="chat-list"]') ||
      document.querySelector('[role="grid"]') ||
      document.querySelector('[aria-label*="Chat list"]') ||
      document.querySelector('[aria-label*="chat list"]');

    if (!pane) return false;

    log('Sidebar found, attaching observer');

    const observer = new MutationObserver((mutations) => {
      const hasNew = mutations.some(m => m.type === 'childList' && m.addedNodes.length > 0);
      if (hasNew) debouncedInject();
    });

    observer.observe(pane, { childList: true, subtree: true });
    return true;
  }

  // ── Startup ───────────────────────────────────────────────────────────
  async function start() {
    log('Starting v3.0.0');
    injectStyles();

    // Wait for WhatsApp to fully load (sidebar appears)
    let sidebarReady = false;
    for (let i = 0; i < 120; i++) {
      if (observeSidebar()) {
        sidebarReady = true;
        break;
      }
      await sleep(500);
    }

    if (!sidebarReady) {
      warn('Sidebar not found after 60s');
      return;
    }

    // Give WhatsApp a moment to initialize its stores
    await sleep(2000);

    log('Loading group IDs...');

    // Try webpack cache first (safest, fastest)
    const storeOk = findWAStore();
    if (storeOk) {
      log(`Store: ${groupIdMap.size} groups loaded`);
    }

    // Also try IndexedDB
    if (groupIdMap.size === 0) {
      const idbOk = await loadGroupIdsFromIDB();
      if (idbOk) {
        log(`IDB: ${groupIdMap.size} groups loaded`);
      }
    }

    if (groupIdMap.size === 0) {
      log('No groups from store/IDB — relying on React fiber traversal');
    } else {
      log(`Group map ready: ${groupIdMap.size} entries`);
    }

    // Initial injection
    injectGroupIds();

    // Periodic re-injection for dynamically loaded content
    setInterval(debouncedInject, 3000);

    // Retry loading from store if initial attempt found nothing
    if (groupIdMap.size === 0) {
      let retries = 0;
      const retryInterval = setInterval(async () => {
        retries++;
        if (findWAStore() && groupIdMap.size > 0) {
          log(`Retry ${retries}: loaded ${groupIdMap.size} groups`);
          injectGroupIds();
          clearInterval(retryInterval);
          return;
        }
        if (retries >= 10) {
          // Last resort: try IDB again
          await loadGroupIdsFromIDB();
          if (groupIdMap.size > 0) {
            log(`IDB retry: loaded ${groupIdMap.size} groups`);
            injectGroupIds();
          } else {
            log('All retries exhausted — fiber-only mode');
          }
          clearInterval(retryInterval);
        }
      }, 5000);
    }

    log('Active');
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  start();
})();
