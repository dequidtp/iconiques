-- Seed : les 40 valeurs du CAC 40 comme entreprises suivies par l'indice RP.
-- À exécuter UNE FOIS dans le SQL Editor de Supabase, APRÈS schema-pr.sql.
-- Ré-exécutable : `on conflict (slug) do nothing` ⇒ n'écrase pas tes retouches.
--
-- ⚠️ La composition du CAC 40 et surtout les PDG bougent (plusieurs changements
-- récents : Stellantis, Schneider, Renault, Kering, Vinci…). `ceo_name` sert à
-- repérer les interviews : vérifie/corrige-le si un dirigeant a changé. Les
-- alias contiennent le nom de famille seul (les titres de presse citent souvent
-- « Interview de Pouyanné » sans le prénom) — les accents n'ont pas d'importance,
-- le scanner les normalise.

insert into companies (name, slug, ceo_name, ceo_aliases, ticker, news_query, aliases) values
  ('Accor',                        'accor',            'Sébastien Bazin',     '["Bazin"]',                  'AC.PA',    null,              null),
  ('Air Liquide',                  'air-liquide',      'François Jackow',     '["Jackow"]',                 'AI.PA',    null,              null),
  ('Airbus',                       'airbus',           'Guillaume Faury',     '["Faury"]',                  'AIR.PA',   null,              null),
  ('ArcelorMittal',                'arcelormittal',    'Aditya Mittal',       '["Mittal"]',                 'MT.PA',    null,              null),
  ('AXA',                          'axa',              'Thomas Buberl',       '["Buberl"]',                 'CS.PA',    null,              null),
  ('BNP Paribas',                  'bnp-paribas',      'Jean-Laurent Bonnafé','["Bonnafé","Bonnafe"]',      'BNP.PA',   null,              '["BNP"]'),
  ('Bouygues',                     'bouygues',         'Olivier Roussat',     '["Roussat"]',                'EN.PA',    null,              null),
  ('Bureau Veritas',               'bureau-veritas',   'Hinda Gharbi',        '["Gharbi"]',                 'BVI.PA',   null,              null),
  ('Capgemini',                    'capgemini',        'Aiman Ezzat',         '["Ezzat"]',                  'CAP.PA',   null,              null),
  ('Carrefour',                    'carrefour',        'Alexandre Bompard',   '["Bompard"]',                'CA.PA',    null,              null),
  ('Crédit Agricole',              'credit-agricole',  'Philippe Brassac',    '["Brassac"]',                'ACA.PA',   'Crédit Agricole', null),
  ('Danone',                       'danone',           'Antoine de Saint-Affrique','["Saint-Affrique"]',    'BN.PA',    null,              null),
  ('Dassault Systèmes',            'dassault-systemes','Pascal Daloz',        '["Daloz"]',                  'DSY.PA',   null,              null),
  ('Edenred',                      'edenred',          'Bertrand Dumazy',     '["Dumazy"]',                 'EDEN.PA',  null,              null),
  ('Engie',                        'engie',            'Catherine MacGregor', '["MacGregor"]',              'ENGI.PA',  null,              null),
  ('EssilorLuxottica',             'essilorluxottica', 'Francesco Milleri',   '["Milleri"]',                'EL.PA',    null,              '["Essilor"]'),
  ('Eurofins Scientific',          'eurofins',         'Gilles Martin',       '["Martin"]',                 'ERF.PA',   'Eurofins',        null),
  ('Hermès',                       'hermes',           'Axel Dumas',          '["Dumas"]',                  'RMS.PA',   'Hermès',          null),
  ('Kering',                       'kering',           'Luca de Meo',         '["de Meo","Pinault"]',       'KER.PA',   null,              '["Gucci"]'),
  ('L''Oréal',                     'loreal',           'Nicolas Hieronimus',  '["Hieronimus"]',             'OR.PA',    'L''Oréal',        null),
  ('Legrand',                      'legrand',          'Benoît Coquart',      '["Coquart"]',                'LR.PA',    null,              null),
  ('LVMH',                         'lvmh',             'Bernard Arnault',     '["Arnault"]',                'MC.PA',    null,              '["Louis Vuitton"]'),
  ('Michelin',                     'michelin',         'Florent Menegaux',    '["Menegaux"]',               'ML.PA',    null,              null),
  ('Orange',                       'orange',           'Christel Heydemann',  '["Heydemann"]',              'ORA.PA',   'Orange télécoms', '["Orange SA"]'),
  ('Pernod Ricard',                'pernod-ricard',    'Alexandre Ricard',    '["Ricard"]',                 'RI.PA',    null,              null),
  ('Publicis',                     'publicis',         'Arthur Sadoun',       '["Sadoun"]',                 'PUB.PA',   null,              null),
  ('Renault',                      'renault',          'François Provost',    '["Provost","de Meo"]',       'RNO.PA',   null,              null),
  ('Safran',                       'safran',           'Olivier Andriès',     '["Andriès","Andries"]',      'SAF.PA',   null,              null),
  ('Saint-Gobain',                 'saint-gobain',     'Benoit Bazin',        '["Bazin"]',                  'SGO.PA',   null,              null),
  ('Sanofi',                       'sanofi',           'Paul Hudson',         '["Hudson"]',                 'SAN.PA',   null,              null),
  ('Schneider Electric',           'schneider',        'Olivier Blum',        '["Blum"]',                   'SU.PA',    null,              null),
  ('Société Générale',             'societe-generale', 'Slawomir Krupa',      '["Krupa"]',                  'GLE.PA',   'Société Générale',null),
  ('Stellantis',                   'stellantis',       'Antonio Filosa',      '["Filosa"]',                 'STLAP.PA', null,              '["Peugeot","Citroën"]'),
  ('STMicroelectronics',           'stmicroelectronics','Jean-Marc Chery',    '["Chery"]',                  'STMPA.PA', null,              '["STMicro"]'),
  ('Teleperformance',              'teleperformance',  'Daniel Julien',       '["Julien"]',                 'TEP.PA',   null,              null),
  ('Thales',                       'thales',           'Patrice Caine',       '["Caine"]',                  'HO.PA',    null,              null),
  ('TotalEnergies',                'totalenergies',    'Patrick Pouyanné',    '["Pouyanné","Pouyanne"]',    'TTE.PA',   null,              '["Total"]'),
  ('Unibail-Rodamco-Westfield',    'unibail',          'Jean-Marie Tritant',  '["Tritant"]',                'URW.PA',   null,              '["Unibail","URW"]'),
  ('Veolia',                       'veolia',           'Estelle Brachlianoff','["Brachlianoff"]',           'VIE.PA',   null,              null),
  ('Vinci',                        'vinci',            'Xavier Huillard',     '["Huillard","Anjolras"]',    'DG.PA',    null,              null)
on conflict (slug) do nothing;
