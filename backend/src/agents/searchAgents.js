// ─────────────────────────────────────────────────────────────────────────────
// src/agents/searchAgents.js — Agents de recherche (sans clé API requise)
// ─────────────────────────────────────────────────────────────────────────────

const { openRouterFetch, OPENROUTER_MODELS } = require('../openrouter');

// ── Détection automatique de l'agent ─────────────────────────────────────────

const REDDIT_KW = [
  'reddit', 'expérience', 'forum', 'communauté', 'gens pensent',
  "retour d'expérience", 'témoignage', 'que pensent les gens',
  'avis reddit', 'opinion reddit', 'avis des gens',
];
const ACADEMIC_KW = [
  'étude', 'recherche', 'article scientifique', 'papier', 'pubmed',
  'arxiv', 'thèse', 'journal', 'académique', 'publication', 'scientifique',
  'selon les études', 'recherches montrent', 'science', 'preuve',
];
const IMAGE_KW = [
  'image', 'photo', 'illustration', 'montre', 'à quoi ressemble',
  'voir une photo', 'schéma', 'visuel', 'montre moi', 'photos de', 'images de',
];
const WIKIPEDIA_KW = [
  'wikipedia', 'définition', 'qui est', "c'est quoi", 'kesako',
  'explique moi', 'histoire de', 'biographie', 'origine de',
  "qu'est-ce que", "qu'est ce que", 'signifie', 'veut dire',
];

function detectAgent(query) {
  const q = query.toLowerCase();
  if (IMAGE_KW.some(k => q.includes(k)))     return 'image';
  if (ACADEMIC_KW.some(k => q.includes(k)))  return 'academic';
  if (REDDIT_KW.some(k => q.includes(k)))    return 'reddit';
  if (WIKIPEDIA_KW.some(k => q.includes(k))) return 'wikipedia';
  return 'none';
}

// ── Rephrase via LLM ──────────────────────────────────────────────────────────

async function rephraseForSearch(query, lang) {
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
    const result = r.content.trim().replace(/^["']|["']$/g, '').replace(/\.$/, '');
    return result.length > 3 ? result : query;
  } catch {
    return query;
  }
}

// ── Agent Image — Wikimedia Commons ──────────────────────────────────────────

async function runImageAgent(query) {
  const q = await rephraseForSearch(query, 'anglais');
  const sources = await wikimediaSearch(q);
  const contextBlock = sources.length > 0
    ? `\n\n🖼️ Images trouvées pour "${q}" :\n${sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n')}\n\nCes images sont déjà affichées dans l'interface utilisateur. Décris brièvement ce que montrent ces images.`
    : `\n\nAucune image trouvée pour cette recherche.`;
  return { agent: 'image', sources, contextBlock, thinkingLabel: sources.length > 0 ? `${sources.length} image(s) trouvée(s)` : 'Aucune image trouvée' };
}

async function wikimediaSearch(query) {
  try {
    const encoded = encodeURIComponent(query);
    const searchRes = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&srnamespace=6&srlimit=12&format=json&origin=*`, { signal: AbortSignal.timeout(7000) });
    if (!searchRes.ok) throw new Error(`Wikimedia ${searchRes.status}`);
    const searchData = await searchRes.json();
    let titles = (searchData.query?.search ?? []).map(item => item.title).filter(t => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(t));
    if (titles.length === 0) return await wikimediaFallbackFromWikipedia(query);
    const titlesParam = titles.slice(0, 8).join('|');
    const infoRes = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(titlesParam)}&prop=imageinfo&iiprop=url|thumburl|extmetadata&iiurlwidth=600&format=json&origin=*`, { signal: AbortSignal.timeout(7000) });
    if (!infoRes.ok) throw new Error(`Wikimedia info ${infoRes.status}`);
    const infoData = await infoRes.json();
    return Object.values(infoData.query?.pages ?? {})
      .filter(p => p.imageinfo?.[0]?.url)
      .map(p => {
        const info = p.imageinfo[0];
        const rawTitle = p.title.replace('File:', '');
        return { title: rawTitle, url: info.descriptionurl ?? info.url, img_src: info.thumburl ?? info.url, snippet: info.extmetadata?.ImageDescription?.value?.replace(/<[^>]+>/g, '').slice(0, 120) ?? rawTitle, type: 'image' };
      })
      .filter(s => s.img_src)
      .slice(0, 8);
  } catch (err) {
    console.warn('[ImageAgent] Wikimedia error:', err);
    return [];
  }
}

async function wikimediaFallbackFromWikipedia(query) {
  const sources = [];
  for (const lang of ['fr', 'en']) {
    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encoded}&prop=pageimages|extracts|info&exintro=1&exchars=200&piprop=original|thumbnail&pithumbsize=600&inprop=url&format=json&origin=*`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const page of Object.values(data.query?.pages ?? {})) {
        if (page.missing || (!page.thumbnail?.source && !page.original?.source)) continue;
        sources.push({ title: page.title, url: page.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title)}`, img_src: page.original?.source ?? page.thumbnail?.source, snippet: page.extract?.replace(/<[^>]+>/g, '').slice(0, 200), type: 'image' });
      }
      if (sources.length > 0) break;
    } catch {}
  }
  return sources;
}

// ── Agent Academic — Semantic Scholar + arXiv fallback ───────────────────────

async function runAcademicAgent(query) {
  const q = await rephraseForSearch(query, 'anglais');
  const sources = await semanticScholarSearch(q);
  const contextBlock = sources.length > 0
    ? `\n\n📚 Articles académiques :\n${sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet ?? ''}\n${s.url}`).join('\n\n')}\n\nBasé-toi sur ces publications. Cite avec [numéro].`
    : '';
  return { agent: 'academic', sources, contextBlock, thinkingLabel: sources.length > 0 ? `${sources.length} article(s) académique(s)` : 'Aucun article trouvé' };
}

async function semanticScholarSearch(query) {
  try {
    const encoded = encodeURIComponent(query);
    const res = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encoded}&limit=8&fields=title,abstract,year,authors,externalIds,openAccessPdf`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error(`Semantic Scholar ${res.status}`);
    const data = await res.json();
    return (data.data ?? []).map(paper => {
      const arxivId = paper.externalIds?.ArXiv;
      const doi = paper.externalIds?.DOI;
      const url = paper.openAccessPdf?.url ?? (arxivId ? `https://arxiv.org/abs/${arxivId}` : null) ?? (doi ? `https://doi.org/${doi}` : null) ?? `https://www.semanticscholar.org/paper/${paper.paperId}`;
      const authors = (paper.authors ?? []).slice(0, 3).map(a => a.name).join(', ');
      const year = paper.year ? ` (${paper.year})` : '';
      return { title: paper.title ?? 'Sans titre', url, snippet: paper.abstract ? `${paper.abstract.slice(0, 220)}… — ${authors}${year}` : `${authors}${year}`, type: 'academic' };
    }).filter(s => s.title && s.url);
  } catch {
    return arxivSearch(query);
  }
}

async function arxivSearch(query) {
  try {
    const encoded = encodeURIComponent(query);
    const res = await fetch(`https://export.arxiv.org/api/query?search_query=all:${encoded}&max_results=6&sortBy=relevance`, { signal: AbortSignal.timeout(9000) });
    const text = await res.text();
    return (text.match(/<entry>([\s\S]*?)<\/entry>/g) ?? []).slice(0, 6).map(entry => {
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, ' ') ?? '';
      const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim().replace(/\s+/g, ' ') ?? '';
      const link = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? '';
      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].slice(0, 2).map(m => m[1]).join(', ');
      return { title, url: link.replace('http://', 'https://'), snippet: `${summary.slice(0, 200)}…${authors ? ` — ${authors}` : ''}`, type: 'academic' };
    }).filter(s => s.title && s.url);
  } catch {
    return [];
  }
}

// ── Agent Reddit ──────────────────────────────────────────────────────────────

async function runRedditAgent(query) {
  const q = await rephraseForSearch(query, 'français ou anglais');
  const sources = await redditSearch(q);
  const contextBlock = sources.length > 0
    ? `\n\n💬 Discussions Reddit :\n${sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet ?? ''}`).join('\n\n')}\n\nSynthétise les opinions. Cite avec [numéro].`
    : '';
  return { agent: 'reddit', sources, contextBlock, thinkingLabel: sources.length > 0 ? `${sources.length} discussion(s) Reddit` : 'Aucune discussion trouvée' };
}

async function redditSearch(query) {
  try {
    const encoded = encodeURIComponent(query);
    const res = await fetch(`https://www.reddit.com/search.json?q=${encoded}&sort=relevance&limit=8&t=year`, { headers: { Accept: 'application/json', 'User-Agent': 'NerosiaMobileApp/1.0' }, signal: AbortSignal.timeout(7000) });
    if (!res.ok) throw new Error(`Reddit ${res.status}`);
    const data = await res.json();
    return (data.data?.children ?? []).map(c => c.data).filter(p => p?.title && p?.permalink).map(p => ({
      title: p.title, url: `https://www.reddit.com${p.permalink}`,
      snippet: p.selftext ? p.selftext.slice(0, 200) + (p.selftext.length > 200 ? '…' : '') : `r/${p.subreddit} · ${p.score ?? 0} points`,
      img_src: p.thumbnail?.startsWith('http') ? p.thumbnail : undefined, type: 'reddit',
    })).slice(0, 6);
  } catch { return []; }
}

// ── Agent Wikipedia ───────────────────────────────────────────────────────────

async function runWikipediaAgent(query) {
  const q = await rephraseForSearch(query, 'français');
  const sources = await wikipediaSearch(q);
  const contextBlock = sources.length > 0
    ? `\n\n📖 Résultats Wikipedia :\n${sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet ?? ''}`).join('\n\n')}\n\nRéponds en te basant sur ces informations. Cite avec [numéro].`
    : '';
  return { agent: 'wikipedia', sources, contextBlock, thinkingLabel: sources.length > 0 ? `${sources.length} article(s) Wikipedia` : 'Aucun article Wikipedia' };
}

async function wikipediaSearch(query) {
  const sources = [];
  for (const lang of ['fr', 'en']) {
    if (sources.length >= 4) break;
    try {
      const encoded = encodeURIComponent(query);
      const searchRes = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&srlimit=5&format=json&origin=*`, { signal: AbortSignal.timeout(6000) });
      if (!searchRes.ok) continue;
      const searchData = await searchRes.json();
      const hits = searchData.query?.search ?? [];
      if (hits.length === 0) continue;
      const pageIds = hits.slice(0, 4).map(h => h.pageid).join('|');
      const extractRes = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&pageids=${pageIds}&prop=extracts|pageimages|info&exintro=1&exchars=300&piprop=thumbnail&pithumbsize=400&inprop=url&format=json&origin=*`, { signal: AbortSignal.timeout(6000) });
      if (!extractRes.ok) continue;
      const extractData = await extractRes.json();
      for (const page of Object.values(extractData.query?.pages ?? {})) {
        if (!page.title || page.missing) continue;
        const extract = page.extract?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() ?? '';
        sources.push({ title: page.title, url: page.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title)}`, snippet: extract.slice(0, 250) + (extract.length > 250 ? '…' : ''), img_src: page.thumbnail?.source, type: 'wikipedia' });
      }
    } catch {}
  }
  return sources.slice(0, 6);
}

// ── Agent Web — DuckDuckGo ────────────────────────────────────────────────────

async function runWebAgent(query) {
  const sources = await duckduckgoSearch(query);
  const contextBlock = sources.length > 0
    ? `\n\n🌐 Résultats web :\n${sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet ?? ''}`).join('\n\n')}\n\nCite les sources avec [numéro].`
    : '';
  return { agent: 'web', sources, contextBlock, thinkingLabel: sources.length > 0 ? `${sources.length} source(s) web` : 'Réponse directe' };
}

async function duckduckgoSearch(query) {
  try {
    const encoded = encodeURIComponent(query);
    const res = await fetch(`https://api.duckduckgo.com/?q=${encoded}&format=json&no_redirect=1&no_html=1&skip_disambig=1`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    const sources = [];
    if (data.AbstractText && data.AbstractURL) {
      sources.push({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText, img_src: data.Image ? `https://duckduckgo.com${data.Image}` : undefined, type: 'web' });
    }
    for (const t of (data.RelatedTopics ?? []).flatMap(t => t.Topics ? t.Topics : [t])) {
      if (t.FirstURL && t.Text) sources.push({ title: t.Text.slice(0, 90), url: t.FirstURL, snippet: t.Text, img_src: t.Icon?.URL ? `https://duckduckgo.com${t.Icon.URL}` : undefined, type: 'web' });
    }
    return sources.slice(0, 8);
  } catch { return []; }
}

// ── Point d'entrée ────────────────────────────────────────────────────────────

async function runSearchAgent(query, forceAgent) {
  const agent = forceAgent ?? detectAgent(query);
  switch (agent) {
    case 'image':     return runImageAgent(query);
    case 'academic':  return runAcademicAgent(query);
    case 'reddit':    return runRedditAgent(query);
    case 'wikipedia': return runWikipediaAgent(query);
    case 'web':       return runWebAgent(query);
    default:          return null;
  }
}

module.exports = { runSearchAgent, detectAgent };
