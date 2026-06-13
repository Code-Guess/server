const { openRouterFetch } = require('../openrouter');

const SERPER_API_KEY = process.env.SERPER_KEY;

const ACADEMIC_KW  = ['étude','etude','recherche','article scientifique','papier','pubmed','arxiv','thèse','these','journal','académique','academique','publication','scientifique','selon les études','selon les etudes','recherches montrent','science','preuve'];
const IMAGE_KW     = ['image','photo','illustration','montre','à quoi ressemble','a quoi ressemble','voir une photo','schéma','schema','visuel','montre moi','photos de','images de'];
const WIKIPEDIA_KW = ['wikipedia','définition','definition',"c'est quoi",'kesako','histoire de','biographie','origine de',"qu'est-ce que","qu'est ce que",'signifie','veut dire'];
const REDDIT_KW    = ['reddit','expérience','experience','forum','communauté','communaute','gens pensent',"retour d'expérience","retour d'experience",'témoignage','temoignage','que pensent les gens','avis reddit','opinion reddit','avis des gens'];

// ── Catégories où les images N'apportent RIEN ─────────────────────────────────
const NO_IMAGE_KW = [
  'équation','equation','inéquation','inequation','discriminant','racine','polynôme','polynome','dérivée','derivee',
  'intégrale','integrale','limite','matrice','trinôme','trinome','binôme','binome','factori',
  'développer','developper','simplifier','résoudre','resoudre','calculer','démontrer','demontrer','prouver',
  'tableau de signes','tableau de valeurs','ensemble de définition','ensemble de definition',
  'code','programme','script','fonction','algorithme','bug','erreur','debug',
  'api','backend','frontend','react','python','javascript','typescript',
  'html','css','sql','nodejs','express','composant',
  'dissertation','plan dialectique','thèse','these','antithèse','antithese','synthèse','synthese',
  'argumentation','commenter','rédige','redige','introduction','conclusion',
  'signifie','veut dire','expliquer','pourquoi','comment',
  'loi de','formule','calculer la force','calculer la vitesse',
];

// ── Catégories où les images ont de la valeur ─────────────────────────────────
const YES_IMAGE_KW = [
  'qui est','biographie','portrait','président','president','roi','reine','fondateur',
  'inventeur','scientifique','artiste','acteur','chanteur','musicien',
  'joueur','athlète','athlete','politicien','philosophe','écrivain','ecrivain','auteur',
  'pays','ville','capitale','monument','bâtiment','batiment','tour','pont','fleuve',
  'montagne','continent','carte','région','region','quartier','musée','musee','cathédrale','cathedrale',
  'animal','espèce','espece','plante','fleur','arbre','insecte','oiseau','poisson',
  'mammifère','mammifere','reptile','paysage','nature','forêt','foret','océan','ocean','désert','desert',
  'voiture','téléphone','telephone','appareil','machine','outil','instrument',
  'produit','objet','œuvre','oeuvre','tableau','sculpture','architecture',
  'événement','evenement','catastrophe','manifestation','inauguration','lancement',
  'match','compétition','competition','cérémonie','ceremonie','festival','exposition',
];

const VALID_AGENTS = ['web', 'image', 'academic', 'reddit', 'wikipedia'];

// ── Normalise une string (minuscules + sans accents) ──────────────────────────
function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function hasProperNoun(query) {
  return /[A-ZÀÂÉÈÊËÎÏÔÙÛÜ][a-zàâéèêëîïôùûü]+ [A-ZÀÂÉÈÊËÎÏÔÙÛÜ][a-zàâéèêëîïôùûü]+/.test(query);
}

// ── detectAgent utilise maintenant la même normalisation que detectImageIntent ─
function detectAgent(query) {
  const q = normalize(query);
  if (IMAGE_KW.some(k => q.includes(normalize(k))))     return 'image';
  if (ACADEMIC_KW.some(k => q.includes(normalize(k))))  return 'academic';
  if (REDDIT_KW.some(k => q.includes(normalize(k))))    return 'reddit';
  if (WIKIPEDIA_KW.some(k => q.includes(normalize(k)))) return 'wikipedia';
  return 'web';
}

function detectImageIntent(query) {
  const q = normalize(query);
  if (NO_IMAGE_KW.some(kw => q.includes(normalize(kw))))  return 'none';
  if (YES_IMAGE_KW.some(kw => q.includes(normalize(kw)))) return 'show';
  if (IMAGE_KW.some(kw => q.includes(normalize(kw))))     return 'show';
  return 'none';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeTimeout(ms) {
  // AbortSignal.timeout() requiert Node >= 17.3
  // On vérifie la disponibilité avant d'utiliser
  if (typeof AbortSignal?.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function safeFavicon(link) {
  try {
    return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(link).hostname}`;
  } catch {
    return undefined;
  }
}

// ── rephraseForSearch ─────────────────────────────────────────────────────────
async function rephraseForSearch(query, lang = 'français') {
  if (hasProperNoun(query)) {
    console.log('[rephraseForSearch] Nom propre détecté — requête conservée telle quelle');
    return query;
  }
  try {
    const r = await openRouterFetch({
      model: 'haiku',
      max_tokens: 60,
      temperature: 0,
      messages: [
        { role: 'system', content: `Reformule en requête de recherche courte (3-7 mots) en ${lang}. Réponds UNIQUEMENT avec la requête, sans guillemets ni ponctuation finale.` },
        { role: 'user', content: query },
      ],
    });

    // r.content peut être un array OpenRouter ou une string selon openRouterFetch
    let raw = '';
    if (typeof r?.content === 'string') {
      raw = r.content;
    } else if (Array.isArray(r?.content)) {
      raw = r.content.map(b => b?.text ?? '').join('');
    } else {
      console.warn('[rephraseForSearch] Format de réponse inattendu:', JSON.stringify(r));
      return query;
    }

    const result = raw.trim().replace(/^["']|["']$/g, '').replace(/\.$/, '');
    return result.length > 3 ? result : query;
  } catch (err) {
    console.warn('[rephraseForSearch] LLM error:', err.message);
    return query;
  }
}

// ── fetchImagesForQuery ───────────────────────────────────────────────────────
async function fetchImagesForQuery(query) {
  const q = await rephraseForSearch(query, 'anglais');
  try {
    const images = await wikimediaSearch(q);
    if (images.length > 0) return images;
    return serperImageSearch(q);
  } catch (err) {
    console.warn('[fetchImagesForQuery] error:', err.message);
    return [];
  }
}

async function serperImageSearch(query) {
  if (!SERPER_API_KEY) return [];
  try {
    const res = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_API_KEY },
      body: JSON.stringify({ q: query, num: 8, hl: 'fr', gl: 'fr' }),
      signal: safeTimeout(6000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.images ?? [])
      .filter(img => img.imageUrl && img.title)
      .slice(0, 8)
      .map(img => ({ title: img.title, url: img.link ?? img.imageUrl, img_src: img.imageUrl, type: 'image' }));
  } catch (err) {
    console.warn('[serperImageSearch] error:', err.message);
    return [];
  }
}

// ── Agent Web ─────────────────────────────────────────────────────────────────
async function runWebAgent(query) {
  const intent = detectImageIntent(query);

  const tasks = [rephraseForSearch(query, 'français').then(q => serperSearch(q))];
  if (intent === 'show') tasks.push(fetchImagesForQuery(query));

  const [sources, images = []] = await Promise.all(tasks);

  const contextBlock = sources.length > 0
    ? `\n\n🌐 Résultats web en temps réel :\n${sources.map((s, i) => `[${i+1}] ${s.title}\n${s.snippet ?? ''}\n${s.url}`).join('\n\n')}\n\nBasé-toi sur ces résultats récents. Réponds en français. Cite les sources avec [numéro].`
    : '\n\n(Aucun résultat web — réponds avec tes connaissances en français.)';

  return {
    agent: 'web',
    sources,
    images,
    imageIntent:   intent,
    contextBlock,
    thinkingLabel: sources.length > 0 ? `${sources.length} source(s) web` : 'Réponse directe',
  };
}

async function serperSearch(query) {
  if (!SERPER_API_KEY) {
    console.warn('[WebAgent] SERPER_KEY manquante — fallback DuckDuckGo');
    return duckduckgoInstantAnswer(query);
  }
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_API_KEY },
      body: JSON.stringify({ q: query, num: 8, hl: 'fr', gl: 'fr' }),
      signal: safeTimeout(8000),
    });
    if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
    const data = await res.json();
    const sources = [];

    if (data.answerBox?.answer || data.answerBox?.snippet) {
      sources.push({
        title:    data.answerBox.title ?? query,
        url:      data.answerBox.link ?? '',
        snippet:  data.answerBox.answer ?? data.answerBox.snippet,
        type:     'web',
        featured: true,
      });
    }

    for (const r of (data.organic ?? [])) {
      sources.push({
        title:   r.title ?? '',
        url:     r.link ?? '',
        snippet: r.snippet ?? '',
        img_src: r.imageUrl ?? undefined,
        type:    'web',
        date:    r.date ?? undefined,
        favicon: safeFavicon(r.link), // ← fix crash new URL()
      });
    }

    return sources.filter(s => s.title && s.url).slice(0, 8);
  } catch (err) {
    console.warn('[WebAgent] Serper error:', err.message);
    return duckduckgoInstantAnswer(query);
  }
}

async function duckduckgoInstantAnswer(query) {
  try {
    const encoded = encodeURIComponent(query);
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encoded}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
      { headers: { Accept: 'application/json' }, signal: safeTimeout(6000) }
    );
    const data = await res.json();
    const sources = [];
    if (data.AbstractText && data.AbstractURL) {
      sources.push({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText, type: 'web' });
    }
    for (const t of (data.RelatedTopics ?? []).flatMap(t => t.Topics ? t.Topics : [t])) {
      if (t.FirstURL && t.Text) {
        sources.push({ title: t.Text.slice(0, 90), url: t.FirstURL, snippet: t.Text, type: 'web' });
      }
    }
    return sources.slice(0, 5);
  } catch (err) {
    console.warn('[DuckDuckGo] error:', err.message); // ← plus de catch silencieux
    return [];
  }
}

// ── Agent Image ───────────────────────────────────────────────────────────────
async function runImageAgent(query) {
  const q      = await rephraseForSearch(query, 'anglais');
  const images = await wikimediaSearch(q);

  const contextBlock = images.length > 0
    ? `\n\n🖼️ Images trouvées pour "${q}" :\n${images.map((s, i) => `[${i+1}] ${s.title} — ${s.url}`).join('\n')}\n\nCes images sont affichées dans l'interface. Décris brièvement ce qu'elles montrent en français.`
    : '\n\nAucune image trouvée.';

  return {
    agent:         'image',
    sources:       [],
    images,
    imageIntent:   images.length > 0 ? 'show' : 'none',
    contextBlock,
    thinkingLabel: images.length > 0 ? `${images.length} image(s)` : 'Aucune image',
  };
}

async function wikimediaSearch(query) {
  try {
    const encoded = encodeURIComponent(query);
    const searchRes = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&srnamespace=6&srlimit=12&format=json&origin=*`,
      { signal: safeTimeout(7000) }
    );
    if (!searchRes.ok) throw new Error(`Wikimedia ${searchRes.status}`);
    const searchData = await searchRes.json();
    const titles = (searchData.query?.search ?? [])
      .map(item => item.title)
      .filter(t => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(t));

    if (titles.length === 0) return wikimediaFallbackFromWikipedia(query);

    const titlesParam = titles.slice(0, 8).join('|');
    const infoRes = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(titlesParam)}&prop=imageinfo&iiprop=url|thumburl|extmetadata&iiurlwidth=600&format=json&origin=*`,
      { signal: safeTimeout(7000) }
    );
    if (!infoRes.ok) throw new Error(`Wikimedia info ${infoRes.status}`);
    const infoData = await infoRes.json();

    return Object.values(infoData.query?.pages ?? {})
      .filter(p => p.imageinfo?.[0]?.url)
      .map(p => {
        const info     = p.imageinfo[0];
        const rawTitle = p.title.replace('File:', '');
        return {
          title:   rawTitle,
          url:     info.descriptionurl ?? info.url,
          img_src: info.thumburl ?? info.url,
          snippet: info.extmetadata?.ImageDescription?.value?.replace(/<[^>]+>/g, '').slice(0, 120) ?? rawTitle,
          type:    'image',
        };
      })
      .filter(s => s.img_src)
      .slice(0, 8);
  } catch (err) {
    console.warn('[ImageAgent] wikimediaSearch error:', err.message);
    return [];
  }
}

// ── Fix : utilise list=search au lieu de titles= ──────────────────────────────
async function wikimediaFallbackFromWikipedia(query) {
  const sources = [];
  for (const lang of ['fr', 'en']) {
    try {
      const encoded = encodeURIComponent(query);

      // Étape 1 : recherche textuelle pour trouver le bon titre de page
      const searchRes = await fetch(
        `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&srlimit=3&format=json&origin=*`,
        { signal: safeTimeout(6000) }
      );
      if (!searchRes.ok) continue;
      const searchData = await searchRes.json();
      const hits = searchData.query?.search ?? [];
      if (hits.length === 0) continue;

      // Étape 2 : récupère images + extrait sur les pages trouvées
      const pageIds = hits.map(h => h.pageid).join('|');
      const res = await fetch(
        `https://${lang}.wikipedia.org/w/api.php?action=query&pageids=${pageIds}&prop=pageimages|extracts|info&exintro=1&exchars=200&piprop=original|thumbnail&pithumbsize=600&inprop=url&format=json&origin=*`,
        { signal: safeTimeout(6000) }
      );
      if (!res.ok) continue;
      const data = await res.json();

      for (const page of Object.values(data.query?.pages ?? {})) {
        if (page.missing || (!page.thumbnail?.source && !page.original?.source)) continue;
        sources.push({
          title:   page.title,
          url:     page.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
          img_src: page.original?.source ?? page.thumbnail?.source,
          snippet: page.extract?.replace(/<[^>]+>/g, '').slice(0, 200),
          type:    'image',
        });
      }
      if (sources.length > 0) break;
    } catch (err) {
      console.warn(`[wikimediaFallback] ${lang} error:`, err.message);
    }
  }
  return sources;
}

// ── Agent Academic ────────────────────────────────────────────────────────────
async function runAcademicAgent(query) {
  const sources = await rephraseForSearch(query, 'anglais').then(q => semanticScholarSearch(q));

  const contextBlock = sources.length > 0
    ? `\n\n📚 Articles académiques :\n${sources.map((s, i) => `[${i+1}] ${s.title}\n${s.snippet ?? ''}\n${s.url}`).join('\n\n')}\n\nBasé-toi sur ces publications. Réponds en français. Cite avec [numéro].`
    : '';

  return {
    agent:         'academic',
    sources,
    images:        [],
    imageIntent:   'none',
    contextBlock,
    thinkingLabel: sources.length > 0 ? `${sources.length} article(s)` : 'Aucun article',
  };
}

async function semanticScholarSearch(query) {
  try {
    const encoded = encodeURIComponent(query);
    const res = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encoded}&limit=8&fields=title,abstract,year,authors,externalIds,openAccessPdf`,
      { headers: { Accept: 'application/json' }, signal: safeTimeout(9000) }
    );
    if (!res.ok) throw new Error(`Semantic Scholar ${res.status}`);
    const data = await res.json();
    return (data.data ?? []).map(paper => {
      const arxivId = paper.externalIds?.ArXiv;
      const doi     = paper.externalIds?.DOI;
      const url     = paper.openAccessPdf?.url
        ?? (arxivId ? `https://arxiv.org/abs/${arxivId}` : null)
        ?? (doi     ? `https://doi.org/${doi}` : null)
        ?? `https://www.semanticscholar.org/paper/${paper.paperId}`;
      const authors = (paper.authors ?? []).slice(0, 3).map(a => a.name).join(', ');
      const year    = paper.year ? ` (${paper.year})` : '';
      return {
        title:   paper.title ?? 'Sans titre',
        url,
        snippet: paper.abstract ? `${paper.abstract.slice(0, 220)}… — ${authors}${year}` : `${authors}${year}`,
        type:    'academic',
      };
    }).filter(s => s.title && s.url);
  } catch (err) {
    console.warn('[AcademicAgent] Semantic Scholar error:', err.message);
    return arxivSearch(query);
  }
}

async function arxivSearch(query) {
  try {
    const encoded = encodeURIComponent(query);
    const res     = await fetch(
      `https://export.arxiv.org/api/query?search_query=all:${encoded}&max_results=6&sortBy=relevance`,
      { signal: safeTimeout(9000) }
    );
    const text = await res.text();
    return (text.match(/<entry>([\s\S]*?)<\/entry>/g) ?? []).slice(0, 6).map(entry => {
      const title   = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, ' ') ?? '';
      const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim().replace(/\s+/g, ' ') ?? '';
      const link    = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? '';
      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].slice(0, 2).map(m => m[1]).join(', ');
      return {
        title,
        url:     link.replace('http://', 'https://'),
        snippet: `${summary.slice(0, 200)}…${authors ? ` — ${authors}` : ''}`,
        type:    'academic',
      };
    }).filter(s => s.title && s.url);
  } catch (err) {
    console.warn('[AcademicAgent] arXiv error:', err.message);
    return [];
  }
}

// ── Agent Reddit ──────────────────────────────────────────────────────────────
async function runRedditAgent(query) {
  const sources = await rephraseForSearch(query, 'français ou anglais').then(q => redditSearch(q));

  const contextBlock = sources.length > 0
    ? `\n\n💬 Discussions Reddit :\n${sources.map((s, i) => `[${i+1}] ${s.title}\n${s.snippet ?? ''}`).join('\n\n')}\n\nSynthétise les opinions en français. Cite avec [numéro].`
    : '';

  return {
    agent:         'reddit',
    sources,
    images:        [],
    imageIntent:   'none',
    contextBlock,
    thinkingLabel: sources.length > 0 ? `${sources.length} discussion(s)` : 'Aucune discussion',
  };
}

async function redditSearch(query) {
  try {
    const encoded = encodeURIComponent(query);
    const res = await fetch(
      `https://www.reddit.com/search.json?q=${encoded}&sort=relevance&limit=8&t=year`,
      { headers: { Accept: 'application/json', 'User-Agent': 'NerosiaMobileApp/1.0' }, signal: safeTimeout(7000) }
    );
    if (!res.ok) throw new Error(`Reddit ${res.status}`);
    const data = await res.json();
    return (data.data?.children ?? [])
      .map(c => c.data)
      .filter(p => p?.title && p?.permalink)
      .map(p => ({
        title:   p.title,
        url:     `https://www.reddit.com${p.permalink}`,
        snippet: p.selftext ? p.selftext.slice(0, 200) + (p.selftext.length > 200 ? '…' : '') : `r/${p.subreddit} · ${p.score ?? 0} points`,
        img_src: p.thumbnail?.startsWith('http') ? p.thumbnail : undefined,
        type:    'reddit',
      }))
      .slice(0, 6);
  } catch (err) {
    console.warn('[RedditAgent] error:', err.message);
    return [];
  }
}

// ── Agent Wikipedia ───────────────────────────────────────────────────────────
async function runWikipediaAgent(query) {
  const intent = detectImageIntent(query);

  const tasks = [rephraseForSearch(query, 'français').then(q => wikipediaSearch(q))];
  if (intent === 'show') tasks.push(fetchImagesForQuery(query));

  const [sources, images = []] = await Promise.all(tasks);

  const contextBlock = sources.length > 0
    ? `\n\n📖 Résultats Wikipedia :\n${sources.map((s, i) => `[${i+1}] ${s.title}\n${s.snippet ?? ''}`).join('\n\n')}\n\nRéponds en français basé sur ces informations. Cite avec [numéro].`
    : '';

  return {
    agent:         'wikipedia',
    sources,
    images,
    imageIntent:   intent,
    contextBlock,
    thinkingLabel: sources.length > 0 ? `${sources.length} article(s) Wikipedia` : 'Aucun article',
  };
}

async function wikipediaSearch(query) {
  const sources = [];
  for (const lang of ['fr', 'en']) {
    if (sources.length >= 4) break;
    try {
      const encoded   = encodeURIComponent(query);
      const searchRes = await fetch(
        `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&srlimit=5&format=json&origin=*`,
        { signal: safeTimeout(6000) }
      );
      if (!searchRes.ok) continue;
      const searchData = await searchRes.json();
      const hits       = searchData.query?.search ?? [];
      if (hits.length === 0) continue;

      const pageIds    = hits.slice(0, 4).map(h => h.pageid).join('|');
      const extractRes = await fetch(
        `https://${lang}.wikipedia.org/w/api.php?action=query&pageids=${pageIds}&prop=extracts|pageimages|info&exintro=1&exchars=300&piprop=thumbnail&pithumbsize=400&inprop=url&format=json&origin=*`,
        { signal: safeTimeout(6000) }
      );
      if (!extractRes.ok) continue;
      const extractData = await extractRes.json();

      for (const page of Object.values(extractData.query?.pages ?? {})) {
        if (!page.title || page.missing) continue;
        const extract = page.extract?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() ?? '';
        sources.push({
          title:   page.title,
          url:     page.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
          snippet: extract.slice(0, 250) + (extract.length > 250 ? '…' : ''),
          img_src: page.thumbnail?.source,
          type:    'wikipedia',
        });
      }
    } catch (err) {
      console.warn(`[WikipediaAgent] ${lang} error:`, err.message);
    }
  }
  return sources.slice(0, 6);
}

// ── Export principal ──────────────────────────────────────────────────────────
async function runSearchAgent(query, forceAgent) {
  // Validation query
  if (!query || typeof query !== 'string') {
    console.warn('[runSearchAgent] Query invalide:', query);
    return { agent: 'web', sources: [], images: [], imageIntent: 'none', contextBlock: '', thinkingLabel: 'Erreur' };
  }
  const safeQuery = query.trim().slice(0, 500);

  // Validation forceAgent — whitelist stricte
  const agent = VALID_AGENTS.includes(forceAgent) ? forceAgent : detectAgent(safeQuery);

  try {
    switch (agent) {
      case 'image':     return await runImageAgent(safeQuery);
      case 'academic':  return await runAcademicAgent(safeQuery);
      case 'reddit':    return await runRedditAgent(safeQuery);
      case 'wikipedia': return await runWikipediaAgent(safeQuery);
      case 'web':
      default:          return await runWebAgent(safeQuery);
    }
  } catch (err) {
    console.error('[runSearchAgent] Erreur non catchée dans agent:', agent, err.message);
    return { agent, sources: [], images: [], imageIntent: 'none', contextBlock: '', thinkingLabel: 'Erreur' };
  }
}

module.exports = { runSearchAgent, detectAgent };
