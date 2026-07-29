-- Indice « Relations Publiques » (PR index) — schéma Supabase
-- À exécuter dans l'éditeur SQL de ton projet Supabase (SQL Editor > New query).
-- Ré-exécutable sans risque : tout est en "if not exists" / colonnes nullables.
--
-- Objectif : suivre la « good public relations » d'entreprises cotées et en
-- sortir UN CHIFFRE par jour (comme un indice boursier), pour tracer des
-- variations, des moyennes, comparer des sociétés entre elles.
--
-- Trois tables :
--   companies         -> les entreprises suivies (+ nom du PDG, requête news)
--   pr_articles       -> chaque titre d'article capté, avec son sentiment
--   pr_index_snapshots-> UN point d'indice par entreprise et par jour (l'historique)

-- ---------------------------------------------------------------------------
-- 1. Entreprises suivies
-- ---------------------------------------------------------------------------
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,                    -- nom d'affichage, ex: "TotalEnergies"
  slug text unique,                      -- identifiant court, ex: "totalenergies"
  aliases jsonb,                         -- autres orthographes/marques (array de strings)
  ceo_name text,                         -- nom du PDG (sert à repérer ses interviews)
  ceo_aliases jsonb,                     -- variantes du nom du PDG (array)
  ticker text,                           -- ex: "TTE.PA" (indicatif, non utilisé pour le scan)
  news_query text,                       -- requête Google News personnalisée (sinon = name)
  active boolean not null default true,  -- passe à false pour suspendre le suivi
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Articles captés (un titre = une ligne). Le sentiment est PRÉSUMÉ
--    (classé par lexique, voir pr-scanner.mjs) — à considérer comme un signal
--    agrégé, pas comme une vérité article par article.
-- ---------------------------------------------------------------------------
create table if not exists pr_articles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  url text not null,                     -- lien de l'article (clé de dédup)
  title text not null,                   -- titre de l'article
  source text,                           -- média (ex: "Les Échos") tel que fourni par Google News
  source_tier smallint,                  -- 1 = presse cible (Investir/Les Échos/FT/Le Monde), 2 = autre
  published_at timestamptz,              -- date de publication
  captured_at timestamptz not null default now(),

  -- Analyse de sentiment du TITRE
  sentiment_score real,                  -- score brut signé (positif = bonne nouvelle)
  sentiment_label text                   -- 'positive' | 'negative' | 'neutral'
    check (sentiment_label in ('positive','negative','neutral')),
  matched_terms jsonb,                   -- mots-clés qui ont pesé (transparence/debug)

  -- Détection interview / entretien du PDG
  is_ceo_interview boolean not null default false, -- titre = interview du PDG dans un média tier-1
  interview_signals jsonb,               -- indices ayant déclenché le flag

  raw jsonb,                             -- dump brut de l'item RSS
  unique (company_id, url)
);

-- ---------------------------------------------------------------------------
-- 3. Snapshots d'indice — un point par entreprise et par jour.
--    C'est CE QUE tu traces dans le temps (l'« indice boursier RP »).
--    Recalculé à chaque run sur la fenêtre glissante (window_days, défaut 90j).
--
--    Formule (voir pr-scanner.mjs pour l'implémentation) :
--      balance = (P - N) / (P + N + K)          K = lissage (défaut 5), ∈ (-1, 1)
--      bonus   = Σ interviews_tier1 · décroissance_temporelle   (plafonné)
--      indice  = 100 + 40 · balance + bonus
--    → ~100 = neutre, >100 = bonne presse, <100 = mauvaise presse.
-- ---------------------------------------------------------------------------
create table if not exists pr_index_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  as_of_date date not null default current_date,  -- jour du snapshot
  window_days smallint not null default 90,        -- fenêtre glissante utilisée

  index_value real not null,             -- LE chiffre (centré sur 100)
  sentiment_balance real,                -- balance (P-N)/(P+N+K) ∈ (-1,1)
  ratio_pos_neg real,                    -- ratio simple P/N demandé (P/max(N,1))

  positive_count int not null default 0,
  negative_count int not null default 0,
  neutral_count int not null default 0,
  article_count int not null default 0,

  interview_count int not null default 0, -- nb d'interviews PDG tier-1 dans la fenêtre
  interview_bonus real not null default 0,-- points d'indice apportés par ces interviews

  components jsonb,                       -- détail du calcul (transparence)
  computed_at timestamptz not null default now(),

  unique (company_id, as_of_date)        -- un seul point par jour → re-run = mise à jour
);

-- ---------------------------------------------------------------------------
-- Index de performance
-- ---------------------------------------------------------------------------
create index if not exists pr_articles_company_idx on pr_articles (company_id);
create index if not exists pr_articles_published_idx on pr_articles (published_at desc);
create index if not exists pr_articles_interview_idx on pr_articles (company_id, is_ceo_interview);
create index if not exists pr_snapshots_company_date_idx on pr_index_snapshots (company_id, as_of_date desc);

-- ---------------------------------------------------------------------------
-- RLS — même logique que la table photos : lecture publique pour le dashboard,
-- écriture réservée à la clé service_role (le scanner). On NE donne PAS
-- l'écriture à la clé anon ici : le dashboard RP est purement en lecture.
-- ---------------------------------------------------------------------------
alter table companies enable row level security;
alter table pr_articles enable row level security;
alter table pr_index_snapshots enable row level security;

drop policy if exists "pr public read companies" on companies;
create policy "pr public read companies" on companies for select using (true);

drop policy if exists "pr public read articles" on pr_articles;
create policy "pr public read articles" on pr_articles for select using (true);

drop policy if exists "pr public read snapshots" on pr_index_snapshots;
create policy "pr public read snapshots" on pr_index_snapshots for select using (true);

-- (Les INSERT/UPDATE passent par la clé service_role, qui contourne la RLS.)

-- ---------------------------------------------------------------------------
-- Seed d'exemple — DÉCOMMENTE et ADAPTE. Ajoute une ligne par entreprise à
-- suivre. `news_query` est facultatif (par défaut on cherche `name`) : utile
-- pour désambiguïser (ex: "Orange" l'opérateur vs le fruit) ou restreindre.
-- ---------------------------------------------------------------------------
-- insert into companies (name, slug, ceo_name, ceo_aliases, ticker, news_query, aliases) values
--   ('TotalEnergies', 'totalenergies', 'Patrick Pouyanné', '["Pouyanné","Pouyanne"]', 'TTE.PA',
--    'TotalEnergies', '["Total"]'),
--   ('LVMH', 'lvmh', 'Bernard Arnault', '["Arnault"]', 'MC.PA', 'LVMH', '["Louis Vuitton"]'),
--   ('Airbus', 'airbus', 'Guillaume Faury', '["Faury"]', 'AIR.PA', 'Airbus', null)
-- on conflict (slug) do nothing;
