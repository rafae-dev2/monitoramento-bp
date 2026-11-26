/**
 * gemini-coa.mjs — Integração Google Gemini (Raciocínio Operacional COA/FLOW + Novas Vozes Brasileiras Gemini TTS)
 * Módulo interno consumido por netlify/functions/session.mjs para preservar o limite de 3 functions no plano gratuito.
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_REASONING_MODEL = 'gemini-2.5-flash';
const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const FALLBACK_TTS_MODEL = 'gemini-2.5-flash-tts';
const GEMINI_TIMEOUT_MS = 18_000;

export const VOZES_GEMINI_BR = [
  { id: 'Kore', nome: 'Kore (Brasil · Firme e Comandante — Recomendada COA)', genero: 'feminina', perfil: 'Comando firme e nítido para rádio' },
  { id: 'Aoede', nome: 'Aoede (Brasil · Natural e Fluida — Recomendada Geral)', genero: 'feminina', perfil: 'Locução natural, clara e equilibrada' },
  { id: 'Puck', nome: 'Puck (Brasil · Ágil e Dinâmica — Recomendada FLOW)', genero: 'masculina', perfil: 'Ritmo ágil para despacho de caminhões e leves' },
  { id: 'Charon', nome: 'Charon (Brasil · Grave e Informativa)', genero: 'masculina', perfil: 'Timbre grave, calmo e objetivo' },
  { id: 'Fenrir', nome: 'Fenrir (Brasil · Energética / Alerta Crítico)', genero: 'masculina', perfil: 'Alta presença sonora para emergências' },
  { id: 'Leda', nome: 'Leda (Brasil · Serena e Cristalina)', genero: 'feminina', perfil: 'Suave para turnos noturnos longos' },
  { id: 'Zephyr', nome: 'Zephyr (Brasil · Brilhante e Alta Dicção)', genero: 'feminina', perfil: 'Excelente inteligibilidade em ambiente ruidoso' },
  { id: 'Orus', nome: 'Orus (Brasil · Sólida e Executiva)', genero: 'masculina', perfil: 'Tom corporativo firme para boletins' },
  { id: 'Callirrhoe', nome: 'Callirrhoe (Brasil · Articulada e Clara)', genero: 'feminina', perfil: 'Cadência bem marcada' },
  { id: 'Autonoe', nome: 'Autonoe (Brasil · Calorosa e Natural)', genero: 'feminina', perfil: 'Timbre humano acolhedor' },
  { id: 'Schedar', nome: 'Schedar (Brasil · Estável e Pausada)', genero: 'masculina', perfil: 'Leitura cadenciada sem pressa' },
  { id: 'Sulafat', nome: 'Sulafat (Brasil · Precisa e Limpa)', genero: 'feminina', perfil: 'Pronúncia limpa de números de frota' },
];

const VOZES_PERMITIDAS = new Set(VOZES_GEMINI_BR.map((v) => v.id));

export function normalizarVozGemini(voz) {
  const limpa = String(voz || '').trim();
  if (VOZES_PERMITIDAS.has(limpa)) return limpa;
  const achada = VOZES_GEMINI_BR.find((v) => v.id.toLowerCase() === limpa.toLowerCase());
  return achada ? achada.id : 'Kore';
}

export function pcm16ParaWavBuffer(pcmBytes, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBytes.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM
  buffer.writeUInt16LE(1, 20);  // Linear PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBytes.copy(buffer, 44);
  return buffer;
}

function extrairSampleRate(mimeType) {
  const m = /rate=(\d{4,6})/i.exec(String(mimeType || ''));
  return m ? Math.max(8000, Math.min(48000, Number(m[1]) || 24000)) : 24000;
}

function resolverApiKey(corpoOuHeaderKey, env = process.env) {
  const candidata = String(corpoOuHeaderKey || env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').trim();
  if (!candidata || candidata.length < 16 || candidata.length > 256) return '';
  return candidata;
}

async function postGemini(modelo, apiKey, payload, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
  try {
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(modelo)}:generateContent`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `Gemini HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function sintetizarVozGemini(opcoes = {}, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || fetch;
  const apiKey = resolverApiKey(opcoes.apiKey, env);
  if (!apiKey) {
    const err = new Error('Chave GEMINI_API_KEY não configurada no servidor nem informada no aparelho.');
    err.status = 501;
    err.semChave = true;
    throw err;
  }

  const textoBruto = String(opcoes.texto || '').trim().slice(0, 900);
  if (!textoBruto) {
    const err = new Error('Texto vazio para síntese de voz.');
    err.status = 400;
    throw err;
  }

  const voiceName = normalizarVozGemini(opcoes.voz);
  const estilo = String(opcoes.estilo || 'comando').trim();
  const direcao = estilo === 'urgente'
    ? 'Fale em português do Brasil (pt-BR), com sotaque brasileiro natural, tom urgente, firme e nítido de sala de controle operacional, lendo exatamente o texto a seguir sem acrescentar palavras:'
    : estilo === 'calmo'
      ? 'Fale em português do Brasil (pt-BR), com sotaque brasileiro natural, cadência pausada, clara e serena, lendo exatamente o texto a seguir sem acrescentar palavras:'
      : 'Fale em português do Brasil (pt-BR), com sotaque brasileiro natural, dicção clara e firme de centro de operações agrícolas, lendo exatamente o texto a seguir sem acrescentar palavras:';

  const payload = {
    contents: [
      {
        parts: [{ text: `${direcao}\n"${textoBruto}"` }],
      },
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  };

  const modeloPrimario = String(opcoes.modelo || env.GEMINI_TTS_MODEL || DEFAULT_TTS_MODEL).trim();
  let resposta;
  try {
    resposta = await postGemini(modeloPrimario, apiKey, payload, fetchImpl);
  } catch (e1) {
    if (modeloPrimario !== FALLBACK_TTS_MODEL && (!e1.status || e1.status === 404 || e1.status >= 500)) {
      resposta = await postGemini(FALLBACK_TTS_MODEL, apiKey, payload, fetchImpl);
    } else {
      throw e1;
    }
  }

  const parts = (((resposta || {}).candidates || [])[0] || {}).content?.parts || [];
  const audioPart = parts.find((p) => p && p.inlineData && p.inlineData.data);
  if (!audioPart) {
    const err = new Error('O modelo Gemini não retornou áudio nesta tentativa.');
    err.status = 502;
    throw err;
  }

  const mime = String(audioPart.inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000');
  const rawBase64 = String(audioPart.inlineData.data || '');
  if (/audio\/(?:wav|x-wav|mpeg|mp3|ogg)/i.test(mime)) {
    return {
      ok: true,
      voz: voiceName,
      mimeType: mime,
      audioBase64: rawBase64,
    };
  }

  const pcmBuf = Buffer.from(rawBase64, 'base64');
  const sampleRate = extrairSampleRate(mime);
  const wavBuf = pcm16ParaWavBuffer(pcmBuf, sampleRate, 1, 16);
  return {
    ok: true,
    voz: voiceName,
    mimeType: 'audio/wav',
    sampleRate,
    audioBase64: wavBuf.toString('base64'),
  };
}

const SYSTEM_PROMPT_COA = [
  'Você é o Copiloto Sênior de Inteligência Operacional da Usina Branco Peres (SGPA Solinftec).',
  'Na usina existem duas mesas de controle que trabalham integradas:',
  '- Controle Flow: responsável por todos os Caminhões (canavieiros, comboio, pipa, munck e o grupo de caminhões bombeiros — nunca chame bombeiro de trator, sempre Caminhão) e Veículos Leves.',
  '- Controle Coa: responsável por Colhedoras, Tratores, Transbordos e máquinas de Linha Amarela.',
  'Regras de ouro do seu raciocínio:',
  '1. Velocidade é estritamente oficial do portal SGPA; nunca invente alerta de velocidade por conta própria.',
  '2. Cruze causa e efeito: diferencie falta real de caminhão (transbordos em 905 sem caminhão na frente) de gargalo na colhedora (fila de caminhões com colhedoras paradas/manutenção/facas) ou falso apontamento.',
  '3. Quantifique impacto em moagem (t/h) e custo operacional (R$) quando houver dados no contexto.',
  '4. Responda SEMPRE em português do Brasil direto, objetivo e acionável, estruturado em:',
  '   • Diagnóstico Causa-Raiz',
  '   • Ações Imediatas — Controle Coa',
  '   • Ações Imediatas — Controle Flow',
  '   • Mensagem Pronta de Rádio / Cobrança (curta, escrevendo "Coa" e "Flow" para pronúncia natural).',
].join('\n');

export async function raciocinarComGemini(opcoes = {}, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || fetch;
  const apiKey = resolverApiKey(opcoes.apiKey, env);
  if (!apiKey) {
    const err = new Error('Chave GEMINI_API_KEY não configurada no servidor nem informada no aparelho.');
    err.status = 501;
    err.semChave = true;
    throw err;
  }

  const pergunta = String(opcoes.pergunta || 'Faça um diagnóstico completo de causa-raiz dos gargalos e alertas atuais da usina e proponha o plano de ação imediato para Coa e Flow.').trim().slice(0, 1200);
  const contextoJson = JSON.stringify(opcoes.contexto || {}).slice(0, 28_000);
  const modelo = String(opcoes.modelo || env.GEMINI_MODEL || DEFAULT_REASONING_MODEL).trim();

  const payload = {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT_COA }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `CONTEXTO REAL DO SGPA NESTE EXATO MOMENTO:\n${contextoJson}\n\nSOLICITAÇÃO DO OPERADOR:\n${pergunta}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: 1400,
    },
  };

  if (/^gemini-2\.5/i.test(modelo)) {
    payload.generationConfig.thinkingConfig = { thinkingBudget: 1024 };
  }

  const resposta = await postGemini(modelo, apiKey, payload, fetchImpl);
  const parts = (((resposta || {}).candidates || [])[0] || {}).content?.parts || [];
  const texto = parts
    .filter((p) => p && typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('\n')
    .trim();

  if (!texto) {
    const err = new Error('O modelo Gemini não retornou texto de análise.');
    err.status = 502;
    throw err;
  }

  return {
    ok: true,
    origem: 'gemini',
    modelo,
    analise: texto,
  };
}
