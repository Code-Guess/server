// ─────────────────────────────────────────────────────────────────────────────
// src/agents/codeAgents.js — Pipeline multi-agents génération de code
// ─────────────────────────────────────────────────────────────────────────────

const { openRouterFetch, OPENROUTER_MODELS } = require('../openrouter');
const path = require('path');
const fs = require('fs');

// ── Icônes ────────────────────────────────────────────────────────────────────

const FOLDER_ICONS = {
  'components':'🧩','hooks':'🪝','utils':'🛠️','assets':'🖼️','styles':'🎨',
  'context':'🔗','models':'🗄️','services':'⚡','tests':'🧪','__tests__':'🧪',
  'docs':'📚','scripts':'⚙️','constants':'📌','screens':'📱','pages':'📄',
  'layouts':'🏗️','router':'🔀','store':'🗃️','lib':'📚','src':'📂',
  'app':'📱','api':'🔌','server':'🖥️','config':'⚙️','public':'🌐',
  'shared':'🤝','middleware':'🔄','types':'🔷','interfaces':'🔷',
  'database':'🗄️','migrations':'🔄','widgets':'🧩','modules':'📦',
};
const FILE_ICONS = {
  'tsx':'⚛️','jsx':'⚛️','ts':'🔷','js':'🟨','py':'🐍','dart':'🐦',
  'java':'☕','kt':'☕','swift':'🍎','go':'🐹','rs':'🦀','cpp':'⚙️',
  'c':'⚙️','cs':'🟣','php':'🐘','rb':'💎','html':'🌐','css':'🎨',
  'scss':'🎨','sass':'🎨','json':'📦','yaml':'⚙️','yml':'⚙️','toml':'⚙️',
  'md':'📄','mdx':'📄','txt':'📝','env':'🔐','sh':'⚙️','bash':'⚙️',
  'sql':'🗄️','graphql':'🔮','svg':'🖼️','png':'🖼️','jpg':'🖼️',
  'package.json':'📦','.gitignore':'🔀','.env':'🔐','dockerfile':'🐳',
  'readme.md':'📖','tsconfig.json':'🔷','vite.config.ts':'⚡',
};

function getFileIcon(fileName) {
  const lower = fileName.toLowerCase();
  if (FILE_ICONS[lower]) return FILE_ICONS[lower];
  const ext = lower.split('.').pop() ?? '';
  return FILE_ICONS[ext] ?? '📄';
}
function getFolderIcon(folderName) {
  return FOLDER_ICONS[folderName.toLowerCase()] ?? '📁';
}

// ── RAG loader ────────────────────────────────────────────────────────────────

async function loadRAGFile(stack) {
  try {
    const ragDir = path.join(__dirname, '../../rag');
    const fileName = `${stack}.md`;
    const filePath = path.join(ragDir, fileName);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch {}
  return `Stack : ${stack}\nPas de contexte RAG disponible pour ce stack.`;
}

// ── EnhancerAgent ─────────────────────────────────────────────────────────────

async function runEnhancerAgent(userRequest) {
  const result = await openRouterFetch({
    model: 'sonnet',
    max_tokens: 4000,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content: `Tu es un expert en ingénierie des prompts pour la génération de code ET en design UI/UX premium.
Tu reçois une demande brute et courte d'un utilisateur.
Tu dois la transformer en un prompt COMPLET et DÉTAILLÉ pour un agent de développement.

RÈGLES FONCTIONNELLES :
- Déduis intelligemment le type de projet (web, mobile, API, script...)
- Ajoute les fonctionnalités évidentes non mentionnées (auth, CRUD, UI, responsive...)
- Précise le stack technologique le plus adapté
- Décris l'architecture attendue

RÈGLES DESIGN — OBLIGATOIRES :
- Impose un design ULTRA PREMIUM et MODERNE : glassmorphism, gradients sophistiqués, micro-animations
- Précise une palette de couleurs cohérente et élégante
- Demande des animations CSS fluides : transitions 0.3s ease, hover effects, scroll reveals
- Impose une typographie soignée : hiérarchie claire, font-weight varié, letter-spacing
- Demande des effets visuels haut de gamme : box-shadow multicouches, backdrop-filter blur, border subtils

RÉPONDS UNIQUEMENT avec le prompt enrichi (texte pur, sans JSON, sans markdown, sans introduction).`,
      },
      { role: 'user', content: `Demande originale : "${userRequest}"\n\nGénère un prompt détaillé et complet pour créer ce projet avec un design ultra premium et moderne.` },
    ],
  });
  const enhanced = result.content.trim();
  return enhanced.length > 20 ? enhanced : userRequest;
}

// ── Stack detector ────────────────────────────────────────────────────────────

async function detectStack(userRequest) {
  const q = userRequest.toLowerCase();
  if (q.includes('html') || q.includes('vanilla') || q.includes('html5')) return 'html-vanilla';
  if (q.includes('react native') || q.includes('expo') || q.includes('mobile app')) return 'react-native';
  if (q.includes('next') || q.includes('nextjs') || q.includes('ssr') || q.includes('fullstack')) return 'nextjs';
  if (q.includes('react') || q.includes('vite') || q.includes('spa')) return 'react-web';
  if (q.includes('python') || q.includes('fastapi') || q.includes('flask') || q.includes('django')) return 'python';
  if (q.includes('node') || q.includes('express') || q.includes('nodejs')) return 'nodejs';
  if (q.includes('flutter') || q.includes('dart')) return 'flutter';
  if (q.includes('java') || q.includes('spring')) return 'java';
  if (q.includes('php') || q.includes('laravel')) return 'php';
  try {
    const result = await openRouterFetch({
      model: 'haiku', max_tokens: 50, temperature: 0,
      messages: [
        { role: 'system', content: `Détecte le stack. Réponds UNIQUEMENT avec un de ces mots : html-vanilla | react-web | react-native | nextjs | python | nodejs | flutter | java | php | c | cpp` },
        { role: 'user', content: userRequest },
      ],
    });
    const detected = result.content.trim().toLowerCase();
    const valid = ['html-vanilla','react-web','react-native','nextjs','python','nodejs','flutter','java','php','c','cpp'];
    return valid.includes(detected) ? detected : 'react-web';
  } catch { return 'react-web'; }
}

// ── PromptAgent ───────────────────────────────────────────────────────────────

async function runPromptAgent(enhancedRequest, stack, ragContent) {
  const result = await openRouterFetch({
    model: 'sonnet', max_tokens: 3500, temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: `Tu es un expert en architecture logicielle et design UI/UX premium.
Stack IMPOSÉ : ${stack}.
CONTEXTE RAG : ${ragContent}
Produis une SPÉCIFICATION JSON complète. Réponds UNIQUEMENT avec un JSON valide, sans balises markdown.
{"project_name":"nom_snake_case","description":"...","type":"web|mobile|api","language":"${stack}","framework":"...","features":["..."],"design_system":{"style":"glassmorphism|dark-premium|flat-luxury","primary_color":"#hex","secondary_color":"#hex","accent_color":"#hex","background":"...","typography":"...","animations":["..."],"effects":["..."]},"files_needed":[{"name":"chemin/fichier.ext","role":"...","priority":1}],"folder_structure":[{"path":"src","description":"..."}],"dependencies":["..."],"entry_point":"...","constraints":["..."]}`,
      },
      { role: 'user', content: enhancedRequest },
    ],
  });
  const raw = result.content.trim();
  return raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
}

// ── StructureAgent ────────────────────────────────────────────────────────────

async function runStructureAgent(spec, ragContent) {
  const specObj = (() => { try { return JSON.parse(spec); } catch { return {}; } })();
  const designSystem = specObj.design_system ? `\nDESIGN SYSTEM :\n${JSON.stringify(specObj.design_system, null, 2)}` : '';
  const result = await openRouterFetch({
    model: 'sonnet', max_tokens: 4000, temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: `Tu es un architecte logiciel senior et expert UI/UX premium.${designSystem}
CONTEXTE RAG : ${ragContent}
Réponds UNIQUEMENT avec un JSON valide, sans markdown.
{"architecture_summary":"...","patterns":["..."],"data_flow":"...","folders":[{"name":"src","files":["index.ts"]}],"files":[{"name":"src/index.ts","type":"component|hook|service|util","exports":["..."],"imports":["..."],"description":"...","code_hints":["..."]}],"implementation_order":["src/index.ts"],"potential_issues":["..."]}`,
      },
      { role: 'user', content: `Spécification :\n${spec}` },
    ],
  });
  const raw = result.content.trim();
  return raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
}

// ── BuilderAgent ──────────────────────────────────────────────────────────────

async function buildSingleFile(fileSpec, projectContext) {
  const ext = fileSpec.name.split('.').pop() ?? 'ts';
  const languageMap = { ts:'typescript',tsx:'typescript',js:'javascript',jsx:'javascript',py:'python',css:'css',json:'json',sh:'bash',md:'markdown',html:'html',dart:'dart' };
  const language = languageMap[ext] ?? ext;
  const specObj = (() => { try { return JSON.parse(projectContext.spec); } catch { return {}; } })();
  const designSystem = specObj.design_system ?? {};
  const isUiFile = ['tsx','jsx','html','css','scss'].includes(ext);
  const designInstructions = isUiFile ? `
DESIGN SYSTEM IMPOSÉ :
- Style : ${designSystem.style ?? 'dark-premium moderne'}
- Couleur primaire : ${designSystem.primary_color ?? '#6C63FF'}
- Fond : ${designSystem.background ?? 'gradient sombre luxueux'}
- Animations : ${(designSystem.animations ?? ['transitions 0.3s ease']).join(', ')}
- Effets : ${(designSystem.effects ?? ['glassmorphism','box-shadow multicouches']).join(', ')}
RÈGLES UI PREMIUM : hover effects, skeleton loaders, transitions entre états, typographie hiérarchique.` : '';

  const result = await openRouterFetch({
    model: 'sonnet', max_tokens: 8000, temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: `Tu es un développeur expert senior qui écrit du code de production de TRÈS HAUTE QUALITÉ.
CONTEXTE RAG : ${projectContext.ragContent}
RÈGLES : Code complet, pas de TODO ni placeholder, types TypeScript stricts, gestion erreurs, aucun import inutilisé.
${designInstructions}
Réponds UNIQUEMENT avec le code source brut, sans balises markdown.`,
      },
      {
        role: 'user',
        content: `Fichier : ${fileSpec.name}\nDescription : ${fileSpec.description}\nExports : ${(fileSpec.exports??[]).join(', ')}\nImports : ${(fileSpec.imports??[]).join(', ')}\nIndications : ${(fileSpec.code_hints??[]).join('; ')}\n\nContexte projet :\n${projectContext.spec}\n\nArchitecture :\n${projectContext.architecture}`,
      },
    ],
  });
  const content = result.content.trim();
  const fileName = fileSpec.name.split('/').pop() ?? fileSpec.name;
  return { name: fileSpec.name, language, content, size: `${(content.length / 1024).toFixed(1)} Ko`, icon: getFileIcon(fileName) };
}

// ── DebugAgent ────────────────────────────────────────────────────────────────

async function runDebugAgent(files, spec, ragContent) {
  const filesContext = files.map(f => `=== ${f.name} ===\n${f.content}`).join('\n\n');
  const specObj = (() => { try { return JSON.parse(spec); } catch { return {}; } })();
  const designSystem = specObj.design_system;
  const designAuditRules = designSystem ? `
AUDIT DESIGN SYSTEM :
- primary=${designSystem.primary_color}, secondary=${designSystem.secondary_color}
- Style "${designSystem.style}" doit être visible et cohérent
- Animations requises : ${(designSystem.animations??[]).join(', ')}
- Tout élément interactif DOIT avoir un hover effect` : '';

  const result = await openRouterFetch({
    model: 'sonnet', max_tokens: 12000, temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: `Tu es un expert senior en audit de code ET en design UI/UX premium. Tu es TRÈS STRICT.
CONTEXTE RAG : ${ragContent}
${designAuditRules}
CRITÈRES D'ERREUR (severity: "error") : sélecteurs CSS sans cible HTML, imports cassés, TODO placeholder, design générique sans animations, couleurs hardcodées.
Réponds UNIQUEMENT avec un JSON valide, sans markdown.
{"issues_found":[{"file":"nom","issue":"...","severity":"error|warning"}],"fixed_files":[{"name":"nom","content":"CODE COMPLET"}],"audit_summary":"..."}`,
      },
      { role: 'user', content: `Spécification :\n${spec}\n\n--- FICHIERS ---\n\n${filesContext}` },
    ],
  });

  try {
    const raw = result.content.trim().replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
    const audit = JSON.parse(raw);
    const fixedMap = new Map((audit.fixed_files ?? []).map(f => [f.name, f.content]));
    return files.map(f => {
      const content = fixedMap.get(f.name) ?? f.content;
      const fileName = f.name.split('/').pop() ?? f.name;
      return { ...f, content, size: `${(content.length / 1024).toFixed(1)} Ko`, icon: getFileIcon(fileName) };
    });
  } catch { return files; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFolderTree(files) {
  const folderMap = new Map();
  for (const file of files) {
    const parts = file.name.split('/');
    const fileName = parts[parts.length - 1];
    const folderPath = parts.slice(0, -1).join('/') || '.';
    if (!folderMap.has(folderPath)) folderMap.set(folderPath, []);
    folderMap.get(folderPath).push(fileName);
  }
  const folders = [];
  folderMap.forEach((fileNames, folderName) => {
    const lastSegment = folderName.split('/').pop() ?? folderName;
    folders.push({ name: folderName, files: fileNames, icon: folderName === '.' ? '📁' : getFolderIcon(lastSegment) });
  });
  return folders.sort((a, b) => a.name === '.' ? -1 : b.name === '.' ? 1 : a.name.localeCompare(b.name));
}

function needsCodePipeline(query) {
  const q = query.toLowerCase();
  const triggers = ['crée un','créé un','créer un','développe','développer','construis','construire','génère','génerer','generate','fait moi','fais moi','build','écris le code','écris un','application complète','app complète','projet complet','site web complet','crée moi','créé moi','faire un','fais un','créer une','crée une'];
  return triggers.some(t => q.includes(t)) && q.length > 20;
}

// ── Orchestrateur ─────────────────────────────────────────────────────────────

async function runCodePipeline(userRequest, onStepUpdate) {
  const steps = [
    { agent: 'enhancer',  label: '✨ Amélioration du prompt…',  status: 'pending' },
    { agent: 'prompt',    label: '🧠 Analyse de la demande…',   status: 'pending' },
    { agent: 'structure', label: '🏗️ Architecture du projet…',  status: 'pending' },
    { agent: 'builder',   label: '⚙️ Génération du code…',      status: 'pending' },
    { agent: 'debug',     label: '🔍 Audit et débogage…',       status: 'pending' },
  ];
  const update = (idx, status, label) => {
    steps[idx] = { ...steps[idx], status, ...(label ? { label } : {}) };
    if (onStepUpdate) onStepUpdate([...steps]);
  };

  try {
    // STEP 0 : Enhancer
    update(0, 'running');
    let enhancedRequest;
    try {
      enhancedRequest = await runEnhancerAgent(userRequest);
      update(0, 'done', `✨ Prompt enrichi : ${enhancedRequest.slice(0, 60).replace(/\n/g, ' ')}…`);
    } catch {
      enhancedRequest = userRequest;
      update(0, 'done', '✨ Prompt original conservé');
    }

    // STEP 1 : Stack + RAG + PromptAgent
    update(1, 'running');
    let specJson, spec, ragContent;
    try {
      const detectedStack = await detectStack(enhancedRequest);
      ragContent = await loadRAGFile(detectedStack);
      update(1, 'running', `🔍 Stack détecté : ${detectedStack}`);
      specJson = await runPromptAgent(enhancedRequest, detectedStack, ragContent);
      spec = JSON.parse(specJson);
      update(1, 'done', `🧠 Projet : ${spec.project_name ?? 'analyse'}`);
    } catch (e) {
      update(1, 'error', '🧠 Erreur analyse');
      return { steps, projectName: '', projectDescription: '', enhancedPrompt: enhancedRequest, files: [], folders: [], entryPoint: '', summary: "Impossible d'analyser la demande.", error: String(e) };
    }

    // STEP 2 : Structure
    update(2, 'running');
    let archJson, arch;
    try {
      archJson = await runStructureAgent(specJson, ragContent);
      arch = JSON.parse(archJson);
      update(2, 'done', `🏗️ Architecture : ${arch.files?.length ?? 0} fichier(s)`);
    } catch (e) {
      update(2, 'error', '🏗️ Erreur architecture');
      return { steps, projectName: spec.project_name ?? '', projectDescription: spec.description ?? '', enhancedPrompt: enhancedRequest, files: [], folders: [], entryPoint: spec.entry_point ?? '', summary: "Impossible de planifier l'architecture.", error: String(e) };
    }

    // STEP 3 : Builder
    update(3, 'running');
    const filesToBuild = (arch.files ?? []).slice(0, 20);
    const builtFiles = [];
    try {
      const orderedNames = arch.implementation_order ?? filesToBuild.map(f => f.name);
      const orderedFiles = orderedNames.map(name => filesToBuild.find(f => f.name === name)).filter(Boolean);
      filesToBuild.forEach(f => { if (!orderedFiles.find(o => o.name === f.name)) orderedFiles.push(f); });

      const BATCH_SIZE = 3;
      for (let i = 0; i < orderedFiles.length; i += BATCH_SIZE) {
        const batch = orderedFiles.slice(i, i + BATCH_SIZE);
        update(3, 'running', `⚙️ Génération : ${batch.map(f => f.name.split('/').pop()).join(', ')}…`);
        const batchResults = await Promise.all(batch.map(fileSpec => buildSingleFile(fileSpec, { spec: specJson, architecture: archJson, ragContent })));
        builtFiles.push(...batchResults);
      }
      update(3, 'done', `⚙️ ${builtFiles.length} fichier(s) généré(s)`);
    } catch (e) {
      update(3, 'error', '⚙️ Erreur génération');
      return { steps, projectName: spec.project_name ?? '', projectDescription: spec.description ?? '', enhancedPrompt: enhancedRequest, files: builtFiles, folders: buildFolderTree(builtFiles), entryPoint: spec.entry_point ?? '', summary: 'Erreur génération du code.', error: String(e) };
    }

    // STEP 4 : Debug
    update(4, 'running');
    let finalFiles = builtFiles;
    try {
      finalFiles = await runDebugAgent(builtFiles, specJson, ragContent);
      update(4, 'done', '🔍 Code audité et corrigé');
    } catch { update(4, 'done', '🔍 Audit partiel'); }

    const folders = buildFolderTree(finalFiles);
    const totalSize = finalFiles.reduce((acc, f) => acc + f.content.length, 0);
    const summary = `**${spec.project_name}** — ${finalFiles.length} fichier(s) · ${(totalSize / 1024).toFixed(1)} Ko · ${spec.description}`;

    return { steps, projectName: spec.project_name ?? 'projet', projectDescription: spec.description ?? '', enhancedPrompt: enhancedRequest, files: finalFiles, folders, entryPoint: spec.entry_point ?? '', summary };

  } catch (fatal) {
    return { steps, projectName: '', projectDescription: '', enhancedPrompt: userRequest, files: [], folders: [], entryPoint: '', summary: 'Une erreur fatale est survenue.', error: fatal?.message ?? String(fatal) };
  }
}

module.exports = { runCodePipeline, needsCodePipeline, getFileIcon, getFolderIcon };
