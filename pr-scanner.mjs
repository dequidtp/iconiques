// pr-scanner.mjs
// Indice de PRÉSENCE MÉDIA des dirigeants.
//
// Pour chaque entreprise active (table `companies` de Supabase) :
//   1. cherche les PRISES DE PAROLE des dirigeants (PDG + membres du COMEX) —
//      interviews, entretiens, podcasts — via Google News RSS (gratuit, sans clé) ;
//   2. identifie l'interviewé (PDG connu, ou dirigeant détecté dans le titre) ;
//   3. stocke chaque prise de parole (table `pr_interviews`, dédup par URL) ;
//   4. recalcule UN score de présence média sur la fenêtre glissante (défaut 90 j)
//      et l'enregistre dans `pr_index_snapshots` (un point par entreprise et par jour).
//
// Score de présence = Σ sur les interviews de la fenêtre de :
//      POINTS_BASE × poids_média × poids_format × récence
//   poids_média  : média cible (tier-1) vaut plus qu'un média lambda
//   poids_format : podcast / grand entretien valent plus qu'une brève interview
//   récence      : une prise de parole récente pèse plus qu'une ancienne
// → un chiffre par entreprise, qui monte quand les dirigeants s'expriment beaucoup
//   dans de bons médias, et redescend quand ils se font discrets.
//
// Variables d'environnement requises (voir .github/workflows/scan-pr.yml) :
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const WINDOW_DAYS = 90;
const POINTS_BASE = 10;         // points de base d'une prise de parole
const TIER1_WEIGHT = 1.5;       // média cible (Investir, Les Échos, FT...)
const OTHER_WEIGHT = 1.0;       // autre média
const PODCAST_WEIGHT = 1.4;     // format podcast
const LONGFORM_WEIGHT = 1.3;    // "grand entretien"
const STD_WEIGHT = 1.0;         // interview / entretien standard
// Post du dirigeant sur X/LinkedIn/Instagram : vraie prise de parole, mais
// auto-publiée (pas de média qui la sollicite ni ne la filtre) → pèse moins.
const SOCIAL_WEIGHT = 0.6;
const RECENCY_FLOOR = 0.25;     // une vieille interview compte encore un peu
// Google News throttle vite depuis une IP partagée (runner GitHub Actions).
// Cadence prudente + réessais : mieux vaut un run lent qu'un run vide.
const REQUEST_DELAY_MS = 3000;
const FETCH_RETRIES = 3;
const BACKOFF_MS = 4000;        // 4s, 8s, 16s

// Médias « tier-1 » (presse cible). Comparaison en minuscules, sans accents.
const TIER1_SOURCES = [
  'investir', 'les echos', 'financial times', 'le monde',
  'bloomberg', 'reuters', 'challenges', 'la tribune', 'le figaro',
];

// Marqueurs FORTS : le titre annonce explicitement une interview / un podcast.
// Suffisants pour n'importe quel dirigeant (PDG ou membre du COMEX détecté).
const STRONG_MARKERS = [
  'interview', 'entretien', 'grand entretien', 'podcast', 'confidences',
  'au micro', 'invite de', 'invitee de', 'a coeur ouvert', 'propos recueillis',
  '3 questions', 'trois questions', 'face a face', 'itw',
];

// Marqueurs SOUPLES : le dirigeant s'exprime sans que le mot « interview »
// apparaisse (fréquent aux Échos / Le Figaro). N'acceptés QUE pour le PDG connu
// (haute confiance que c'est bien lui qui parle), sinon trop de faux positifs.
const SOFT_MARKERS = [
  'fait le point', 'se confie', 'se livre', 'revient sur', 'repond',
  'defend', 'raconte', 'temoigne', 'prend la parole', 'nous parle',
  'livre sa vision', 'fait ses confidences', 'detaille', 's exprime', "s'exprime",
];

// Prise de parole DIRECTE du dirigeant sur les réseaux sociaux. Un post long
// d'un PDG fait aujourd'hui office de tribune : ça compte comme une prise de
// parole — mais dans une catégorie distincte, moins valorisée qu'un entretien
// accordé à un média (voir SOCIAL_WEIGHT).
const SOCIAL_MARKERS = [
  'sur x', 'sur twitter', 'tweet', 'twitte', 'poste sur', 'publie sur',
  'reseaux sociaux', 'reseau social', 'linkedin', 'instagram', 'facebook',
  'tiktok', 'publication sur', 'message poste', 'story',
];

// Ce qui n'est PAS une parole personnelle du dirigeant : documents corporate
// émis par l'entreprise. Rejeté même si le dirigeant y est cité.
const EXCLUSION_MARKERS = [
  'communique de presse', 'communique', 'note aux analystes',
  'lettre aux actionnaires', 'resultats annuels', 'resultats trimestriels',
];

// Titre d'interview canonique : « <Nom du dirigeant> : "…" » — le nom, suivi
// d'un deux-points (ou tiret), puis d'une citation ouvrante. C'est le format
// standard des Échos / du Figaro pour un entretien.
// Une citation entre guillemets N'IMPORTE OÙ dans le titre ne suffit pas : un
// article qui cite le PDG (post X, discours, communiqué) n'est pas une interview.
function hasInterviewQuote(title, names) {
  for (const n of names) {
    if (!n) continue;
    const idx = normalize(title).indexOf(normalize(n));
    if (idx === -1) continue;
    // ce qui suit immédiatement le nom : séparateur puis guillemet ouvrant
    const after = title.slice(idx + n.length, idx + n.length + 12);
    if (/^\s*[:–—-]\s*["«“]/.test(after)) return true;
  }
  return false;
}

function isExcluded(text) {
  const t = normalize(text);
  return EXCLUSION_MARKERS.some((m) => t.includes(normalize(m)));
}

// Fonctions / rôles de dirigeant repérés dans le titre → étiquette normalisée.
const ROLE_MAP = [
  [/directrice general|directeur general|\bdg\b|directeur[- ]?general/i, 'Directeur général'],
  [/pdg|p-dg|president[e]? directeur|president[e]? du directoire/i, 'PDG'],
  [/directeur financier|directrice financiere|\bcfo\b|daf\b/i, 'Directeur financier'],
  [/president[e]?\b/i, 'Président'],
  [/cofondat(eur|rice)|co-fondat(eur|rice)|fondat(eur|rice)/i, 'Fondateur'],
  [/patron|patronne|dirigeant[e]?|numero un|boss|ceo\b/i, 'Dirigeant'],
];

// Nom de personne : 2 à 3 mots capitalisés (accents autorisés). Casse STRICTE
// (pas de flag `i`, sinon la classe majuscule matcherait aussi les minuscules).
const PERSON_RE = /([A-ZÀ-Ý][\p{L}.'’\-]+(?:[ \t]+[A-ZÀ-Ý][\p{L}.'’\-]+){1,2})/gu;
const ROLE_WORDS = /(pdg|p-dg|president|directeur|directrice|patron|patronne|\bdg\b|\bceo\b|fondat|numero un|dirigeant)/;
const CONNECTOR = /(avec|interview|entretien|podcast|confidences|rencontre|recoit)/;

// Extrait le nom d'un dirigeant interviewé : un nom propre validé par un
// connecteur d'interview juste avant, ou une fonction (rôle) juste avant/après.
function extractInterviewee(text, company) {
  if (!text) return null;
  PERSON_RE.lastIndex = 0;
  let m;
  while ((m = PERSON_RE.exec(text))) {
    const name = cleanName(m[1]);
    if (!name || companyMentioned(name, company)) continue; // pas le nom de la boîte
    const start = m.index, end = start + m[0].length;
    const before = normalize(text.slice(Math.max(0, start - 26), start));
    const after = normalize(text.slice(end, end + 34));
    if (CONNECTOR.test(before) || ROLE_WORDS.test(after) || ROLE_WORDS.test(before)) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'");
}

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function toISO(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanName(s) {
  if (!s) return null;
  const t = s.trim().replace(/[\s,.;:]+$/, '');
  if (t.length < 4 || !t.includes(' ')) return null; // exige un prénom + nom
  return t;
}

// ---------------------------------------------------------------------------
// SOURCES / FORMAT / RÔLE
// ---------------------------------------------------------------------------
function sourceTier(source) {
  const s = normalize(source);
  return TIER1_SOURCES.some((t) => s.includes(t)) ? 1 : 2;
}

// isSocial l'emporte : un post relayé par la presse reste un post.
function detectFormat(text, isSocial = false) {
  const t = normalize(text);
  if (t.includes('podcast') || t.includes('au micro')) return 'podcast';
  if (t.includes('grand entretien')) return 'grand entretien';
  if (isSocial) return 'reseau social';
  if (t.includes('entretien')) return 'entretien';
  return 'interview';
}

function formatWeight(format) {
  if (format === 'podcast') return PODCAST_WEIGHT;
  if (format === 'grand entretien') return LONGFORM_WEIGHT;
  if (format === 'reseau social') return SOCIAL_WEIGHT;
  return STD_WEIGHT;
}

function detectRole(text) {
  for (const [re, label] of ROLE_MAP) if (re.test(text)) return label;
  return null;
}

// ---------------------------------------------------------------------------
// DÉTECTION D'UNE PRISE DE PAROLE DE DIRIGEANT
// ---------------------------------------------------------------------------
function companyMentioned(text, company) {
  const t = normalize(text);
  const names = [company.name, ...(Array.isArray(company.aliases) ? company.aliases : [])];
  return names.some((n) => n && t.includes(normalize(n)));
}

function ceoNamesOf(company) {
  const names = [];
  if (company.ceo_name) names.push(company.ceo_name);
  if (Array.isArray(company.ceo_aliases)) names.push(...company.ceo_aliases);
  return names;
}

// Renvoie un objet interview {…} si le titre est une prise de parole d'un
// dirigeant DE CETTE entreprise, sinon null.
function detectInterview(item, company) {
  const title = item.title || '';
  const blob = `${title} ${item.description || ''}`;
  const nt = normalize(title);

  // Document corporate (communiqué, résultats...) : pas une parole personnelle.
  if (isExcluded(title)) return null;

  const strong = STRONG_MARKERS.some((m) => nt.includes(normalize(m)));
  const soft = SOFT_MARKERS.some((m) => nt.includes(normalize(m)));
  const social = SOCIAL_MARKERS.some((m) => nt.includes(normalize(m)));

  const tier = sourceTier(item.source);
  const format = detectFormat(blob, social);
  const ceoNames = ceoNamesOf(company);
  const ceoHit = ceoNames.find((n) => n && nt.includes(normalize(n)));

  let interviewee = null, role = null, isCeo = false;

  if (ceoHit) {
    // PDG connu : marqueur fort, marqueur souple, post sur les réseaux, ou titre
    // d'interview canonique « Nom : "…" ». Une citation ailleurs dans le titre ne
    // suffit pas (sinon un simple article citant le PDG passerait pour une prise
    // de parole).
    const quote = hasInterviewQuote(title, ceoNames);
    if (!(strong || soft || social || quote)) return null;
    interviewee = company.ceo_name;
    role = 'PDG';
    isCeo = true;
  } else {
    // dirigeant non-PDG : marqueur FORT exigé (précision) + entreprise citée + nom extrait
    if (!strong) return null;
    if (!companyMentioned(blob, company)) return null;
    interviewee = extractInterviewee(title, company) || extractInterviewee(item.description || '', company);
    if (!interviewee) return null;
    role = detectRole(blob) || 'Dirigeant';
  }

  const tierW = tier === 1 ? TIER1_WEIGHT : OTHER_WEIGHT;
  const weight = Math.round(POINTS_BASE * tierW * formatWeight(format) * 10) / 10;

  return {
    interviewee_name: interviewee,
    interviewee_role: role,
    is_ceo: isCeo,
    format,
    source_tier: tier,
    weight,               // part statique du score (récence appliquée au calcul de l'indice)
  };
}

// ---------------------------------------------------------------------------
// GOOGLE NEWS RSS
// ---------------------------------------------------------------------------
// `range` (optionnel) = { after: 'YYYY-MM-DD', before: 'YYYY-MM-DD' } pour aller
// chercher des articles plus anciens que la fenêtre courante (mode reconstruction).
function newsRssUrl(query, range) {
  const period = range
    ? `after:${range.after} before:${range.before}`
    : `when:${WINDOW_DAYS}d`;
  const q = encodeURIComponent(`${query} ${period}`);
  return `https://news.google.com/rss/search?q=${q}&hl=fr&gl=FR&ceid=FR:fr`;
}

function parseRss(xml) {
  const items = [];
  for (const block of xml.split(/<item>/).slice(1)) {
    const chunk = block.split('</item>')[0];
    const pick = (tag) => {
      const m = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? decodeEntities(m[1]) : '';
    };
    let title = pick('title');
    const link = pick('link');
    const pubDate = pick('pubDate');
    const description = pick('description');
    const sm = chunk.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    let source = sm ? decodeEntities(sm[1]) : '';

    const dash = title.match(/^(.*)\s[-–]\s([^-–]+)$/);
    if (dash) {
      if (!source) source = dash[2].trim();
      if (source && normalize(dash[2]).includes(normalize(source).slice(0, 8))) title = dash[1].trim();
    }
    if (!title || !link) continue;
    items.push({ title, link, pubDate, source, description });
  }
  return items;
}

// Renvoie { items, ok }. `ok:false` signale un échec de collecte (throttling,
// panne réseau) — à NE PAS confondre avec « aucune interview trouvée » : dans ce
// cas on s'interdit d'écrire un snapshot, sinon un run bloqué remettrait le
// score de l'entreprise à 0.
async function fetchNews(query, range) {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(newsRssUrl(query, range), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; iconiques-pr-index/2.0)',
          'Accept-Language': 'fr-FR,fr;q=0.9',
        },
      });
    } catch (err) {
      if (attempt === FETCH_RETRIES) {
        console.error(`  ⚠ réseau KO pour « ${query} » : ${err.message}`);
        return { items: [], ok: false };
      }
      await sleep(BACKOFF_MS * Math.pow(2, attempt));
      continue;
    }

    if (res.ok) return { items: parseRss(await res.text()), ok: true };

    // 429 (trop de requêtes) et 5xx sont temporaires → on réessaie
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < FETCH_RETRIES) {
      const wait = BACKOFF_MS * Math.pow(2, attempt);
      console.warn(`  ⏳ Google News ${res.status} — nouvelle tentative dans ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    console.error(`  ⚠ Google News ${res.status} pour « ${query} » (abandon)`);
    return { items: [], ok: false };
  }
  return { items: [], ok: false };
}

// ---------------------------------------------------------------------------
// SUPABASE (REST)
// ---------------------------------------------------------------------------
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 409) throw new Error(`Supabase ${method} ${path} → ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fetchActiveCompanies() {
  return (await sb('companies?active=eq.true&select=*')) || [];
}

async function insertInterviews(rows) {
  if (!rows.length) return;
  await sb('pr_interviews', {
    method: 'POST', body: rows,
    prefer: 'resolution=ignore-duplicates,return=minimal',
  });
}

const IV_FIELDS = 'interviewee_name,interviewee_role,is_ceo,format,source_tier,weight,published_at';

async function fetchWindowInterviews(companyId) {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const path = `pr_interviews?company_id=eq.${companyId}` +
    `&published_at=gte.${since}&select=${IV_FIELDS}`;
  return (await sb(path)) || [];
}

// Toutes les prises de parole d'une entreprise (mode reconstruction).
async function fetchAllInterviews(companyId) {
  return (await sb(`pr_interviews?company_id=eq.${companyId}&select=${IV_FIELDS}&limit=5000`)) || [];
}

// ---------------------------------------------------------------------------
// CALCUL DE L'INDICE DE PRÉSENCE
// ---------------------------------------------------------------------------
function recency(ageDays) {
  return Math.max(RECENCY_FLOOR, 1 - ageDays / WINDOW_DAYS);
}

function computeIndex(interviews, now = Date.now()) {
  let score = 0, tier1 = 0, podcast = 0, social = 0;
  const people = new Map();

  for (const iv of interviews) {
    const age = iv.published_at ? Math.max(0, (now - new Date(iv.published_at).getTime()) / 86400000) : WINDOW_DAYS;
    score += (iv.weight || POINTS_BASE) * recency(age);
    if (iv.source_tier === 1) tier1++;
    if (iv.format === 'podcast') podcast++;
    if (iv.format === 'reseau social') social++;
    if (iv.interviewee_name) {
      const key = iv.interviewee_name;
      const p = people.get(key) || { name: key, role: iv.interviewee_role, count: 0 };
      p.count++; people.set(key, p);
    }
  }

  const topPeople = [...people.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  return {
    index_value: Math.round(score * 10) / 10,
    interview_count: interviews.length,
    tier1_count: tier1,
    podcast_count: podcast,
    social_count: social,
    people_count: people.size,
    top_people: topPeople,
    components: { formula: 'Σ base×média×format×récence', base: POINTS_BASE, window_days: WINDOW_DAYS },
  };
}

async function upsertSnapshots(rows) {
  if (!rows.length) return;
  // par lots, pour ne pas envoyer des milliers de lignes d'un coup
  for (let i = 0; i < rows.length; i += 200) {
    await sb('pr_index_snapshots?on_conflict=company_id,as_of_date', {
      method: 'POST', body: rows.slice(i, i + 200),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }
}

async function upsertSnapshot(companyId, metrics, asOfDate) {
  await upsertSnapshots([{
    company_id: companyId,
    as_of_date: asOfDate || new Date().toISOString().slice(0, 10),
    window_days: WINDOW_DAYS,
    ...metrics,
  }]);
}

// ---------------------------------------------------------------------------
// TRAITEMENT D'UNE ENTREPRISE
// ---------------------------------------------------------------------------
function queriesFor(company) {
  const baseName = company.news_query || company.name;
  const queries = [];
  // PDG : requête LARGE sur son nom (on filtre ensuite localement les vraies
  // prises de parole), pour ne pas rater les titres sans le mot « interview »
  // (« … fait le point … », citations entre guillemets, etc.).
  if (company.ceo_name) queries.push(`"${company.ceo_name}"`);
  // Autres dirigeants : requête ciblée interview/podcast (précision).
  queries.push(`"${baseName}" (PDG OR "directeur général" OR dirigeant OR patron) (interview OR entretien OR podcast OR "propos recueillis")`);
  return queries;
}

// Collecte les prises de parole d'une entreprise sur une période donnée
// (`range` = null pour la fenêtre courante). Renvoie { rows, anyFetchOk, scanned }.
async function collect(company, range) {
  const seen = new Set();
  const rows = [];
  let anyFetchOk = false, scanned = 0;

  for (const q of queriesFor(company)) {
    const { items, ok } = await fetchNews(q, range);
    if (ok) anyFetchOk = true;
    scanned += items.length;
    for (const it of items) {
      if (seen.has(it.link)) continue;
      seen.add(it.link);

      const det = detectInterview(it, company);
      if (!det) continue;

      const published = it.pubDate ? new Date(it.pubDate) : null;
      rows.push({
        company_id: company.id,
        url: it.link,
        title: it.title,
        source: it.source || null,
        published_at: published && !isNaN(published) ? published.toISOString() : null,
        ...det,
        raw: { source: it.source, pubDate: it.pubDate },
      });
    }
    await sleep(REQUEST_DELAY_MS);
  }
  return { rows, anyFetchOk, scanned };
}

async function processCompany(company) {
  const { rows, anyFetchOk, scanned } = await collect(company, null);

  // Collecte entièrement KO : on n'écrit AUCUN snapshot. Écrire 0 ici
  // effacerait le score réel de l'entreprise sur la foi d'un simple throttling.
  if (!anyFetchOk) {
    console.error(`  ${company.name}: collecte échouée — snapshot NON écrit (score précédent conservé).`);
    return null;
  }

  await insertInterviews(rows);

  const windowIvs = await fetchWindowInterviews(company.id);
  const metrics = computeIndex(windowIvs);
  await upsertSnapshot(company.id, metrics);

  console.log(
    `  ${company.name}: ${scanned} titre(s) examiné(s) → ${rows.length} prise(s) de parole, présence ${metrics.index_value} ` +
    `(${metrics.interview_count} sur 90j, ${metrics.tier1_count} tier-1, ${metrics.podcast_count} podcast, ${metrics.people_count} dirigeant·es).`
  );
  return metrics;
}

// ---------------------------------------------------------------------------
// RECONSTRUCTION HISTORIQUE (--since YYYY-MM-DD)
//
// Chaque prise de parole est stockée avec sa date de publication : le score
// d'un jour passé J est donc recalculable — c'est la somme des prises de parole
// publiées dans les 90 j précédant J, avec la récence mesurée par rapport à J.
// On complète d'abord la base en interrogeant Google News par fenêtres
// mensuelles (`after:`/`before:`), puis on réécrit un snapshot par jour.
//
// ⚠️ C'est une RECONSTRUCTION : elle montre le score qu'on aurait mesuré avec ce
// que Google News indexe *aujourd'hui*. Les articles dépubliés ou désindexés
// depuis n'y figurent pas, et la couverture se dégrade en remontant le temps.
// ---------------------------------------------------------------------------
function monthWindows(sinceDate, untilDate) {
  const windows = [];
  let cur = new Date(sinceDate);
  while (cur < untilDate) {
    const next = new Date(cur);
    next.setMonth(next.getMonth() + 1);
    const end = next < untilDate ? next : untilDate;
    windows.push({ after: cur.toISOString().slice(0, 10), before: end.toISOString().slice(0, 10) });
    cur = next;
  }
  return windows;
}

async function backfillCompany(company, sinceDate, untilDate) {
  // 1. compléter la base sur les périodes anciennes (au-delà de la fenêtre courante)
  const windows = monthWindows(sinceDate, untilDate);
  let collected = 0, fetchOk = false;
  for (const w of windows) {
    const { rows, anyFetchOk } = await collect(company, w);
    if (anyFetchOk) fetchOk = true;
    await insertInterviews(rows);
    collected += rows.length;
  }
  if (!fetchOk) {
    console.error(`  ${company.name}: collecte historique échouée — snapshots inchangés.`);
    return 0;
  }

  // 2. recalculer un snapshot par jour, de `since` à aujourd'hui
  const all = await fetchAllInterviews(company.id);
  const snapshots = [];
  for (let d = new Date(sinceDate); d <= untilDate; d.setDate(d.getDate() + 1)) {
    const asOf = d.getTime();
    const windowStart = asOf - WINDOW_DAYS * 86400000;
    const inWindow = all.filter((iv) => {
      if (!iv.published_at) return false;
      const t = new Date(iv.published_at).getTime();
      return t > windowStart && t <= asOf;
    });
    snapshots.push({
      company_id: company.id,
      as_of_date: new Date(asOf).toISOString().slice(0, 10),
      window_days: WINDOW_DAYS,
      backfilled: true,
      ...computeIndex(inWindow, asOf),
    });
  }
  await upsertSnapshots(snapshots);
  console.log(`  ${company.name}: +${collected} prise(s) de parole historiques, ${snapshots.length} jour(s) reconstitué(s).`);
  return snapshots.length;
}

async function runBackfill(sinceStr) {
  const sinceDate = new Date(sinceStr + 'T00:00:00Z');
  if (isNaN(sinceDate)) throw new Error(`Date invalide : « ${sinceStr} » (format attendu : YYYY-MM-DD)`);
  const untilDate = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  if (sinceDate >= untilDate) throw new Error('La date de départ doit être dans le passé.');

  const companies = await fetchActiveCompanies();
  const windows = monthWindows(sinceDate, untilDate).length;
  console.log(
    `Reconstruction depuis le ${sinceStr} pour ${companies.length} entreprise(s) ` +
    `(${windows} fenêtre(s) mensuelle(s) — comptez ~${Math.round(companies.length * windows * 2 * REQUEST_DELAY_MS / 60000)} min).`
  );

  let days = 0;
  for (const company of companies) {
    try { days += await backfillCompany(company, sinceDate, untilDate); }
    catch (err) { console.error(`  ${company.name}: échec — ${err.message}`); }
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`\nTerminé. ${days} point(s) d'indice reconstitué(s).`);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Variables d'environnement manquantes: ${missing.join(', ')}`);

  // Mode reconstruction : `node pr-scanner.mjs --since 2026-03-01`
  const sinceArg = process.argv.find((a) => a.startsWith('--since'));
  if (sinceArg) {
    const value = sinceArg.includes('=')
      ? sinceArg.split('=')[1]
      : process.argv[process.argv.indexOf(sinceArg) + 1];
    return runBackfill(value);
  }

  const companies = await fetchActiveCompanies();
  if (!companies.length) {
    console.log('Aucune entreprise active. Ajoute des lignes dans `companies` (voir schema-pr.sql / seed-cac40.sql).');
    return;
  }

  console.log(`Indice de présence média pour ${companies.length} entreprise(s)...`);
  let ok = 0, failed = 0, withSpeech = 0;
  for (const company of companies) {
    try {
      const m = await processCompany(company);
      if (m === null) failed++;
      else { ok++; if (m.interview_count > 0) withSpeech++; }
    } catch (err) {
      failed++;
      console.error(`  ${company.name}: échec — ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `\nTerminé. ${ok}/${companies.length} entreprise(s) mises à jour, ` +
    `${withSpeech} avec au moins une prise de parole, ${failed} en échec de collecte.`
  );
  if (failed > companies.length / 4) {
    console.warn(
      '⚠ Beaucoup d\'échecs de collecte : Google News limite probablement le débit ' +
      'depuis ce runner. Augmente REQUEST_DELAY_MS en tête de pr-scanner.mjs, ou relance plus tard.'
    );
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) main().catch((err) => { console.error(err); process.exit(1); });

export { detectInterview, sourceTier, detectFormat, detectRole, computeIndex, parseRss, normalize, monthWindows };
