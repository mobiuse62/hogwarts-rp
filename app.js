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
const IMG_OK = /^(images\/[\w.\-]+|data:image\/)/;

const $ = (s, r = document) => r.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

/** Création de nœuds DOM (aucun innerHTML : pas de risque d'injection). */
function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
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
let ui = { tab: 'sorts', q: '' };
const imgCache = new Map();  // chemin → blob: URL (images tout juste envoyées)

const hasToken = () => !!(cfg.token && cfg.owner && cfg.repo);
const canEdit = () => writable && (hasToken() || !isHosted);

function normalize(x) {
  const out = { version: 1, profiles: [] };
  if (!x || !Array.isArray(x.profiles)) return out;
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
  return out;
}

/* ================= API GitHub ================= */
const API = () => `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/`;
const headers = accept => ({
  Accept: accept || 'application/vnd.github+json',
  Authorization: 'Bearer ' + cfg.token,
  'X-GitHub-Api-Version': '2022-11-28',
});
const explain = (s, m) => ({
  401: 'Token invalide ou expiré.',
  403: 'Accès refusé (droits du token insuffisants, ou limite de requêtes atteinte).',
  404: 'Introuvable : vérifiez le compte, le dépôt, la branche et l’accès du token à ce dépôt.',
  409: 'Conflit de version.', 422: 'Conflit de version.',
}[s] || m || ('Erreur ' + s));

async function gh(path, opts = {}) {
  const res = await fetch(API() + path, {
    ...opts,
    headers: { ...headers(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
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
async function loadDB() {
  remoteSha = null;
  if (hasToken()) {
    try {
      const f = await gh('contents/' + DATA_PATH + ref());
      remoteSha = f.sha;
      const bytes = f.content ? fromB64(f.content) : fromB64((await gh('git/blobs/' + f.sha)).content);
      db = normalize(JSON.parse(new TextDecoder().decode(bytes)));
      writable = true; setSync('synced'); return;
    } catch (e) {
      if (e.status === 404) { db = normalize(null); writable = true; setSync('synced'); return; }
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
  const body = {
    message: 'RP : mise à jour du registre',
    content: b64(new TextEncoder().encode(JSON.stringify(db, null, 1))),
    branch: cfg.branch,
  };
  if (remoteSha) body.sha = remoteSha;
  try {
    const r = await gh('contents/' + DATA_PATH, { method: 'PUT', body: JSON.stringify(body) });
    remoteSha = r.content.sha;
    setSync(rev === myRev ? 'synced' : 'pending');
  } catch (e) {
    if ((e.status === 409 || e.status === 422) && retry) {
      try { remoteSha = (await gh('contents/' + DATA_PATH + ref())).sha; }
      catch (e2) { if (e2.status === 404) remoteSha = null; else { setSync('error'); toast(e2.message, 'err'); return; } }
      return pushDB(false);   // dernière écriture gagnante
    }
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
      const meta = await gh('contents/' + path + ref());
      await gh('contents/' + path, { method: 'DELETE', body: JSON.stringify({ message: 'RP : suppression image', sha: meta.sha, branch: cfg.branch }) });
    } catch { /* image déjà absente : sans gravité */ }
  });
}

async function migrateImages() {
  for (const p of db.profiles) {
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
const initials = p => ((p.prenom || '?')[0] + (p.nom || '')[0]).toUpperCase();
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
    fields: () => [
      { key: 'titre', label: 'Titre', required: true, max: 120 },
      { key: 'matiere', label: 'Matière', list: 'dl-matieres', max: 80 },
      { key: 'date', label: 'Date (RP ou réelle)', max: 40, placeholder: 'ex. 12 septembre 1891' },
      { key: 'texte', label: 'Contenu du cours', type: 'textarea', rows: 8, max: 8000 },
    ],
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
    title: (item ? 'Modifier' : 'Ajouter') + ' · ' + s.label,
    fields: s.fields(p), values: item || s.defaults,
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
        if (r.profileId === existing.id) { r.prenom = existing.prenom; r.nom = existing.nom; r.profileId = ''; }
      }
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
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  app.replaceChildren();
  if (m) {
    const p = db.profiles.find(x => x.id === m[1]);
    if (!p) { location.replace('#/'); return; }
    document.title = `${fullName(p)} · Registre de Poudlard`;
    app.append(viewProfile(p));
  } else {
    document.title = 'Registre de Poudlard · RP';
    app.append(viewList());
  }
  scrollTo(0, y);
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
  return h('section', {},
    h('div', { class: 'panel-bar' },
      h('h2', {}, TABS.find(t => t[0] === kind)[1]),
      canEdit() && h('button', { class: 'btn sm', type: 'button', onclick: () => editItem(p, kind, null) }, '+ ' + s.add)),
    items.length
      ? h('ul', { class: 'rows' }, items.map(it => h('li', {}, render1(it, editBtn(it)))))
      : h('p', { class: 'empty' }, s.empty));
}

const rowSort = (it, btn) => h('div', { class: 'row' },
  h('div', { class: 'row-main' },
    h('div', { class: 'row-title' }, h('strong', {}, it.nom), it.niveau && h('span', { class: 'tag' }, it.niveau), it.source && h('small', {}, '· ' + it.source)),
    it.note && h('p', { class: 'note' }, it.note)),
  btn);

const rowCours = (it, btn) => h('details', { class: 'row' },
  h('summary', {},
    h('span', { class: 'sum-main' }, h('strong', {}, it.titre), it.matiere && h('span', { class: 'tag' }, it.matiere), it.date && h('small', {}, it.date)),
    btn),
  h('div', { class: 'body' }, it.texte || h('small', {}, 'Pas de contenu.')));

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
    if (!data.profiles.length) return toast('Fichier vide ou invalide.', 'err');
    if (!confirm(`Remplacer toutes les données actuelles par ce fichier (${data.profiles.length} profil(s)) ?`)) return;
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
  openForm({
    title: 'Réglages',
    intro: 'Pour modifier le registre depuis GitHub Pages, collez votre token personnel (voir le tutoriel). Il reste uniquement dans ce navigateur.',
    values: cfg,
    fields: [
      { key: 'owner', label: 'Compte GitHub', max: 60 },
      { key: 'repo', label: 'Nom du dépôt', max: 100 },
      { key: 'branch', label: 'Branche', max: 60 },
      { key: 'token', label: 'Token d’accès personnel', type: 'password', max: 200, placeholder: 'github_pat_…', help: hasToken() ? 'Un token est déjà enregistré ; laissez tel quel pour le conserver.' : '' },
      tools,
    ],
    onSave: async data => {
      const prev = { ...cfg };
      const next = { owner: data.owner, repo: data.repo, branch: data.branch || 'main', token: data.token };
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

/* ================= Démarrage ================= */
$('#btn-settings').addEventListener('click', openSettings);
$('#status').addEventListener('click', async () => {
  if (hasToken() && !writable) { await loadDB(); render(); }
  else if (hasToken() && sync === 'error') enqueue(() => pushDB());
  else openSettings();
});
addEventListener('hashchange', render);
addEventListener('beforeunload', e => {
  if (hasToken() && (sync === 'pending' || sync === 'saving')) { e.preventDefault(); e.returnValue = ''; }
});

renderStatus();
app.append(h('p', { class: 'loading' }, 'Ouverture du grimoire…'));
loadDB().then(() => { render(); renderStatus(); });
})();
