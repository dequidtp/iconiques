// reddit-scanner.mjs
// Scanne des subreddits ciblés, filtre les posts image qui dépassent un seuil
// de score, ENRICHIT chaque candidat (photographe présumé, lieu, date de prise
// de vue, source presse...) puis pousse le tout dans Supabase (table `photos`,
// status='candidate').
//
// Auth Reddit : grant "client_credentials" (application-only), pas besoin d'un
// compte utilisateur — adapté à un usage perso/non-commercial en lecture seule.
//
// Variables d'environnement requises (voir .github/workflows/scan-reddit.yml) :
//   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

import exifr from 'exifr';

const {
  REDDIT_CLIENT_ID,
  REDDIT_CLIENT_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

// Remplace CHANGE_ME par ton pseudo Reddit — Reddit exige un User-Agent identifiable.
const USER_AGENT = 'script:iconiques-scanner:v1.0 (by /u/CHANGE_ME)';

// Subreddits surveillés — à ajuster selon les zones qui t'intéressent.
const SUBREDDITS = [
  'pics',
  'worldnews',
  'PublicFreakout',
  'HumanRights',
  'geopolitics',
  'Damnthatsinteresting',
];

const MIN_SCORE = 3000;     // seuil d'upvotes pour être retenu comme candidat
const TIME_WINDOW = 'day';  // hour | day | week | month
const REQUEST_DELAY_MS = 1100; // reste largement sous 100 req/min (limite free tier)

const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // garde-fou téléchargement image (~12 Mo)
const IMAGE_TIMEOUT_MS = 15000;
const COMMENTS_TO_SCAN = 60;              // nb de commentaires top parcourus par post

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getRedditToken() {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization:
        'Basic ' +
        Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`Échec auth Reddit: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

function isDirectImage(post) {
  const url = post.url || '';
  if (/\.(jpe?g|png|webp)$/i.test(url)) return true;
  if (url.includes('i.redd.it') || url.includes('i.imgur.com')) return true;
  return false;
}

async function fetchSubredditTop(token, subreddit) {
  const url = `https://oauth.reddit.com/r/${subreddit}/top.json?t=${TIME_WINDOW}&limit=50`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
    },
  });

  if (!res.ok) {
    console.error(`Échec fetch r/${subreddit}: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.data.children.map((c) => c.data);
}

// ---------------------------------------------------------------------------
// ENRICHISSEMENT — récolte un maximum d'infos sur une photo candidate.
// Toutes les pistes sont PRÉSUMÉES (à vérifier à la main dans le dashboard).
// ---------------------------------------------------------------------------

// Agences / crédits presse fréquents — repérés dans le texte pour signaler une
// source pro (fort indice de droits à clarifier).
const AGENCIES = [
  'Reuters', 'AFP', 'Getty', 'Getty Images', 'Associated Press', 'AP Photo',
  'EPA', 'Anadolu', 'NurPhoto', 'Magnum', 'SIPA', 'Zuma', 'Shutterstock',
  'Bloomberg', 'AFP/Getty', 'AP', 'Xinhua', 'Middle East Images',
];

// Domaines à ignorer comme "source presse" (plateformes de partage, pas l'origine).
const IGNORED_LINK_HOSTS = [
  'reddit.com', 'redd.it', 'imgur.com', 'i.imgur.com', 'i.redd.it',
  'redditmedia.com', 'reddituploads.com', 'youtube.com', 'youtu.be',
  'twitter.com', 'x.com', 'wikipedia.org', 'google.com', 'bing.com',
  'tineye.com', 'imgs.xkcd.com',
];

// Patterns de crédit photo dans le texte libre (titre + commentaires).
// On capture 1 à 3 mots capitalisés après le marqueur.
// Séparateur inter-mots = espaces/tabs uniquement (jamais de saut de ligne, sinon
// on aspirerait le mot capitalisé du début de la phrase suivante). Lettres
// accentuées autorisées dans le corps du nom.
const NAME = "([A-ZÀ-Ý][\\w.'’\\-À-ÿ]*(?:[ \\t]+[A-ZÀ-Ý][\\w.'’\\-À-ÿ]*){0,3})";
const CREDIT_PATTERNS = [
  new RegExp(`(?:photo|image|picture|pic|photograph)\\s*(?:by|credit(?:ed)?\\s*(?:to)?|courtesy of)\\s*[:\\-–]?\\s*${NAME}`, 'i'),
  new RegExp(`credit[s]?\\s*[:\\-–]\\s*${NAME}`, 'i'),
  new RegExp(`©\\s*${NAME}`),
  new RegExp(`(?:shot|taken|captured)\\s+by\\s+${NAME}`, 'i'),
  new RegExp(`photographer\\s*[:\\-–]?\\s*${NAME}`, 'i'),
  new RegExp(`\\bby\\s+${NAME}\\s*[/|]\\s*(?:${AGENCIES.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i'),
];

function cleanName(s) {
  if (!s) return null;
  const t = s.trim().replace(/[\s,.;:]+$/, '');
  // rejette les "faux positifs" trop courts ou tout en minuscule
  if (t.length < 3) return null;
  if (!/[A-ZÀ-Ý]/.test(t[0])) return null;
  return t;
}

// Extrait crédits, agences et liens presse depuis un texte libre (titre + commentaires).
function extractFromText(text) {
  const out = { credits: [], agencies: [], links: [] };
  if (!text) return out;

  for (const re of CREDIT_PATTERNS) {
    const m = text.match(re);
    const name = m && cleanName(m[1]);
    if (name && !out.credits.includes(name)) out.credits.push(name);
  }

  for (const a of AGENCIES) {
    const re = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(text) && !out.agencies.some((x) => x.toLowerCase() === a.toLowerCase())) {
      out.agencies.push(a);
    }
  }

  const urlRe = /https?:\/\/[^\s)\]}"'<>]+/gi;
  for (const raw of text.match(urlRe) || []) {
    let host;
    try { host = new URL(raw).hostname.replace(/^www\./, ''); } catch { continue; }
    if (IGNORED_LINK_HOSTS.some((h) => host === h || host.endsWith('.' + h))) continue;
    const url = raw.replace(/[.,);\]]+$/, '');
    if (!out.links.includes(url)) out.links.push(url);
  }

  return out;
}

// Récupère les commentaires top d'un post et renvoie leur texte concaténé.
async function fetchCommentsText(token, permalink) {
  const url = `https://oauth.reddit.com${permalink}.json?limit=${COMMENTS_TO_SCAN}&sort=top&depth=2`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
  });
  if (!res.ok) return '';

  const data = await res.json();
  const listing = Array.isArray(data) ? data[1] : null;
  const bodies = [];

  const walk = (children) => {
    for (const c of children || []) {
      if (c.kind !== 't1' || !c.data) continue;
      if (c.data.body) bodies.push(c.data.body);
      if (c.data.replies && c.data.replies.data) walk(c.data.replies.data.children);
    }
  };
  if (listing && listing.data) walk(listing.data.children);

  return bodies.join('\n');
}

// Télécharge l'image (avec cap taille + timeout) et renvoie un Buffer, ou null.
async function downloadImage(imageUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(imageUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > MAX_IMAGE_BYTES) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return null;
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length && typeof v[0] === 'string') return v[0].trim();
  }
  return null;
}

function toISO(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

// Parse EXIF / IPTC / XMP depuis le buffer image via exifr.
async function extractExif(buf) {
  if (!buf) return {};
  let tags;
  try {
    tags = await exifr.parse(buf, {
      tiff: true, ifd0: true, exif: true, gps: true, iptc: true, xmp: true,
      mergeOutput: true, translateKeys: true, translateValues: true,
    });
  } catch {
    return {};
  }
  if (!tags) return {};

  const artist = firstString(tags.Artist, tags.creator, tags['dc:creator'], tags.Creator);
  const copyright = firstString(tags.Copyright, tags.rights, tags['dc:rights'], tags.Rights);
  const credit = firstString(tags.Credit, tags.credit, tags['photoshop:Credit']);
  const caption = firstString(
    tags.ImageDescription, tags.Caption, tags['Caption-Abstract'],
    tags.description, tags['dc:description'], tags.title,
  );
  const city = firstString(tags.City, tags.city);
  const country = firstString(tags.Country, tags['Country-PrimaryLocationName'], tags.country);
  const location = [city, country].filter(Boolean).join(', ') || null;

  return {
    exif_artist: artist,
    exif_copyright: copyright,
    exif_credit: credit,
    exif_caption: caption ? caption.slice(0, 1000) : null,
    camera_make: firstString(tags.Make),
    camera_model: firstString(tags.Model),
    capture_datetime: toISO(tags.DateTimeOriginal || tags.CreateDate || tags.DateTimeDigitized),
    gps_lat: typeof tags.latitude === 'number' ? tags.latitude : null,
    gps_lon: typeof tags.longitude === 'number' ? tags.longitude : null,
    location_exif: location,
  };
}

// Fusionne toutes les sources en l'objet de colonnes stocké dans Supabase.
function buildEnrichment(post, exif, textFindings) {
  // Meilleure hypothèse de photographe : EXIF > IPTC crédit > commentaire.
  let credited = null;
  let creditSource = null;
  if (exif.exif_artist) { credited = exif.exif_artist; creditSource = 'exif'; }
  else if (exif.exif_credit) { credited = exif.exif_credit; creditSource = 'iptc'; }
  else if (exif.exif_copyright) { credited = exif.exif_copyright; creditSource = 'exif'; }
  else if (textFindings.credits.length) { credited = textFindings.credits[0]; creditSource = 'comment'; }

  const locationGuess = exif.location_exif ||
    (typeof exif.gps_lat === 'number' ? `${exif.gps_lat.toFixed(4)}, ${exif.gps_lon.toFixed(4)}` : null);

  return {
    credited_photographer: credited,
    credit_source: creditSource,
    exif_artist: exif.exif_artist || null,
    exif_copyright: exif.exif_copyright || null,
    exif_credit: exif.exif_credit || null,
    exif_caption: exif.exif_caption || null,
    camera_make: exif.camera_make || null,
    camera_model: exif.camera_model || null,
    capture_datetime: exif.capture_datetime || null,
    gps_lat: exif.gps_lat ?? null,
    gps_lon: exif.gps_lon ?? null,
    location_guess: locationGuess,
    source_links: textFindings.links.length ? textFindings.links.slice(0, 8) : null,
    agencies: textFindings.agencies.length ? textFindings.agencies : null,
    enrichment: {
      comment_credits: textFindings.credits,
      agencies: textFindings.agencies,
      source_links: textFindings.links.slice(0, 8),
      exif_present: Boolean(
        exif.exif_artist || exif.exif_copyright || exif.exif_credit ||
        exif.capture_datetime || exif.gps_lat != null
      ),
    },
    enriched_at: new Date().toISOString(),
  };
}

// Orchestration de l'enrichissement d'un post. Isolé : jamais bloquant.
async function enrichPost(token, post) {
  try {
    const commentsText = await fetchCommentsText(token, post.permalink).catch(() => '');
    const textFindings = extractFromText(`${post.title || ''}\n${commentsText}`);

    const buf = await downloadImage(post.url);
    const exif = await extractExif(buf);

    return buildEnrichment(post, exif, textFindings);
  } catch (err) {
    console.error(`Enrichissement échoué pour ${post.id}: ${err.message}`);
    return { enriched_at: new Date().toISOString(), enrichment: { error: String(err.message) } };
  }
}

async function upsertCandidate(post, enrichment = {}) {
  const row = {
    source_platform: 'reddit',
    reddit_post_id: post.id,
    source_url: `https://reddit.com${post.permalink}`,
    image_url: post.url,
    title: post.title,
    subreddit: post.subreddit,
    score: post.score,
    num_comments: post.num_comments,
    posted_at: new Date(post.created_utc * 1000).toISOString(),
    status: 'candidate',
    ...enrichment,
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/photos`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      // ignore-duplicates s'appuie sur la contrainte unique reddit_post_id :
      // un post déjà vu ne redevient pas "candidate" à chaque run.
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok && res.status !== 409) {
    console.error(`Insert échoué pour ${post.id}: ${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}

async function main() {
  const missing = ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Variables d'environnement manquantes: ${missing.join(', ')}`);
  }

  const token = await getRedditToken();
  let scanned = 0;
  let candidates = 0;
  let enriched = 0;

  for (const subreddit of SUBREDDITS) {
    console.log(`Scan de r/${subreddit}...`);
    const posts = await fetchSubredditTop(token, subreddit);
    scanned += posts.length;

    const matches = posts.filter(
      (p) => isDirectImage(p) && p.score >= MIN_SCORE && !p.over_18
    );

    for (const post of matches) {
      const enrichment = await enrichPost(token, post);
      if (enrichment.credited_photographer || enrichment.location_guess ||
          (enrichment.source_links && enrichment.source_links.length)) {
        enriched++;
      }
      const ok = await upsertCandidate(post, enrichment);
      if (ok) candidates++;
      await sleep(REQUEST_DELAY_MS); // reste courtois avec Reddit entre enrichissements
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `Terminé. ${scanned} posts examinés, ${candidates} candidat(s) traité(s), ` +
    `${enriched} avec au moins une piste (photographe/lieu/source).`
  );
}

// N'exécute le scan que si le fichier est lancé directement (pas à l'import,
// ce qui permet de tester les fonctions d'extraction en isolation).
const isEntrypoint = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { extractFromText, extractExif, buildEnrichment, cleanName };
