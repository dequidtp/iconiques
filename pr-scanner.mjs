// pr-scanner.mjs
// Indice « Relations Publiques » (PR index).
//
// Pour chaque entreprise active (table `companies` de Supabase) :
//   1. récolte les titres d'articles récents via Google News RSS (gratuit, sans clé) ;
//   2. classe le sentiment de chaque titre (positif / négatif / neutre) par lexique ;
//   3. repère les interviews / entretiens du PDG dans un média cible (tier-1) ;
//   4. stocke les articles (table `pr_articles`, dédup par URL) ;
//   5. recalcule UN point d'indice sur la fenêtre glissante (défaut 90 j) et
//      l'enregistre dans `pr_index_snapshots` (un point par entreprise et par jour).
//
// L'indice est centré sur 100 (comme un indice boursier) :
//   balance = (P - N) / (P + N + K)                 K = SMOOTHING, ∈ (-1, 1)
//   bonus   = Σ interviews_tier1 · décroissance_temporelle   (plafonné)
//   indice  = 100 + SENTIMENT_SPAN · balance + bonus
//
// Variables d'environnement requises (voir .github/workflows/scan-pr.yml) :
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// Analyse de sentiment : lexique volontairement simple et déterministe (aucune
// API payante, dans l'esprit du reste du projet). C'est un signal AGRÉGÉ, pas
// une vérité titre par titre. La fonction `scoreSentiment` est isolée et
// exportée : on peut la remplacer par un appel LLM plus tard sans toucher au reste.

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const WINDOW_DAYS = 90;        // fenêtre glissante d'analyse de l'indice
const SMOOTHING = 5;           // K : lissage de la balance (anti petits échantillons)
const SENTIMENT_SPAN = 40;     // amplitude max du sentiment sur l'indice (± points)
const INTERVIEW_POINTS = 6;    // points par interview PDG tier-1 (récente, avant plafond)
const INTERVIEW_BONUS_CAP = 18;// plafond total du bonus interviews (points)
const REQUEST_DELAY_MS = 1200; // courtoisie entre requêtes Google News
const NEUTRAL_BAND = 1.0;      // |score| < NEUTRAL_BAND ⇒ neutre

// Médias « tier-1 » : presse financière / de référence visée par la veille.
// Une interview du PDG dans l'un d'eux est le signal fort demandé.
// La comparaison se fait en minuscules, sans accents, par inclusion.
const TIER1_SOURCES = [
  'investir',
  'les echos',      // couvre "Les Échos"
  'financial times',
  'le monde',
];

// Marqueurs d'interview / entretien dans un titre (FR + EN).
const INTERVIEW_MARKERS = [
  'interview', 'entretien', 'grand entretien', 'confidences', 'confessions',
  'itw', 'face-a-face', 'tribune', 'notre entretien',
];

// Lexique de sentiment (racines, comparaison sur titre normalisé sans accents).
// weight > 0 = bonne presse, weight < 0 = mauvaise presse.
const LEXICON = [
  // --- Positif (FR) ---
  ['record', 2], ['recharge', 0], ['hausse', 2], ['bondit', 2], ['bond ', 1.5],
  ['croissance', 1.5], ['benefice', 2], ['benefices', 2], ['profit', 2],
  ['profits', 2], ['succes', 2], ['reussite', 2], ['rebond', 2], ['rebondit', 2],
  ['dividende', 1.5], ['contrat', 1.5], ['partenariat', 1.5], ['innovation', 1],
  ['lance', 0.8], ['leader', 1], ['surperforme', 2], ['optimiste', 1.5],
  ['dynamique', 1], ['expansion', 1.5], ['acquisition', 0.8], ['prime', 0.5],
  ['releve ', 1.5], ['releve', 1], ['augmente', 1], ['gagne', 1.5], ['gains', 1.5],
  ['salue', 1], ['plebiscite', 2], ['recompense', 1.5], ['prix ', 0.5],
  ['triomphe', 2], ['envole', 2], ['envolee', 2], ['prometteur', 1.5],
  ['solide', 1.2], ['robuste', 1.2], ['fort ', 0.8], ['meilleur', 1.2],
  ['investit', 0.8], ['investissement', 0.8], ['emplois', 0.8], ['embauche', 1],
  ['feu vert', 1.5], ['approuve', 1], ['soutien', 1],
  // --- Positif (EN) ---
  ['surge', 2], ['soar', 2], ['beat', 1.5], ['beats', 1.5], ['rally', 1.5],
  ['growth', 1.5], ['profit ', 2], ['upgrade', 2], ['boost', 1.5], ['win', 1.2],
  ['wins', 1.5], ['strong', 1.2], ['jump', 1.5], ['gain', 1.2], ['outperform', 2],
  ['deal', 0.8], ['expands', 1], ['optimistic', 1.5], ['breakthrough', 1.8],

  // --- Négatif (FR) ---
  ['chute', -2], ['plonge', -2.5], ['plongeon', -2.5], ['effondre', -2.5],
  ['effondrement', -2.5], ['baisse', -1.5], ['recul', -1.5], ['recule', -1.5],
  ['perte', -2], ['pertes', -2], ['deficit', -2], ['licencie', -2],
  ['licenciement', -2], ['licenciements', -2], ['suppression', -1.8],
  ['plan social', -2.5], ['scandale', -3], ['fraude', -3], ['enquete', -2],
  ['perquisition', -2.5], ['plainte', -2], ['proces', -2], ['condamne', -2.5],
  ['condamnation', -2.5], ['amende', -2], ['sanction', -2], ['sanctionne', -2],
  ['avertissement', -2], ['profit warning', -3], ['warning', -2], ['rappel', -1.5],
  ['greve', -2], ['crise', -2], ['faillite', -3], ['dette', -1], ['dettes', -1.2],
  ['polemique', -2], ['boycott', -2.5], ['accuse', -2], ['accusation', -2],
  ['soupcon', -1.8], ['soupcons', -1.8], ['degrade', -2], ['degradation', -2],
  ['abaisse', -1.5], ['inquiet', -1.5], ['inquietude', -1.5], ['menace', -1.5],
  ['echec', -2], ['ferme ', -1.5], ['fermeture', -1.8], ['pollution', -1.8],
  ['pollue', -1.8], ['toxique', -2], ['demission', -1.5], ['demissionne', -1.5],
  ['limoge', -2.5], ['evince', -2.5], ['chute libre', -3], ['risque', -1],
  ['penurie', -1.5], ['coupe', -1], ['coupes', -1.2], ['ralentit', -1.5],
  ['ralentissement', -1.5], ['deroute', -2.5], ['deboire', -2], ['deboires', -2],
  // --- Négatif (EN) ---
  ['plunge', -2.5], ['slump', -2], ['drop', -1.5], ['fall', -1.5], ['loss', -2],
  ['losses', -2], ['lawsuit', -2], ['probe', -2], ['fraud', -3], ['layoff', -2],
  ['layoffs', -2], ['downgrade', -2], ['fine ', -1.5], ['strike', -1.8],
  ['recall', -1.8], ['scandal', -3], ['crash', -2.5], ['slash', -1.8],
  ['sink', -2], ['tumble', -2], ['weak', -1.2], ['cuts', -1.2], ['warns', -2],
  ['bankrupt', -3], ['crisis', -2], ['sued', -2], ['halts', -1.5],
];

// Négations : si présentes juste avant un terme, on inverse (atténué) son signe.
const NEGATIONS = ['pas', 'plus', 'aucun', 'aucune', 'sans', 'ni ', 'no ', 'not ', 'never', 'jamais'];

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// minuscule + suppression des accents (pour matcher le lexique de façon robuste).
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, "'");
}

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')       // retire d'éventuelles balises HTML résiduelles
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// SENTIMENT — score signé d'un titre. Isolé et exporté (remplaçable par un LLM).
// ---------------------------------------------------------------------------
function scoreSentiment(title) {
  const text = ' ' + normalize(title) + ' ';
  let score = 0;
  const matched = [];

  for (const [term, weight] of LEXICON) {
    if (weight === 0) continue;
    let idx = text.indexOf(term);
    if (idx === -1) continue;

    // Vérifie une négation dans les ~18 caractères qui précèdent le terme.
    const before = text.slice(Math.max(0, idx - 18), idx);
    const negated = NEGATIONS.some((n) => before.includes(' ' + n));
    const applied = negated ? -weight * 0.6 : weight;

    score += applied;
    matched.push({ term: term.trim(), weight: applied, negated });
  }

  let label = 'neutral';
  if (score >= NEUTRAL_BAND) label = 'positive';
  else if (score <= -NEUTRAL_BAND) label = 'negative';

  return { score: Math.round(score * 100) / 100, label, matched };
}

// ---------------------------------------------------------------------------
// SOURCES / INTERVIEWS
// ---------------------------------------------------------------------------
function sourceTier(source) {
  const s = normalize(source);
  return TIER1_SOURCES.some((t) => s.includes(t)) ? 1 : 2;
}

// Une interview du PDG = média tier-1 + (nom du PDG dans le titre OU requête
// ciblée interview) + marqueur d'entretien. On renvoie les indices trouvés.
function detectCeoInterview(title, source, ceoNames) {
  const t = normalize(title);
  const tier = sourceTier(source);
  const marker = INTERVIEW_MARKERS.find((m) => t.includes(normalize(m))) || null;
  const ceoHit = (ceoNames || []).find((n) => n && t.includes(normalize(n))) || null;

  const isInterview = tier === 1 && Boolean(marker) && Boolean(ceoHit);
  return {
    is_ceo_interview: isInterview,
    signals: isInterview ? { tier, marker, ceo: ceoHit } : { tier, marker, ceo: ceoHit },
  };
}

// ---------------------------------------------------------------------------
// GOOGLE NEWS RSS
// ---------------------------------------------------------------------------
function newsRssUrl(query) {
  const q = encodeURIComponent(`${query} when:${WINDOW_DAYS}d`);
  return `https://news.google.com/rss/search?q=${q}&hl=fr&gl=FR&ceid=FR:fr`;
}

// Parse le RSS Google News (format régulier) sans dépendance XML.
function parseRss(xml) {
  const items = [];
  const blocks = xml.split(/<item>/).slice(1);
  for (const block of blocks) {
    const chunk = block.split('</item>')[0];
    const pick = (tag) => {
      const m = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? decodeEntities(m[1]) : '';
    };
    let title = pick('title');
    const link = pick('link');
    const pubDate = pick('pubDate');
    // <source url="...">Nom du média</source>
    const sourceMatch = chunk.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    let source = sourceMatch ? decodeEntities(sourceMatch[1]) : '';

    // Google News suffixe souvent le titre par " - Nom du média" : on nettoie
    // et, si <source> est absent, on récupère le média depuis ce suffixe.
    const dashSplit = title.match(/^(.*)\s[-–]\s([^-–]+)$/);
    if (dashSplit) {
      if (!source) source = dashSplit[2].trim();
      if (source && normalize(dashSplit[2]).includes(normalize(source).slice(0, 8))) {
        title = dashSplit[1].trim();
      }
    }

    if (!title || !link) continue;
    items.push({ title, link, pubDate, source });
  }
  return items;
}

async function fetchNews(query) {
  const res = await fetch(newsRssUrl(query), {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; iconiques-pr-index/1.0)' },
  });
  if (!res.ok) {
    console.error(`  Échec Google News (${res.status}) pour « ${query} »`);
    return [];
  }
  return parseRss(await res.text());
}

// ---------------------------------------------------------------------------
// SUPABASE (REST, comme reddit-scanner.mjs — aucune lib cliente)
// ---------------------------------------------------------------------------
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Supabase ${method} ${path} → ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fetchActiveCompanies() {
  return (await sb('companies?active=eq.true&select=*')) || [];
}

// Insère les articles (ignore les doublons via la contrainte unique company_id+url).
async function insertArticles(rows) {
  if (!rows.length) return 0;
  await sb('pr_articles', {
    method: 'POST',
    body: rows,
    prefer: 'resolution=ignore-duplicates,return=minimal',
  });
  return rows.length;
}

// Récupère tous les articles d'une entreprise dans la fenêtre glissante.
async function fetchWindowArticles(companyId) {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const path =
    `pr_articles?company_id=eq.${companyId}` +
    `&published_at=gte.${since}` +
    `&select=sentiment_label,is_ceo_interview,source_tier,published_at`;
  return (await sb(path)) || [];
}

// ---------------------------------------------------------------------------
// CALCUL DE L'INDICE
// ---------------------------------------------------------------------------
function computeIndex(articles, now = Date.now()) {
  let P = 0, N = 0, Z = 0;
  let interviewBonus = 0;
  let interviewCount = 0;

  for (const a of articles) {
    if (a.sentiment_label === 'positive') P++;
    else if (a.sentiment_label === 'negative') N++;
    else Z++;

    if (a.is_ceo_interview && a.source_tier === 1) {
      interviewCount++;
      const ageDays = a.published_at
        ? Math.max(0, (now - new Date(a.published_at).getTime()) / 86400000)
        : WINDOW_DAYS;
      const decay = Math.max(0, 1 - ageDays / WINDOW_DAYS); // récent = poids fort
      interviewBonus += INTERVIEW_POINTS * decay;
    }
  }

  interviewBonus = Math.min(interviewBonus, INTERVIEW_BONUS_CAP);
  const balance = (P - N) / (P + N + SMOOTHING);
  const ratio = N > 0 ? P / N : P; // ratio positif/négatif demandé
  const indexValue = 100 + SENTIMENT_SPAN * balance + interviewBonus;

  return {
    index_value: Math.round(indexValue * 10) / 10,
    sentiment_balance: Math.round(balance * 1000) / 1000,
    ratio_pos_neg: Math.round(ratio * 100) / 100,
    positive_count: P,
    negative_count: N,
    neutral_count: Z,
    article_count: P + N + Z,
    interview_count: interviewCount,
    interview_bonus: Math.round(interviewBonus * 10) / 10,
    components: {
      formula: '100 + 40*balance + bonus',
      smoothing: SMOOTHING,
      sentiment_span: SENTIMENT_SPAN,
      window_days: WINDOW_DAYS,
    },
  };
}

async function upsertSnapshot(companyId, metrics) {
  const row = {
    company_id: companyId,
    as_of_date: new Date().toISOString().slice(0, 10),
    window_days: WINDOW_DAYS,
    ...metrics,
  };
  // merge-duplicates + unique(company_id, as_of_date) ⇒ re-run du jour = update.
  await sb('pr_index_snapshots?on_conflict=company_id,as_of_date', {
    method: 'POST',
    body: row,
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

// ---------------------------------------------------------------------------
// TRAITEMENT D'UNE ENTREPRISE
// ---------------------------------------------------------------------------
function ceoNamesOf(company) {
  const names = [];
  if (company.ceo_name) names.push(company.ceo_name);
  if (Array.isArray(company.ceo_aliases)) names.push(...company.ceo_aliases);
  return names;
}

async function processCompany(company) {
  const ceoNames = ceoNamesOf(company);
  const baseQuery = company.news_query || company.name;

  // Deux requêtes : la veille générale, + une requête ciblée interviews du PDG.
  const queries = [baseQuery];
  if (company.ceo_name) {
    queries.push(`"${company.ceo_name}" (interview OR entretien)`);
  }

  const seen = new Set();
  const rows = [];

  for (const q of queries) {
    const items = await fetchNews(q);
    for (const it of items) {
      if (seen.has(it.link)) continue;
      seen.add(it.link);

      const sentiment = scoreSentiment(it.title);
      const interview = detectCeoInterview(it.title, it.source, ceoNames);
      const tier = sourceTier(it.source);
      const published = it.pubDate ? new Date(it.pubDate) : null;

      rows.push({
        company_id: company.id,
        url: it.link,
        title: it.title,
        source: it.source || null,
        source_tier: tier,
        published_at: published && !isNaN(published) ? published.toISOString() : null,
        sentiment_score: sentiment.score,
        sentiment_label: sentiment.label,
        matched_terms: sentiment.matched,
        is_ceo_interview: interview.is_ceo_interview,
        interview_signals: interview.signals,
        raw: { source: it.source, pubDate: it.pubDate },
      });
    }
    await sleep(REQUEST_DELAY_MS);
  }

  await insertArticles(rows);

  // Recalcule l'indice sur toute la fenêtre (anciens + nouveaux articles en DB).
  const windowArticles = await fetchWindowArticles(company.id);
  const metrics = computeIndex(windowArticles);
  await upsertSnapshot(company.id, metrics);

  console.log(
    `  ${company.name}: ${rows.length} titre(s) captés, indice ${metrics.index_value} ` +
    `(P${metrics.positive_count}/N${metrics.negative_count}/Z${metrics.neutral_count}, ` +
    `${metrics.interview_count} interview(s) PDG).`
  );
  return metrics;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Variables d'environnement manquantes: ${missing.join(', ')}`);
  }

  const companies = await fetchActiveCompanies();
  if (!companies.length) {
    console.log('Aucune entreprise active. Ajoute des lignes dans la table `companies` (voir schema-pr.sql).');
    return;
  }

  console.log(`Calcul de l'indice RP pour ${companies.length} entreprise(s)...`);
  for (const company of companies) {
    try {
      await processCompany(company);
    } catch (err) {
      console.error(`  ${company.name}: échec — ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  console.log('Terminé.');
}

const isEntrypoint = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { scoreSentiment, detectCeoInterview, sourceTier, computeIndex, parseRss, normalize };
