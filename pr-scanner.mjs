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
const RECENCY_FLOOR = 0.25;     // une vieille interview compte encore un peu
const REQUEST_DELAY_MS = 1200;

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

// Une citation entre guillemets dans le titre = presque toujours une prise de parole.
function hasQuote(title) {
  return /[«»“”]/.test(title) || /"[^"]{8,}"/.test(title);
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

function detectFormat(text) {
  const t = normalize(text);
  if (t.includes('podcast') || t.includes('au micro')) return 'podcast';
  if (t.includes('grand entretien')) return 'grand entretien';
  if (t.includes('entretien')) return 'entretien';
  return 'interview';
}

function formatWeight(format) {
  if (format === 'podcast') return PODCAST_WEIGHT;
  if (format === 'grand entretien') return LONGFORM_WEIGHT;
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

  const strong = STRONG_MARKERS.some((m) => nt.includes(normalize(m)));
  const soft = SOFT_MARKERS.some((m) => nt.includes(normalize(m)));
  const quote = hasQuote(title);

  const tier = sourceTier(item.source);
  const format = detectFormat(blob);
  const ceoNames = ceoNamesOf(company);
  const ceoHit = ceoNames.find((n) => n && nt.includes(normalize(n)));

  let interviewee = null, role = null, isCeo = false;

  if (ceoHit) {
    // PDG connu : marqueur fort OU souple OU citation entre guillemets.
    // (sinon le PDG est juste cité dans un article, il ne s'exprime pas)
    if (!(strong || soft || quote)) return null;
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
function newsRssUrl(query) {
  const q = encodeURIComponent(`${query} when:${WINDOW_DAYS}d`);
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

async function fetchNews(query) {
  const res = await fetch(newsRssUrl(query), {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; iconiques-pr-index/2.0)' },
  });
  if (!res.ok) { console.error(`  Google News ${res.status} pour « ${query} »`); return []; }
  return parseRss(await res.text());
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

async function fetchWindowInterviews(companyId) {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const path = `pr_interviews?company_id=eq.${companyId}` +
    `&published_at=gte.${since}` +
    `&select=interviewee_name,interviewee_role,is_ceo,format,source_tier,weight,published_at`;
  return (await sb(path)) || [];
}

// ---------------------------------------------------------------------------
// CALCUL DE L'INDICE DE PRÉSENCE
// ---------------------------------------------------------------------------
function recency(ageDays) {
  return Math.max(RECENCY_FLOOR, 1 - ageDays / WINDOW_DAYS);
}

function computeIndex(interviews, now = Date.now()) {
  let score = 0, tier1 = 0, podcast = 0;
  const people = new Map();

  for (const iv of interviews) {
    const age = iv.published_at ? Math.max(0, (now - new Date(iv.published_at).getTime()) / 86400000) : WINDOW_DAYS;
    score += (iv.weight || POINTS_BASE) * recency(age);
    if (iv.source_tier === 1) tier1++;
    if (iv.format === 'podcast') podcast++;
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
    people_count: people.size,
    top_people: topPeople,
    components: { formula: 'Σ base×média×format×récence', base: POINTS_BASE, window_days: WINDOW_DAYS },
  };
}

async function upsertSnapshot(companyId, metrics) {
  const row = {
    company_id: companyId,
    as_of_date: new Date().toISOString().slice(0, 10),
    window_days: WINDOW_DAYS,
    ...metrics,
  };
  await sb('pr_index_snapshots?on_conflict=company_id,as_of_date', {
    method: 'POST', body: row,
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

// ---------------------------------------------------------------------------
// TRAITEMENT D'UNE ENTREPRISE
// ---------------------------------------------------------------------------
async function processCompany(company) {
  const baseName = company.news_query || company.name;
  const queries = [];
  // PDG : requête LARGE sur son nom (on filtre ensuite localement les vraies
  // prises de parole), pour ne pas rater les titres sans le mot « interview »
  // (« … fait le point … », citations entre guillemets, etc.).
  if (company.ceo_name) queries.push(`"${company.ceo_name}"`);
  // Autres dirigeants : requête ciblée interview/podcast (précision).
  queries.push(`"${baseName}" (PDG OR "directeur général" OR dirigeant OR patron) (interview OR entretien OR podcast OR "propos recueillis")`);

  const seen = new Set();
  const rows = [];

  for (const q of queries) {
    for (const it of await fetchNews(q)) {
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

  await insertInterviews(rows);

  const windowIvs = await fetchWindowInterviews(company.id);
  const metrics = computeIndex(windowIvs);
  await upsertSnapshot(company.id, metrics);

  console.log(
    `  ${company.name}: ${rows.length} prise(s) de parole captée(s), présence ${metrics.index_value} ` +
    `(${metrics.interview_count} sur 90j, ${metrics.tier1_count} tier-1, ${metrics.podcast_count} podcast, ${metrics.people_count} dirigeant·es).`
  );
  return metrics;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Variables d'environnement manquantes: ${missing.join(', ')}`);

  const companies = await fetchActiveCompanies();
  if (!companies.length) {
    console.log('Aucune entreprise active. Ajoute des lignes dans `companies` (voir schema-pr.sql / seed-cac40.sql).');
    return;
  }

  console.log(`Indice de présence média pour ${companies.length} entreprise(s)...`);
  for (const company of companies) {
    try { await processCompany(company); }
    catch (err) { console.error(`  ${company.name}: échec — ${err.message}`); }
    await sleep(REQUEST_DELAY_MS);
  }
  console.log('Terminé.');
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) main().catch((err) => { console.error(err); process.exit(1); });

export { detectInterview, sourceTier, detectFormat, detectRole, computeIndex, parseRss, normalize };
