/* Registre de Poudlard — RP Hogwarts Legacy
 * Site statique sans dépendance. Données : data/db.json (+ images/ ) dans votre dépôt GitHub.
 * - Visiteurs : lecture seule (fichiers publiés par GitHub Pages).
 * - Propriétaire : renseigne un token dans « Réglages » → écriture directe dans le dépôt via l'API GitHub.
 * - Hors ligne / test local : stockage dans le navigateur (localStorage).
 */
(() => {
'use strict';

/* ================= Constantes & utilitaires ================= */
const DATA_PATH = 'data/db.json';
const LS_DB = 'hrp.db.v1';
const LS_CFG = 'hrp.cfg.v1';
const HOUSES = ['Gryffondor', 'Serpentard', 'Poufsouffle', 'Serdaigle'];
const MASTERY = ['Débutant', 'Appris', 'Maîtrisé'];
const DANGERS = ['Inoffensif', 'Faible', 'Modéré', 'Dangereux', 'Mortel'];
const DANGER_CLS = { Inoffensif: 'st-good', Faible: 'st-ally', 'Modéré': 'st-mid', Dangereux: 'st-rival', Mortel: 'st-bad' };
const IMG_OK = /^(images\/[\w.\-]+|data:image\/)/;

const $ = (s, r = document) => r.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const root = document.documentElement;
const isNox = () => root.dataset.theme === 'nox';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** Création de nœuds DOM (aucun innerHTML : pas de risque d'injection). */
function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c);
  return n;
}

/* ================= Configuration & état ================= */
const host = location.hostname;
const isHosted = /^https?:$/.test(location.protocol) && !['localhost', '127.0.0.1', '[::1]'].includes(host);
const guess = (() => {
  if (host.endsWith('.github.io')) {
    const owner = host.split('.')[0];
    return { owner, repo: location.pathname.split('/')[1] || `${owner}.github.io` };
  }
  return { owner: '', repo: '' };
})();
const cfg = { owner: guess.owner, repo: guess.repo, branch: 'main', token: '' };
{ const saved = load(LS_CFG, {}); for (const k of Object.keys(cfg)) if (saved[k]) cfg[k] = saved[k]; }

let db = normalize(null);
let remoteSha = null;
let rev = 0;                 // incrémenté à chaque modification
let sync = 'synced';         // synced | pending | saving | error
let writable = true;         // false si la lecture via l'API a échoué (évite d'écraser des données)
let ui = { tab: 'sorts', q: '', qb: '', focus: null };
const imgCache = new Map();  // chemin → blob: URL (images tout juste envoyées)

const hasToken = () => !!(cfg.token && cfg.owner && cfg.repo);
const canEdit = () => writable && (hasToken() || !isHosted);

function normalize(x) {
  const out = { version: 1, profiles: [], bestiaire: [], deleted: {} };
  if (!x || !Array.isArray(x.profiles)) return out;
  if (x.deleted && typeof x.deleted === 'object') out.deleted = x.deleted;
  const arr = v => (Array.isArray(v) ? v.filter(i => i && typeof i === 'object') : []);
  out.profiles = x.profiles.filter(p => p && typeof p === 'object').map(p => ({
    id: String(p.id || uid()).replace(/[^\w-]/g, ''),
    prenom: String(p.prenom || ''), nom: String(p.nom || ''),
    maison: HOUSES.includes(p.maison) ? p.maison : '',
    annee: String(p.annee || ''), description: String(p.description || ''),
    image: IMG_OK.test(p.image || '') ? p.image : '',
    updated: +p.updated || 0,
    sorts: arr(p.sorts), cours: arr(p.cours), potions: arr(p.potions), relations: arr(p.relations),
  }));
  const t = v => String(v || '');
  out.bestiaire = arr(x.bestiaire).map(b => ({
    id: String(b.id || uid()).replace(/[^\w-]/g, ''),
    nom: t(b.nom), espece: t(b.espece), danger: DANGERS.includes(b.danger) ? b.danger : '',
    habitat: t(b.habitat), description: t(b.description), comportement: t(b.comportement),
    faiblesses: t(b.faiblesses), butin: t(b.butin),
    image: IMG_OK.test(b.image || '') ? b.image : '', updated: +b.updated || 0,
  }));
  return out;
}

/* ================= API GitHub ================= */
const API = () => `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/`;
const headers = accept => ({
  Accept: accept || 'application/vnd.github+json',
  Authorization: 'Bearer ' + cfg.token,
});
const explain = (s, m) => ({
  401: 'Token invalide ou expiré.',
  403: 'Accès refusé (droits du token insuffisants, ou limite de requêtes atteinte).',
  404: 'Introuvable : vérifiez le compte, le dépôt, la branche et l’accès du token à ce dépôt.',
}[s] || (s === 409 || s === 422 ? 'Refusé par GitHub (' + (m || s) + ').' : m || ('Erreur ' + s)));

async function gh(path, opts = {}) {
  if (!/^[\w-]+$/.test(cfg.token)) {
    const e = new Error('Le token contient un caractère invalide (espace, guillemet, « … »). Recopiez-le exactement depuis GitHub.');
    e.status = 0; throw e;
  }
  let res;
  try {
    res = await fetch(path ? API() + path : API().slice(0, -1), {
      ...opts,
      headers: { ...headers(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch {
    // Diagnostic : GitHub est-il joignable sans token ?
    let reach = false;
    try { reach = (await fetch('https://api.github.com/zen', { cache: 'no-store' })).ok; } catch { /* injoignable */ }
    const e = new Error(reach
      ? 'GitHub est joignable, mais la requête avec le token est bloquée avant d’arriver (extension du navigateur ou filtre réseau). Désactivez vos extensions ou testez en navigation privée.'
      : 'Ce navigateur ou ce réseau n’arrive pas à joindre api.github.com (bloqueur de pub, VPN, antivirus, DNS ou réseau filtré, ou hors ligne). Testez en navigation privée, en 4G ou avec un autre navigateur.');
    e.status = 0; throw e;
  }
  if (!res.ok) {
    let m = ''; try { m = (await res.json()).message; } catch { /* ignore */ }
    const e = new Error(explain(res.status, m)); e.status = res.status; throw e;
  }
  return res.status === 204 ? null : res.json();
}
const ref = () => '?ref=' + encodeURIComponent(cfg.branch);

const b64 = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = s => Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0));

/* Toutes les écritures GitHub passent par une file : jamais deux commits en même temps. */
let queue = Promise.resolve();
const enqueue = fn => { const r = queue.then(fn); queue = r.catch(() => {}); return r; };

/* ================= Chargement / sauvegarde ================= */
/** Lit data/db.json via l'API (toujours à jour, contrairement à Pages). */
async function fetchRemote() {
  try {
    // « &t=… » : GitHub autorise le navigateur à garder cette réponse 60 s ; sans ça, le sha serait périmé.
    const f = await gh('contents/' + DATA_PATH + ref() + '&t=' + Date.now());
    const bytes = f.content ? fromB64(f.content) : fromB64((await gh('git/blobs/' + f.sha)).content);
    return { db: normalize(JSON.parse(new TextDecoder().decode(bytes))), sha: f.sha };
  } catch (e) {
    if (e.status === 404) return { db: normalize(null), sha: null };
    throw e;
  }
}

/** Fusionne deux versions : par profil, la plus récente gagne ; les suppressions sont mémorisées. */
function mergeDB(remote, local) {
  const del = { ...remote.deleted, ...local.deleted };
  const mergeList = (a, b) => {
    const map = new Map();
    for (const p of [...a, ...b]) {
      if (del[p.id] && del[p.id] >= (p.updated || 0)) continue;
      const o = map.get(p.id);
      if (!o || (p.updated || 0) > (o.updated || 0)) map.set(p.id, p);
    }
    return [...map.values()];
  };
  return {
    version: 1,
    profiles: mergeList(remote.profiles, local.profiles),
    bestiaire: mergeList(remote.bestiaire, local.bestiaire),
    deleted: del,
  };
}

async function refresh() {
  if (!hasToken() || !writable || sync !== 'synced' || document.querySelector('dialog[open]')) return;
  try {
    const r = await fetchRemote();
    remoteSha = r.sha;
    const merged = mergeDB(r.db, db);
    if (JSON.stringify(merged) !== JSON.stringify(db)) { db = merged; store(LS_DB, db); render(); }
  } catch { /* silencieux */ }
}

async function loadDB() {
  remoteSha = null;
  if (hasToken()) {
    try {
      const r = await fetchRemote();
      db = r.db; remoteSha = r.sha;
      writable = true; setSync('synced'); return;
    } catch (e) {
      writable = false; setSync('error'); toast('GitHub : ' + e.message + ' Modifications désactivées.', 'err');
    }
  }
  if (!isHosted && !hasToken()) {
    const l = load(LS_DB); if (l) { db = normalize(l); return; }
  }
  try {
    const r = await fetch(`${DATA_PATH}?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) { db = normalize(await r.json()); return; }
  } catch { /* hors ligne ou file:// */ }
  const l = load(LS_DB); if (l) db = normalize(l);
}

function commit() {
  rev++;
  if (!store(LS_DB, db)) toast('Stockage du navigateur plein : exportez vos données.', 'err');
  if (hasToken()) scheduleSave();
  render();
}

let saveTimer;
function scheduleSave() {
  setSync('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => enqueue(() => pushDB()), 1200);
}

async function pushDB(retry = true) {
  const myRev = rev;
  setSync('saving');
  try {
    // On relit la version GitHub et on fusionne : les modifications des autres joueurs ne sont pas écrasées.
    const r = await fetchRemote();
    const before = JSON.stringify(db);
    db = mergeDB(r.db, db);
    const changed = JSON.stringify(db) !== before;
    if (JSON.stringify(r.db) !== JSON.stringify(db)) {
      const body = {
        message: 'RP : mise à jour du registre',
        content: b64(new TextEncoder().encode(JSON.stringify(db, null, 1))),
        branch: cfg.branch,
      };
      if (r.sha) body.sha = r.sha;
      const put = await gh('contents/' + DATA_PATH, { method: 'PUT', body: JSON.stringify(body) });
      remoteSha = put.content.sha;
    } else remoteSha = r.sha;
    store(LS_DB, db);
    setSync(rev === myRev ? 'synced' : 'pending');
    if (changed) render();
  } catch (e) {
    if ((e.status === 409 || e.status === 422) && retry) return pushDB(false);
    setSync('error'); toast('Envoi impossible : ' + e.message, 'err');
  }
}

/* ---------- Images ---------- */
async function resizeImage(file) {
  const bmp = await createImageBitmap(file);
  const W = 400, H = 500;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const r = Math.max(W / bmp.width, H / bmp.height), sw = W / r, sh = H / r;
  ctx.fillStyle = '#14161f'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) * 0.3, sw, sh, 0, 0, W, H);
  if (bmp.close) bmp.close();
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('image'))), 'image/jpeg', 0.82));
}
const blobToDataURL = blob => new Promise((res, rej) => {
  const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob);
});

async function uploadImage(id, blob) {
  const path = `images/${id}-${Date.now().toString(36)}.jpg`;
  const content = b64(new Uint8Array(await blob.arrayBuffer()));
  await gh('contents/' + path, { method: 'PUT', body: JSON.stringify({ message: 'RP : image ' + id, content, branch: cfg.branch }) });
  imgCache.set(path, URL.createObjectURL(blob));
  return path;
}
const storeImage = (id, blob) => (hasToken() ? enqueue(() => uploadImage(id, blob)) : blobToDataURL(blob));

function deleteImage(path) {
  if (!hasToken() || !/^images\//.test(path || '')) return;
  enqueue(async () => {
    try {
      const meta = await gh('contents/' + path + ref() + '&t=' + Date.now());
      await gh('contents/' + path, { method: 'DELETE', body: JSON.stringify({ message: 'RP : suppression image', sha: meta.sha, branch: cfg.branch }) });
    } catch { /* image déjà absente : sans gravité */ }
  });
}

async function migrateImages() {
  for (const p of [...db.profiles, ...db.bestiaire]) {
    if (p.image && p.image.startsWith('data:')) {
      const blob = await (await fetch(p.image)).blob();
      p.image = await storeImage(p.id, blob);
    }
  }
}

const imgSrc = path => imgCache.get(path) || path;

async function fallbackImg(img, path, p) {
  try {
    if (hasToken() && /^images\//.test(path)) {
      const res = await fetch(API() + 'contents/' + path + ref(), { headers: headers('application/vnd.github.raw+json') });
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        imgCache.set(path, url); img.src = url; return;
      }
    }
  } catch { /* ignore */ }
  img.replaceWith(placeholder(p, img.className));
}

/* ================= Interface : briques ================= */
const initials = p => ((p.prenom || '?').charAt(0) + (p.nom || '').charAt(0)).toUpperCase();
const fullName = p => `${p.prenom} ${p.nom}`.trim();
const placeholder = (p, cls) => h('div', { class: cls + ' ph', 'aria-hidden': 'true' }, initials(p));

function portrait(p, cls) {
  if (!p.image) return placeholder(p, cls);
  const img = h('img', { class: cls, src: imgSrc(p.image), alt: '', loading: 'lazy', decoding: 'async', width: 400, height: 500 });
  img.addEventListener('error', () => fallbackImg(img, p.image, p), { once: true });
  return img;
}

let toastT;
function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show ' + (kind || '');
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, 4800);
}

const SYNC_TXT = {
  synced: 'GitHub à jour', pending: 'Modifications en attente…',
  saving: 'Envoi vers GitHub…', error: 'Problème GitHub – cliquer',
};
function setSync(s) { sync = s; renderStatus(); }
function renderStatus() {
  const b = $('#status');
  if (hasToken()) { b.textContent = SYNC_TXT[sync]; b.className = 'pill s-' + sync; }
  else if (!isHosted) { b.textContent = 'Mode local (ce navigateur)'; b.className = 'pill s-local'; }
  else { b.textContent = 'Lecture seule'; b.className = 'pill s-ro'; }
  $('#btn-settings').textContent = canEdit() || hasToken() ? 'Réglages' : 'Mode édition';
}

function statusCls(s) {
  const t = norm(s);
  if (/ennem|hostile|haine/.test(t)) return 'st-bad';
  if (/rival/.test(t)) return 'st-rival';
  if (/mitig|neutre|complique|tendu|mefian/.test(t)) return 'st-mid';
  if (/amour|couple|crush|coeur|fianc/.test(t)) return 'st-love';
  if (/famil|frere|soeur|cousin|parent/.test(t)) return 'st-fam';
  if (/mentor|prof|maitre/.test(t)) return 'st-mentor';
  if (/alli/.test(t)) return 'st-ally';
  if (/ami|copain|camarade/.test(t)) return 'st-good';
  return 'st-none';
}

/* ================= Formulaire modal générique ================= */
function openForm({ title, fields, values = {}, onSave, onDelete, submitLabel = 'Enregistrer', intro }) {
  const dlg = h('dialog', { class: 'modal' });
  const form = h('form', { class: 'form', novalidate: false });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const inputs = {};
  form.append(h('h2', {}, title));
  if (intro) form.append(h('p', { class: 'help' }, intro));

  for (const f of fields) {
    if (f.type === 'custom') { form.append(f.node); continue; }
    let input;
    if (f.type === 'textarea') input = h('textarea', { rows: f.rows || 4, maxlength: f.max || 4000 });
    else if (f.type === 'select') input = h('select', {}, f.options.map(o => h('option', { value: o.value }, o.label)));
    else input = h('input', { type: f.type || 'text', maxlength: f.max || 160, list: f.list, autocomplete: 'off' });
    input.name = f.key;
    if (f.required) input.required = true;
    if (f.placeholder) input.placeholder = f.placeholder;
    input.value = values[f.key] ?? '';
    inputs[f.key] = input;
    form.append(h('label', { class: 'field' }, h('span', { class: 'lbl' }, f.label + (f.required ? ' *' : '')), input, f.help && h('span', { class: 'help' }, f.help)));
  }

  const ok = h('button', { class: 'btn', type: 'submit' }, submitLabel);
  const cancel = h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Annuler');
  const actions = h('div', { class: 'actions' });
  if (onDelete) {
    actions.append(h('button', {
      class: 'btn danger left', type: 'button',
      onclick: async () => { if ((await onDelete()) !== false) dlg.close(); },
    }, 'Supprimer'));
  }
  actions.append(cancel, ok);
  form.append(err, actions);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = {};
    for (const f of fields) data[f.key] = f.type === 'custom' ? f.get() : inputs[f.key].value.trim();
    ok.disabled = true; ok.textContent = 'Enregistrement…'; err.textContent = '';
    try {
      const msg = await onSave(data);
      if (msg) { err.textContent = msg; ok.disabled = false; ok.textContent = submitLabel; return; }
      dlg.close();
    } catch (ex) {
      err.textContent = ex.message || 'Erreur'; ok.disabled = false; ok.textContent = submitLabel;
    }
  });

  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('mousedown', e => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function imageField(current) {
  let blob = null, removed = false;
  const prev = h('img', { class: 'img-prev', alt: 'Aperçu du portrait' });
  const setPrev = src => { if (src) { prev.src = src; prev.hidden = false; } else { prev.removeAttribute('src'); prev.hidden = true; } };
  setPrev(current ? imgSrc(current) : '');
  const input = h('input', { type: 'file', accept: 'image/*' });
  input.addEventListener('change', async () => {
    const f = input.files[0]; if (!f) return;
    try { blob = await resizeImage(f); removed = false; setPrev(URL.createObjectURL(blob)); }
    catch { toast('Image illisible (essayez un JPG ou PNG).', 'err'); input.value = ''; }
  });
  const rm = h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { blob = null; removed = true; input.value = ''; setPrev(''); } }, 'Retirer l’image');
  return {
    type: 'custom', key: '__image',
    node: h('div', { class: 'field' },
      h('span', { class: 'lbl' }, 'Portrait'), prev, input,
      h('span', { class: 'help' }, 'Recadrée automatiquement en 4:5 et compressée (~40 Ko).'), rm),
    get: () => ({ blob, removed }),
  };
}

/* ================= Texte enrichi (notes de cours) ================= */
/* La note ne stocke qu'un NOM de couleur (classe c-rouge, m-jaune…) ; la teinte réelle dépend du thème,
   donc un texte rouge reste lisible en mode clair comme en mode Nox.  Valeurs : [clair, Nox]. */
const INK_COLORS = {
  rouge: ['#8e1b22', '#ff9a9a'], vert: ['#1f5a3a', '#7fd39a'], bleu: ['#28487f', '#8db4ff'],
  violet: ['#5d3a8a', '#c9a6ff'], or: ['#8a6310', '#e6c26a'],
};
const MARK_COLORS = {
  jaune: ['#f1d95e', '#6e5c12'], vert: ['#a9d89a', '#2f5a35'], rose: ['#f0a9bd', '#6e2f46'], bleu: ['#a9c9ec', '#2c4a72'],
};
const INK_DEFAULT = ['#2b1d12', '#e9dfc4'];
{
  const css = [];
  for (const [n, [a, b]] of Object.entries(INK_COLORS)) css.push(`.c-${n}{color:${a}}html[data-theme=nox] .c-${n}{color:${b}}`);
  for (const [n, [a, b]] of Object.entries(MARK_COLORS)) css.push(`.m-${n}{background:${a};border-radius:2px;padding:0 .12em}html[data-theme=nox] .m-${n}{background:${b}}`);
  document.head.append(h('style', {}, css.join('')));
}

function hexOf(css) {   // « rgb(1, 2, 3) » ou « #abc » → « #aabbcc »
  const s = String(css || '').trim().toLowerCase();
  let m = s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) return '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('');
  m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) return '#' + (m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]);
  return '';
}
function colorName(pal, css) {
  const hx = hexOf(css);
  if (!hx) return '';
  for (const [name, vals] of Object.entries(pal)) if (vals.includes(hx)) return name;
  return '';
}

/* Nettoyage : on reconstruit un contenu neuf à partir d'une liste blanche. Aucun attribut n'est copié
   (hors classes de la palette) : pas de script, de lien ni d'image possibles, même en cas de collage externe. */
const RICH_DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'HEAD', 'TITLE', 'META', 'LINK']);
const RICH_TAG = {
  P: 'p', DIV: 'p', H1: 'h3', H2: 'h3', H3: 'h3', H4: 'h4', H5: 'h4', H6: 'h4', UL: 'ul', OL: 'ol', LI: 'li',
  BLOCKQUOTE: 'blockquote', B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', S: 's', STRIKE: 's', DEL: 's',
};

function richStyleChain(n, tag) {
  const st = n.style || {};
  const mk = t => document.createElement(t);
  const fromClass = (prefix, pal) => {
    for (const c of n.classList || []) if (c.startsWith(prefix) && Object.hasOwn(pal, c.slice(prefix.length))) return c.slice(prefix.length);
    return '';
  };
  const sc = tag === 'FONT' ? n.getAttribute('color') : st.color;   // un style explicite l'emporte sur la classe
  const ink = sc ? colorName(INK_COLORS, sc) : fromClass('c-', INK_COLORS);
  const mark = st.backgroundColor ? colorName(MARK_COLORS, st.backgroundColor) : (fromClass('m-', MARK_COLORS) || (tag === 'MARK' ? 'jaune' : ''));
  const chain = [];
  if (ink || mark) {
    const s = mk('span');
    s.className = [ink && 'c-' + ink, mark && 'm-' + mark].filter(Boolean).join(' ');
    chain.push(s);
  }
  if (/^(bold|[6-9]00)$/.test(st.fontWeight || '')) chain.push(mk('b'));
  if (st.fontStyle === 'italic') chain.push(mk('i'));
  const deco = st.textDecorationLine || st.textDecoration || '';
  if (deco.includes('underline')) chain.push(mk('u'));
  if (deco.includes('line-through')) chain.push(mk('s'));
  return chain;
}

function cleanNodes(src, out) {
  for (const n of src.childNodes) {
    if (n.nodeType === 3) { out.append(n.nodeValue); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName.toUpperCase();
    if (RICH_DROP.has(tag)) continue;
    if (tag === 'BR' || tag === 'HR') { out.append(document.createElement(tag.toLowerCase())); continue; }
    let chain = [];
    if (RICH_TAG[tag]) chain = [document.createElement(RICH_TAG[tag])];
    else if (tag === 'SPAN' || tag === 'FONT' || tag === 'MARK') chain = richStyleChain(n, tag);
    if (!chain.length) { cleanNodes(n, out); continue; }   // balise inconnue ou sans effet : on garde le texte
    chain.forEach((c, i) => { if (i) chain[i - 1].append(c); });
    cleanNodes(n, chain[chain.length - 1]);
    out.append(chain[0]);
  }
}

const looksHtml = s => /<\/?(p|div|br|hr|b|i|u|s|strong|em|span|ul|ol|li|h[1-6]|blockquote|mark|font)\b/i.test(s);

/** Contenu stocké (HTML nettoyé, ou texte brut des anciennes notes) → fragment prêt à afficher. */
function richFromString(str) {
  const frag = document.createDocumentFragment();
  str = String(str || '');
  if (looksHtml(str)) cleanNodes(new DOMParser().parseFromString(str, 'text/html').body, frag);
  else for (const line of str.split('\n')) if (line.trim()) frag.append(h('p', {}, line));
  return frag;
}
const richView = str => h('div', { class: 'rich' }, richFromString(str));

/** Texte seul (pour la recherche). */
function richText(str) {
  str = String(str || '');
  if (!looksHtml(str)) return str;
  const flat = str.replace(/<\/(p|li|h3|h4|blockquote|div)>|<br\s*\/?>/gi, ' ');
  return new DOMParser().parseFromString(flat, 'text/html').body.textContent;
}

function richSerialize(ed) {
  const box = document.createElement('div');
  cleanNodes(ed, box);
  const empty = n => n && n.nodeType === 1 && /^(P|H3|H4)$/i.test(n.tagName) && !n.textContent.trim() && !n.querySelector('hr');
  while (empty(box.firstChild)) box.firstChild.remove();
  while (empty(box.lastChild)) box.lastChild.remove();
  if (!box.textContent.trim() && !box.querySelector('hr')) return '';
  return box.innerHTML.trim();
}

function richField(initial) {
  const ed = h('div', {
    class: 'rich editor', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true',
    'aria-label': 'Contenu du cours', 'data-ph': 'Écrivez votre cours ici…',
  });
  ed.append(richFromString(initial));
  ed.addEventListener('focus', () => document.execCommand('defaultParagraphSeparator', false, 'p'));
  ed.addEventListener('input', () => { if (!ed.textContent.trim() && !ed.querySelector('hr,li')) ed.replaceChildren(); });
  ed.addEventListener('paste', e => {   // collage : on garde la mise en forme utile, jamais le reste
    e.preventDefault();
    const cd = e.clipboardData;
    if (!cd) return;
    const box = document.createElement('div');
    const html = cd.getData('text/html');
    if (html) cleanNodes(new DOMParser().parseFromString(html, 'text/html').body, box);
    if (box.textContent.trim()) document.execCommand('insertHTML', false, box.innerHTML);
    else document.execCommand('insertText', false, cd.getData('text/plain'));
  });

  const th = isNox() ? 1 : 0;
  const run = (name, val) => { ed.focus(); document.execCommand(name, false, val); };
  const block = tag => {
    ed.focus();
    const cur = String(document.queryCommandValue('formatBlock') || '').replace(/[<>]/g, '').toLowerCase();
    document.execCommand('formatBlock', false, '<' + (cur === tag ? 'p' : tag) + '>');
  };
  const paint = (name, color) => {
    ed.focus();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(name, false, color);
    document.execCommand('styleWithCSS', false, false);
  };
  const btn = (content, title, fn, cls = '', style = '') =>
    h('button', { class: 'rt-btn ' + cls, type: 'button', title, 'aria-label': title, style: style || null, onclick: fn }, content);
  const group = (label, ...kids) => h('div', { class: 'rt-group', role: 'group', 'aria-label': label }, kids);
  const sep = () => h('span', { class: 'rt-sep', 'aria-hidden': 'true' });
  const cap = s => s[0].toUpperCase() + s.slice(1);

  const bar = h('div', { class: 'rt', role: 'toolbar', 'aria-label': 'Mise en forme' },
    group('Style du texte',
      btn(h('b', {}, 'G'), 'Gras (Ctrl+B)', () => run('bold')),
      btn(h('i', {}, 'I'), 'Italique (Ctrl+I)', () => run('italic')),
      btn(h('u', {}, 'S'), 'Souligné (Ctrl+U)', () => run('underline')),
      btn(h('s', {}, 'ab'), 'Barré', () => run('strikeThrough'))),
    sep(),
    group('Titres',
      btn('Titre', 'Titre de section', () => block('h3')),
      btn('Sous-titre', 'Sous-titre', () => block('h4'))),
    sep(),
    group('Blocs',
      btn('• Liste', 'Liste à puces', () => run('insertUnorderedList')),
      btn('1. Liste', 'Liste numérotée', () => run('insertOrderedList')),
      btn('Citation', 'Citation', () => block('blockquote')),
      btn('Ligne', 'Ligne de séparation', () => run('insertHorizontalRule'))),
    sep(),
    group('Couleur du texte',
      h('span', { class: 'rt-label' }, 'Couleur'),
      Object.entries(INK_COLORS).map(([n, c]) => btn('', 'Texte ' + n, () => paint('foreColor', c[th]), 'sw', 'background:' + c[th])),
      btn('A', 'Couleur normale', () => paint('foreColor', INK_DEFAULT[th]), 'rt-reset')),
    sep(),
    group('Surlignage',
      h('span', { class: 'rt-label' }, 'Surligner'),
      Object.entries(MARK_COLORS).map(([n, c]) => btn('', 'Surligner en ' + n, () => paint('hiliteColor', c[th]), 'sw mk', 'background:' + c[th])),
      btn('×', 'Retirer le surlignage', () => paint('hiliteColor', 'transparent'), 'rt-reset')),
    sep(),
    btn('Effacer la mise en forme', 'Effacer toute la mise en forme de la sélection', () => {
      run('removeFormat');
      paint('foreColor', INK_DEFAULT[th]);
      paint('hiliteColor', 'transparent');
      document.execCommand('formatBlock', false, '<p>');
    }));
  bar.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });   // garde la sélection

  return {
    type: 'custom', key: 'texte',
    node: h('div', { class: 'field' },
      h('span', { class: 'lbl' }, 'Contenu du cours'), bar, ed,
      h('span', { class: 'help' }, 'Sélectionnez du texte, puis choisissez une mise en forme. Les couleurs s’adaptent au mode clair et au mode Nox.')),
    get: () => richSerialize(ed),
  };
}

/* ================= Schémas des 4 rubriques ================= */
const SCHEMAS = {
  sorts: {
    label: 'Sortilège', add: 'Ajouter un sortilège', empty: 'Aucun sortilège appris pour l’instant.',
    defaults: { niveau: 'Appris' },
    fields: () => [
      { key: 'nom', label: 'Nom du sortilège', required: true, list: 'dl-sorts', max: 80 },
      { key: 'niveau', label: 'Maîtrise', type: 'select', options: MASTERY.map(m => ({ value: m, label: m })) },
      { key: 'source', label: 'Appris où / auprès de qui', max: 120 },
      { key: 'note', label: 'Notes (effet, incantation, geste…)', type: 'textarea', rows: 3, max: 1500 },
    ],
  },
  cours: {
    label: 'Cours', add: 'Ajouter une note de cours', empty: 'Aucune note de cours.',
    defaults: {},
    fields: (p, item) => [
      { key: 'titre', label: 'Titre', required: true, max: 120 },
      { key: 'matiere', label: 'Matière', list: 'dl-matieres', max: 80 },
      { key: 'date', label: 'Date (RP ou réelle)', max: 40, placeholder: 'ex. 12 septembre 1891' },
      richField(item && item.texte),
    ],
    validate: d => (d.texte.length > 60000 ? 'La note est trop longue : découpez-la en plusieurs cours.' : ''),
  },
  potions: {
    label: 'Potion', add: 'Ajouter une recette', empty: 'Aucune recette de potion.',
    defaults: {},
    fields: () => [
      { key: 'nom', label: 'Nom de la potion', required: true, list: 'dl-potions', max: 100 },
      { key: 'effet', label: 'Effet', max: 200 },
      { key: 'ingredients', label: 'Ingrédients (un par ligne)', type: 'textarea', rows: 5, max: 2000 },
      { key: 'preparation', label: 'Préparation', type: 'textarea', rows: 6, max: 4000 },
    ],
  },
  relations: {
    label: 'Relation', add: 'Ajouter une relation', empty: 'Aucune relation enregistrée.',
    defaults: {},
    fields: p => [
      {
        key: 'profileId', label: 'Lier à un profil existant (optionnel)', type: 'select',
        options: [{ value: '', label: '— Personnage sans profil —' },
          ...db.profiles.filter(x => x.id !== p.id).map(x => ({ value: x.id, label: fullName(x) }))],
      },
      { key: 'prenom', label: 'Prénom', max: 60, help: 'Inutile si un profil est lié.' },
      { key: 'nom', label: 'Nom', max: 60 },
      { key: 'statut', label: 'Statut', required: true, list: 'dl-statuts', max: 50, placeholder: 'ami, ennemi, mitigé…' },
      { key: 'note', label: 'Détails', type: 'textarea', rows: 3, max: 1500 },
    ],
    validate: d => (!d.profileId && !d.prenom && !d.nom ? 'Indiquez un prénom ou un nom, ou liez un profil.' : ''),
  },
};

function editItem(p, kind, item) {
  const s = SCHEMAS[kind];
  openForm({
    title: item ? s.add.replace('Ajouter', 'Modifier') : s.add,
    fields: s.fields(p, item), values: item || s.defaults,
    onSave: data => {
      const e = s.validate && s.validate(data); if (e) return e;
      if (item) Object.assign(item, data); else p[kind].push({ id: uid(), ...data });
      p.updated = Date.now(); commit();
    },
    onDelete: item && (() => {
      if (!confirm('Supprimer cet élément ?')) return false;
      p[kind] = p[kind].filter(x => x !== item); p.updated = Date.now(); commit();
    }),
  });
}

/* ================= Profils : création / édition ================= */
function editProfile(existing) {
  const imgF = imageField(existing && existing.image);
  const fields = [
    { key: 'prenom', label: 'Prénom', required: true, max: 60 },
    { key: 'nom', label: 'Nom', required: true, max: 60 },
    { key: 'maison', label: 'Maison', type: 'select', options: [{ value: '', label: '— Aucune / inconnue —' }, ...HOUSES.map(x => ({ value: x, label: x }))] },
    { key: 'annee', label: 'Année d’étude', type: 'select', options: [{ value: '', label: '—' }, ...[1, 2, 3, 4, 5, 6, 7].map(n => ({ value: String(n), label: n + (n === 1 ? 'ère' : 'e') + ' année' }))] },
    { key: 'description', label: 'Description', type: 'textarea', rows: 6, max: 4000 },
    { key: '__image', ...imgF },
  ];
  openForm({
    title: existing ? 'Modifier le profil' : 'Nouveau profil',
    fields, values: existing || {},
    onSave: async data => {
      const p = existing || { id: uid(), sorts: [], cours: [], potions: [], relations: [] };
      const old = p.image;
      const { blob, removed } = data.__image;
      if (blob) p.image = await storeImage(p.id, blob);
      else if (removed) p.image = '';
      Object.assign(p, { prenom: data.prenom, nom: data.nom, maison: data.maison, annee: data.annee, description: data.description, updated: Date.now() });
      if (!existing) { db.profiles.push(p); location.hash = '#/p/' + p.id; }
      commit();
      if (old && old !== p.image) deleteImage(old);
    },
    onDelete: existing && (() => {
      if (!confirm(`Supprimer définitivement ${fullName(existing)} ?`)) return false;
      db.profiles = db.profiles.filter(x => x !== existing);
      for (const q of db.profiles) for (const r of q.relations) {
        if (r.profileId === existing.id) { r.prenom = existing.prenom; r.nom = existing.nom; r.profileId = ''; q.updated = Date.now(); }
      }
      db.deleted[existing.id] = Date.now();
      deleteImage(existing.image);
      location.hash = '#/';
      commit();
    }),
  });
}

/* ================= Vues ================= */
const app = $('#app');

function render() {
  const y = scrollY;
  const hash = location.hash;
  const mp = hash.match(/^#\/p\/([\w-]+)/);
  const mb = hash.match(/^#\/b\/([\w-]+)/);
  let section = 'persos';
  app.replaceChildren();
  if (mp) {
    const p = db.profiles.find(x => x.id === mp[1]);
    if (!p) { location.replace('#/'); return; }
    document.title = `${fullName(p)} · Registre de Poudlard`;
    app.append(viewProfile(p));
  } else if (mb) {
    section = 'best';
    const b = db.bestiaire.find(x => x.id === mb[1]);
    if (!b) { location.replace('#/bestiaire'); return; }
    document.title = `${b.nom} · Bestiaire`;
    app.append(viewBeast(b));
  } else if (hash.startsWith('#/bestiaire')) {
    section = 'best';
    document.title = 'Bestiaire · Registre de Poudlard';
    app.append(viewBestiary());
  } else {
    document.title = 'Registre de Poudlard · RP';
    app.append(viewList());
  }
  for (const a of document.querySelectorAll('.nav a')) a.setAttribute('aria-current', a.dataset.nav === section ? 'page' : 'false');
  scrollTo(0, y);
}

/* ================= Bestiaire (indépendant des profils) ================= */
const asPortrait = b => ({ prenom: b.nom, nom: '', image: b.image });

function editBeast(existing) {
  const imgF = imageField(existing && existing.image);
  const fields = [
    { key: 'nom', label: 'Nom de la créature', required: true, max: 80 },
    { key: 'espece', label: 'Type / famille', list: 'dl-types', max: 60, placeholder: 'ex. Bête, Esprit, Arachnide…' },
    { key: 'danger', label: 'Dangerosité', type: 'select', options: [{ value: '', label: '— Inconnue —' }, ...DANGERS.map(d => ({ value: d, label: d }))] },
    { key: 'habitat', label: 'Habitat', max: 160, placeholder: 'ex. Forêt Interdite, Hogsmeade…' },
    { key: 'description', label: 'Description', type: 'textarea', rows: 5, max: 4000 },
    { key: 'comportement', label: 'Comportement', type: 'textarea', rows: 3, max: 2000 },
    { key: 'faiblesses', label: 'Points faibles / sortilèges efficaces', type: 'textarea', rows: 3, max: 2000 },
    { key: 'butin', label: 'Butin / ingrédients récoltables', type: 'textarea', rows: 3, max: 2000 },
    { key: '__image', ...imgF },
  ];
  openForm({
    title: existing ? 'Modifier la créature' : 'Nouvelle créature',
    fields, values: existing || {},
    onSave: async data => {
      const b = existing || { id: uid(), image: '' };
      const old = b.image;
      const { blob, removed } = data.__image;
      if (blob) b.image = await storeImage(b.id, blob);
      else if (removed) b.image = '';
      Object.assign(b, {
        nom: data.nom, espece: data.espece, danger: data.danger, habitat: data.habitat,
        description: data.description, comportement: data.comportement, faiblesses: data.faiblesses, butin: data.butin,
        updated: Date.now(),
      });
      if (!existing) { db.bestiaire.push(b); location.hash = '#/b/' + b.id; }
      commit();
      if (old && old !== b.image) deleteImage(old);
    },
    onDelete: existing && (() => {
      if (!confirm(`Supprimer « ${existing.nom} » du bestiaire ?`)) return false;
      db.bestiaire = db.bestiaire.filter(x => x !== existing);
      db.deleted[existing.id] = Date.now();
      deleteImage(existing.image);
      location.hash = '#/bestiaire';
      commit();
    }),
  });
}

function viewBestiary() {
  const grid = h('div', { class: 'grid' });
  const empty = h('div', { class: 'empty' });
  const fill = () => {
    const q = norm(ui.qb);
    const list = db.bestiaire
      .filter(b => !q || norm(`${b.nom} ${b.espece} ${b.habitat} ${b.danger}`).includes(q))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    grid.replaceChildren(...list.map(beastCard));
    empty.hidden = list.length > 0;
    empty.replaceChildren(db.bestiaire.length
      ? h('p', {}, 'Aucune créature ne correspond à cette recherche.')
      : h('p', {}, h('strong', {}, 'Le bestiaire est vide.'), canEdit() ? 'Cliquez sur « Nouvelle créature » pour ajouter la première.' : 'Aucune créature n’a encore été publiée.'));
  };
  const search = h('input', { type: 'search', placeholder: 'Rechercher une créature, un type, un habitat…', 'aria-label': 'Rechercher', value: ui.qb });
  search.addEventListener('input', () => { ui.qb = search.value; fill(); });
  fill();
  return h('section', {},
    h('div', { class: 'toolbar' }, search, canEdit() && h('button', { class: 'btn', type: 'button', onclick: () => editBeast() }, '+ Nouvelle créature')),
    grid, empty);
}

function beastCard(b) {
  return h('a', { class: 'card beast', href: '#/b/' + b.id },
    portrait(asPortrait(b), 'card-img'),
    h('div', { class: 'card-body' },
      h('h3', {}, b.nom),
      b.espece && h('span', { class: 'house' }, b.espece),
      b.danger && h('span', { class: 'tag st ' + DANGER_CLS[b.danger] }, b.danger)));
}

function viewBeast(b) {
  const sec = (title, text) => text && h('section', { class: 'sec' }, h('h2', {}, title), h('p', {}, text));
  return h('article', {},
    h('a', { class: 'back', href: '#/bestiaire' }, '← Tout le bestiaire'),
    h('div', { class: 'hero' },
      portrait(asPortrait(b), 'hero-img'),
      h('div', {},
        h('h1', {}, b.nom),
        h('div', { class: 'meta' },
          b.espece && h('span', { class: 'tag' }, b.espece),
          b.danger && h('span', { class: 'tag st ' + DANGER_CLS[b.danger] }, 'Danger : ' + b.danger),
          b.habitat && h('span', { class: 'tag' }, 'Habitat : ' + b.habitat)),
        b.description && h('p', { class: 'desc' }, b.description),
        canEdit() && h('button', { class: 'btn ghost sm', type: 'button', onclick: () => editBeast(b) }, 'Modifier la fiche'))),
    sec('Comportement', b.comportement),
    sec('Points faibles / sortilèges efficaces', b.faiblesses),
    sec('Butin / ingrédients', b.butin));
}

function viewList() {
  const grid = h('div', { class: 'grid' });
  const empty = h('div', { class: 'empty' });
  const fill = () => {
    const q = norm(ui.q);
    const list = db.profiles
      .filter(p => !q || norm(`${p.prenom} ${p.nom} ${p.maison}`).includes(q))
      .sort((a, b) => fullName(a).localeCompare(fullName(b), 'fr'));
    grid.replaceChildren(...list.map(card));
    empty.hidden = list.length > 0;
    empty.replaceChildren(db.profiles.length
      ? h('p', {}, 'Aucun personnage ne correspond à cette recherche.')
      : h('p', {}, h('strong', {}, 'Le registre est vide.'), canEdit() ? 'Cliquez sur « Nouveau profil » pour créer votre premier personnage.' : 'Aucun personnage n’a encore été publié.'));
  };
  const search = h('input', { type: 'search', placeholder: 'Rechercher un personnage ou une maison…', 'aria-label': 'Rechercher', value: ui.q });
  search.addEventListener('input', () => { ui.q = search.value; fill(); });
  fill();
  return h('section', {},
    h('div', { class: 'toolbar' }, search, canEdit() && h('button', { class: 'btn', type: 'button', onclick: () => editProfile() }, '+ Nouveau profil')),
    grid, empty);
}

function card(p) {
  return h('a', { class: 'card', href: '#/p/' + p.id, 'data-house': p.maison || null },
    portrait(p, 'card-img'),
    h('div', { class: 'card-body' },
      h('h3', {}, fullName(p)),
      p.maison && h('span', { class: 'house' }, p.maison),
      p.description && h('p', {}, p.description)));
}

const TABS = [['sorts', 'Sortilèges'], ['cours', 'Cours'], ['potions', 'Potions'], ['relations', 'Relations']];

function viewProfile(p) {
  const panelBox = h('div', { role: 'tabpanel' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const drawTabs = () => {
    tabs.replaceChildren(...TABS.map(([k, label]) => h('button', {
      class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(ui.tab === k),
      onclick: () => { ui.tab = k; drawTabs(); drawPanel(); },
    }, label, h('span', { class: 'count' }, '(' + p[k].length + ')'))));
  };
  const drawPanel = () => panelBox.replaceChildren(panel(p, ui.tab));
  drawTabs(); drawPanel();

  return h('article', {},
    h('a', { class: 'back', href: '#/' }, '← Tous les personnages'),
    h('div', { class: 'hero', 'data-house': p.maison || null },
      portrait(p, 'hero-img'),
      h('div', {},
        h('h1', {}, fullName(p)),
        h('div', { class: 'meta' },
          p.maison && h('span', { class: 'tag house-tag' }, p.maison),
          p.annee && h('span', { class: 'tag' }, p.annee + (p.annee === '1' ? 'ère' : 'e') + ' année')),
        p.description && h('p', { class: 'desc' }, p.description),
        canEdit() && h('button', { class: 'btn ghost sm', type: 'button', onclick: () => editProfile(p) }, 'Modifier le profil'))),
    tabs, panelBox);
}

function panel(p, kind) {
  const s = SCHEMAS[kind];
  const items = p[kind];
  const editBtn = it => canEdit() && h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Modifier', onclick: e => { e.preventDefault(); editItem(p, kind, it); } }, 'Modifier');
  const render1 = { sorts: rowSort, cours: rowCours, potions: rowPotion, relations: rowRel }[kind];
  const sec = h('section', {},
    h('div', { class: 'panel-bar' },
      h('h2', {}, TABS.find(t => t[0] === kind)[1]),
      canEdit() && h('button', { class: 'btn sm', type: 'button', onclick: () => editItem(p, kind, null) }, '+ ' + s.add)),
    items.length
      ? h('ul', { class: 'rows' }, items.map(it => h('li', { 'data-id': it.id }, render1(it, editBtn(it)))))
      : h('p', { class: 'empty' }, s.empty));
  if (ui.focus && ui.focus.kind === kind) {   // arrivée depuis la recherche : on ouvre et on signale l'élément
    const f = ui.focus; ui.focus = null;
    requestAnimationFrame(() => {
      const li = [...sec.querySelectorAll('li[data-id]')].find(x => x.dataset.id === String(f.id));
      if (!li) return;
      const d = li.querySelector('details'); if (d) d.open = true;
      li.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
      li.classList.add('hit');
      setTimeout(() => li.classList.remove('hit'), 2400);
    });
  }
  return sec;
}

const rowSort = (it, btn) => h('div', { class: 'row' },
  h('div', { class: 'row-main' },
    h('div', { class: 'row-title' }, h('strong', {}, it.nom), it.niveau && h('span', { class: 'tag' }, it.niveau), it.source && h('small', {}, it.source)),
    it.note && h('p', { class: 'note' }, it.note)),
  btn);

const rowCours = (it, btn) => h('details', { class: 'row' },
  h('summary', {},
    h('span', { class: 'sum-main' }, h('strong', {}, it.titre), it.matiere && h('span', { class: 'tag' }, it.matiere), it.date && h('small', {}, it.date)),
    btn),
  h('div', { class: 'body' }, richText(it.texte).trim() || /<hr/i.test(it.texte || '') ? richView(it.texte) : h('small', {}, 'Pas de contenu.')));

const rowPotion = (it, btn) => {
  const ing = String(it.ingredients || '').split('\n').map(x => x.trim()).filter(Boolean);
  return h('details', { class: 'row' },
    h('summary', {}, h('span', { class: 'sum-main' }, h('strong', {}, it.nom), it.effet && h('small', {}, it.effet)), btn),
    h('div', { class: 'body' },
      ing.length && h('div', {}, h('h4', {}, 'Ingrédients'), h('ul', {}, ing.map(i => h('li', {}, i)))),
      it.preparation && h('div', {}, h('h4', {}, 'Préparation'), it.preparation)));
};

function rowRel(it, btn) {
  const linked = it.profileId && db.profiles.find(x => x.id === it.profileId);
  const who = linked || { prenom: it.prenom, nom: it.nom, image: '' };
  const name = h('strong', {}, fullName(who) || 'Inconnu');
  return h('div', { class: 'row rel' },
    portrait(who, 'avatar'),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' },
        linked ? h('a', { href: '#/p/' + linked.id }, name) : name,
        h('span', { class: 'tag st ' + statusCls(it.statut) }, it.statut || '—')),
      it.note && h('p', { class: 'note' }, it.note)),
    btn);
}

/* ================= Réglages, import / export ================= */
function exportJSON() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `registre-poudlard-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function importJSON(file) {
  try {
    const data = normalize(JSON.parse(await file.text()));
    if (!data.profiles.length && !data.bestiaire.length) return toast('Fichier vide ou invalide.', 'err');
    if (!confirm(`Remplacer toutes les données actuelles par ce fichier (${data.profiles.length} profil(s), ${data.bestiaire.length} créature(s)) ?`)) return;
    db = data;
    if (hasToken()) await migrateImages();
    commit(); toast('Import terminé.');
  } catch (e) { toast('Import impossible : ' + e.message, 'err'); }
}

function openSettings() {
  const importIn = h('input', { type: 'file', accept: 'application/json,.json' });
  importIn.addEventListener('change', () => { if (importIn.files[0]) importJSON(importIn.files[0]); importIn.value = ''; });
  const tools = {
    type: 'custom', key: '__tools', get: () => null,
    node: h('div', { class: 'field' },
      h('span', { class: 'lbl' }, 'Sauvegarde manuelle'),
      h('div', { class: 'tools' },
        h('button', { class: 'btn ghost sm', type: 'button', onclick: exportJSON }, 'Exporter (JSON)'),
        canEdit() && h('button', { class: 'btn ghost sm', type: 'button', onclick: () => importIn.click() }, 'Importer (JSON)'),
        hasToken() && h('button', {
          class: 'btn danger sm', type: 'button',
          onclick: async () => {
            cfg.token = ''; store(LS_CFG, cfg); writable = true;
            await loadDB(); render(); renderStatus(); toast('Déconnecté : le token a été effacé de ce navigateur.');
          },
        }, 'Effacer le token'),
        importIn)),
  };
  const glowCb = h('input', { type: 'checkbox' });
  glowCb.checked = glowOn;
  glowCb.addEventListener('change', () => { glowOn = glowCb.checked; lsSet(LS_GLOW, glowOn ? '1' : '0'); root.classList.toggle('glow', glowOn && isNox()); });
  const glowField = {
    type: 'custom', key: '__glow', get: () => null,
    node: h('label', { class: 'check' }, glowCb, h('span', {}, 'Lumière de baguette qui suit le curseur en mode Nox (ordinateur)')),
  };
  openForm({
    title: 'Réglages',
    intro: 'Pour modifier le registre depuis GitHub Pages, collez votre token personnel (voir le tutoriel). Il reste uniquement dans ce navigateur.',
    values: cfg,
    fields: [
      { key: 'owner', label: 'Compte GitHub', max: 60 },
      { key: 'repo', label: 'Nom du dépôt', max: 100 },
      { key: 'branch', label: 'Branche', max: 60 },
      { key: 'token', label: 'Token d’accès personnel', type: 'password', max: 200, placeholder: 'github_pat_…', help: hasToken() ? 'Un token est déjà enregistré ; laissez tel quel pour le conserver.' : '' },
      glowField,
      tools,
    ],
    onSave: async data => {
      const prev = { ...cfg };
      const clean = s => String(s || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
      const next = { owner: clean(data.owner).split('/')[0], repo: clean(data.repo).split('/').pop(), branch: data.branch || 'main', token: data.token };
      Object.assign(cfg, next);
      if (cfg.token) {
        if (!cfg.owner || !cfg.repo) { Object.assign(cfg, prev); return 'Indiquez le compte et le dépôt.'; }
        try {
          const r = await gh('');
          if (r.permissions && !r.permissions.push) { Object.assign(cfg, prev); return 'Ce token ne peut pas écrire dans ce dépôt (permission « Contents : Read and write » requise).'; }
        } catch (e) { Object.assign(cfg, prev); return e.message; }
      }
      store(LS_CFG, cfg);
      const local = load(LS_DB);
      await loadDB();
      if (hasToken() && writable && !db.profiles.length && local && local.profiles && local.profiles.length
        && confirm(`Des données locales ont été trouvées (${local.profiles.length} profil(s)). Les envoyer sur GitHub ?`)) {
        db = normalize(local);
        await migrateImages();
        commit();
      }
      render(); renderStatus();
      if (hasToken()) toast('Connecté à GitHub.');
    },
  });
}

/* ================= Thème : Lumos (clair) / Nox (nuit) ================= */
const LS_THEME = 'hrp.theme', LS_GLOW = 'hrp.glow';
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* navigation privée : non mémorisé */ } };
let glowOn = (() => { try { return localStorage.getItem(LS_GLOW) !== '0'; } catch { return true; } })();

function applyTheme(nox) {
  if (nox) root.dataset.theme = 'nox'; else delete root.dataset.theme;
  $('meta[name=theme-color]').content = nox ? '#0b0d14' : '#261b13';
  const b = $('#btn-theme');
  b.textContent = nox ? 'Lumos' : 'Nox';
  b.setAttribute('aria-label', nox ? 'Rallumer : passer au mode clair (Lumos)' : 'Éteindre : passer au mode nuit (Nox)');
  root.classList.toggle('glow', nox && glowOn);
}

function toggleTheme(e) {
  const nox = !isNox();
  lsSet(LS_THEME, nox ? 'nox' : 'lumos');
  if (reduceMotion.matches) return applyTheme(nox);
  // La lumière (ou l'obscurité) jaillit du bouton et recouvre l'écran ; le thème change sous l'effet.
  const r = e.currentTarget.getBoundingClientRect();
  const fx = h('div', { class: 'flash ' + (nox ? 'to-nox' : 'to-lumos'), 'aria-hidden': 'true', style: `--fx:${r.left + r.width / 2}px;--fy:${r.top + r.height / 2}px` });
  document.body.append(fx);
  setTimeout(() => applyTheme(nox), 280);
  setTimeout(() => fx.remove(), 1300);
}

let moveRaf = 0;   // la lumière de baguette suit le pointeur (mode Nox, ordinateur)
addEventListener('pointermove', e => {
  if (moveRaf || !root.classList.contains('glow')) return;
  moveRaf = requestAnimationFrame(() => {
    moveRaf = 0;
    root.style.setProperty('--mx', e.clientX + 'px');
    root.style.setProperty('--my', e.clientY + 'px');
  });
}, { passive: true });

/* ================= Recherche globale ================= */
const GROUPS = ['Personnages', 'Sortilèges', 'Cours', 'Potions', 'Relations', 'Bestiaire'];
const KIND = { Personnages: 'Personnage', Sortilèges: 'Sortilège', Cours: 'Cours', Potions: 'Potion', Relations: 'Relation', Bestiaire: 'Créature' };

/** Version normalisée d'un texte + table de correspondance vers les positions d'origine (accents ignorés). */
function normMap(str) {
  let s = '';
  const map = [];
  for (let i = 0; i < str.length; i++) {
    const n = str[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const ch of n) { s += ch; map.push(i); }
  }
  return { s, map };
}

function highlight(text, words) {
  const { s, map } = normMap(text);
  const ranges = [];
  for (const w of words) {
    if (!w) continue;
    for (let i = s.indexOf(w); i !== -1; i = s.indexOf(w, i + w.length)) ranges.push([map[i], map[i + w.length - 1] + 1]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [a, b] of ranges) {
    if (b <= pos) continue;
    const from = Math.max(a, pos);
    if (from > pos) out.push(text.slice(pos, from));
    out.push(h('mark', {}, text.slice(from, b)));
    pos = b;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

function excerpt(text, words) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const { s, map } = normMap(flat);
  let at = -1;
  for (const w of words) { const i = w ? s.indexOf(w) : -1; if (i !== -1 && (at === -1 || i < at)) at = i; }
  if (at === -1) return flat.length > 140 ? flat.slice(0, 140) + '…' : flat;
  const from = Math.max(0, map[at] - 45);
  return (from > 0 ? '…' : '') + flat.slice(from, from + 150) + (from + 150 < flat.length ? '…' : '');
}

function buildIndex() {
  const rows = [];
  const add = (group, title, owner, parts, go) => {
    const text = parts.filter(Boolean).join('\n');
    rows.push({ group, title, owner, text, go, nt: norm(title), nx: norm(text + ' ' + owner) });
  };
  for (const p of db.profiles) {
    const owner = fullName(p);
    add('Personnages', owner, '', [p.maison, p.annee && p.annee + 'e année', p.description], { hash: '#/p/' + p.id });
    for (const s of p.sorts) add('Sortilèges', s.nom || '', owner, [s.niveau, s.source, s.note], { hash: '#/p/' + p.id, tab: 'sorts', item: s.id });
    for (const c of p.cours) add('Cours', c.titre || '', owner, [c.matiere, c.date, richText(c.texte)], { hash: '#/p/' + p.id, tab: 'cours', item: c.id });
    for (const o of p.potions) add('Potions', o.nom || '', owner, [o.effet, o.ingredients, o.preparation], { hash: '#/p/' + p.id, tab: 'potions', item: o.id });
    for (const r of p.relations) {
      const l = r.profileId && db.profiles.find(x => x.id === r.profileId);
      add('Relations', fullName(l || r) || 'Inconnu', owner, [r.statut, r.note], { hash: '#/p/' + p.id, tab: 'relations', item: r.id });
    }
  }
  for (const b of db.bestiaire) {
    add('Bestiaire', b.nom, '', [b.espece, b.danger, b.habitat, b.description, b.comportement, b.faiblesses, b.butin], { hash: '#/b/' + b.id });
  }
  return rows;
}

function runSearch(rows, q) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  const hits = [];
  if (q.trim().length >= 2) {
    for (const r of rows) {
      if (!words.every(w => r.nt.includes(w) || r.nx.includes(w))) continue;
      hits.push({ r, score: words.reduce((a, w) => a + (r.nt.includes(w) ? 3 : 0) + (r.nx.includes(w) ? 1 : 0), 0) });
    }
    hits.sort((a, b) => b.score - a.score || a.r.title.localeCompare(b.r.title, 'fr'));
  }
  return { words, hits: hits.map(x => x.r) };
}

function openSearch() {
  if (document.querySelector('dialog[open]')) return;
  const index = buildIndex();
  const dlg = h('dialog', { class: 'modal search', 'aria-label': 'Recherche dans le registre' });
  const input = h('input', { type: 'search', placeholder: 'Un sort, une potion, un cours, une créature…', 'aria-label': 'Rechercher dans tout le registre', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'results', 'aria-live': 'polite' });

  const openHit = go => {
    ui.focus = go.item ? { kind: go.tab, id: go.item } : null;
    if (go.tab) ui.tab = go.tab;
    dlg.close();
    if (location.hash === go.hash) render(); else location.hash = go.hash;
  };
  const hitButton = (r, words) => {
    const snip = excerpt(r.text, words);
    return h('button', { class: 'hit-btn', type: 'button', onclick: () => openHit(r.go) },
      h('span', { class: 'r-title' }, highlight(r.title, words), h('span', { class: 'tag' }, KIND[r.group])),
      r.owner && h('span', { class: 'r-sub' }, 'chez ' + r.owner),
      snip && h('span', { class: 'r-snip' }, highlight(snip, words)));
  };

  const draw = () => {
    const q = input.value;
    const { words, hits } = runSearch(index, q);
    list.replaceChildren();
    if (q.trim().length < 2) {
      list.append(h('p', { class: 'help' }, 'Tapez au moins deux lettres. La recherche porte sur les personnages, les sortilèges, les cours, les potions, les relations et le bestiaire ; les accents sont ignorés.'));
      return;
    }
    if (!hits.length) {
      list.append(h('p', { class: 'help' }, `Aucun résultat pour « ${q.trim()} ». Essayez un mot plus court.`));
      return;
    }
    list.append(h('p', { class: 'help' }, hits.length + (hits.length > 1 ? ' résultats' : ' résultat')));
    for (const g of GROUPS) {
      const rows = hits.filter(r => r.group === g);
      if (!rows.length) continue;
      list.append(
        h('h3', {}, `${g} (${rows.length})`),
        h('ul', { class: 'hits' }, rows.slice(0, 8).map(r => h('li', {}, hitButton(r, words)))));
      if (rows.length > 8) list.append(h('p', { class: 'help' }, `… et ${rows.length - 8} autres : précisez la recherche pour les voir.`));
    }
  };

  input.addEventListener('input', draw);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); dlg.close(); return; }   // Chrome vide sinon le champ avant de fermer
    if (e.key !== 'Enter') return;
    const first = dlg.querySelector('.hit-btn');
    if (first) { e.preventDefault(); first.click(); }
  });
  dlg.addEventListener('keydown', e => {   // flèches : on parcourt les résultats
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...dlg.querySelectorAll('.hit-btn')];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') (items[i + 1] || items[0]).focus();
    else if (i <= 0) input.focus();
    else items[i - 1].focus();
  });
  dlg.append(h('div', { class: 'form' },
    h('h2', {}, 'Rechercher dans le registre'),
    input, list,
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Fermer'))));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('mousedown', e => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  draw();
  input.focus();
}

addEventListener('keydown', e => {
  const a = document.activeElement;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !a.isContentEditable) { e.preventDefault(); openSearch(); }
});

/* ================= Démarrage ================= */
$('#btn-theme').addEventListener('click', toggleTheme);
$('#btn-search').addEventListener('click', openSearch);
$('#btn-settings').addEventListener('click', openSettings);
$('#status').addEventListener('click', async () => {
  if (hasToken() && !writable) { await loadDB(); render(); }
  else if (hasToken() && sync === 'error') enqueue(() => pushDB());
  else openSettings();
});
addEventListener('hashchange', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden) enqueue(refresh); });
addEventListener('beforeunload', e => {
  if (hasToken() && (sync === 'pending' || sync === 'saving')) { e.preventDefault(); e.returnValue = ''; }
});

applyTheme(isNox());
renderStatus();
app.append(h('p', { class: 'loading' }, 'Ouverture du grimoire…'));
loadDB().then(() => { render(); renderStatus(); });
})();
