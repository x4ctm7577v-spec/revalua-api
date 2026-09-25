import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // las fotos en base64 pueden pesar varios MB

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = 'qwen/qwen3.8-27b';

if (!GROQ_API_KEY) {
  console.warn('⚠️  Falta GROQ_API_KEY en las variables de entorno. El servidor no podrá llamar a la IA.');
} else {
  console.log(`✅ GROQ_API_KEY detectada (longitud: ${GROQ_API_KEY.length})`);
}

// ---------- Utilidad central: llamar a Groq (API compatible con OpenAI) ----------
async function callGroq({ systemPrompt, userContent, maxTokens = 1000 }) {
  if (!GROQ_API_KEY) {
    throw new Error('El servidor no tiene configurada GROQ_API_KEY. Revisa las Variables en Railway.');
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userContent });

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Error de la API de Groq (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  return (choice && choice.message && choice.message.content) || '';
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No se pudo interpretar la respuesta del modelo.');
  return JSON.parse(match[0]);
}

// Construye enlaces de búsqueda REALES nosotros mismos (no la IA), para nunca inventar URLs
function buildSearchLinks(itemName) {
  const q = encodeURIComponent(itemName || '');
  return [
    { source: 'eBay', url: `https://www.ebay.com/sch/i.html?_nkw=${q}` },
    { source: 'Facebook Marketplace', url: `https://www.facebook.com/marketplace/search/?query=${q}` },
    { source: 'Mercado Libre', url: `https://listado.mercadolibre.com/${q}` },
    { source: 'OfferUp', url: `https://offerup.com/search/?q=${q}` },
  ];
}

// ---------- 1) Tasar un artículo (vender) ----------
app.post('/api/analyze-item', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Falta imageBase64 en el cuerpo de la petición.' });

    const systemPrompt = [
      'Eres un tasador experto en artículos de segunda mano (electrónica, ropa, relojes, cámaras, muebles, etc.).',
      'Identifica el artículo en la imagen y evalúa su estado visual.',
      'No tienes acceso a búsqueda web en vivo: da tu mejor estimación razonada usando tu conocimiento general de precios típicos de reventa.',
      'Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown ni backticks, con exactamente estas claves:',
      'item_name (string), category (string), condition (string, ej. "Como nuevo", "Buen estado", "Uso visible"),',
      'estimated_value_low (number), estimated_value_high (number), suggested_price (number), currency (string, código de 3 letras, ej. USD),',
      'title (string, título de anuncio atractivo, máximo 70 caracteres), description (string, 3 a 4 frases persuasivas para el anuncio),',
      'market_notes (string, una frase breve aclarando que es una estimación general). Da todos los valores en dólares estadounidenses (USD). Todo el texto en español.',
    ].join(' ');

    const userContent = [
      { type: 'text', text: 'Evalúa este artículo y genera el anuncio de venta.' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
    ];

    const text = await callGroq({ systemPrompt, userContent, maxTokens: 1000 });
    const result = extractJson(text);
    result.currency = 'USD';
    res.json(result);
  } catch (e) {
    console.error('analyze-item:', e);
    res.status(500).json({ error: e.message || 'Error interno del servidor.' });
  }
});

// ---------- 2) Identificar y comprar ----------
app.post('/api/analyze-purchase', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Falta imageBase64 en el cuerpo de la petición.' });

    const systemPrompt = [
      'Identifica el artículo o pieza en la imagen con la mayor precisión posible (marca, modelo, número de parte si es visible).',
      'Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown ni backticks, con estas claves:',
      'item_name (string, lo más específico posible para buscarlo), description (string, una frase breve describiendo el artículo). Todo el texto en español.',
    ].join(' ');

    const userContent = [
      { type: 'text', text: 'Identifica esta pieza o artículo.' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
    ];

    const text = await callGroq({ systemPrompt, userContent, maxTokens: 300 });
    const identified = extractJson(text);

    const results = buildSearchLinks(identified.item_name).map((r) => ({
      title: `Buscar "${identified.item_name}" en ${r.source}`,
      price: null,
      currency: null,
      source: r.source,
      url: r.url,
    }));

    res.json({ item_name: identified.item_name, description: identified.description, results });
  } catch (e) {
    console.error('analyze-purchase:', e);
    res.status(500).json({ error: e.message || 'Error interno del servidor.' });
  }
});

// ---------- 3) Asistente de negociación ----------
app.post('/api/negotiate', async (req, res) => {
  try {
    const { itemContext, buyerMessage } = req.body;
    if (!buyerMessage) return res.status(400).json({ error: 'Falta buyerMessage en el cuerpo de la petición.' });

    const systemPrompt = 'Eres un asistente de ventas que ayuda a un vendedor particular a responder compradores que negocian el precio en Facebook Marketplace u OfferUp. Responde en español, tono amable pero firme, protegiendo el margen del vendedor. Da ÚNICAMENTE la respuesta sugerida lista para copiar y pegar, en 2 a 4 frases, sin explicaciones adicionales ni comillas.';
    const userContent = `Artículo: ${itemContext || 'sin especificar'}\nMensaje del comprador: "${buyerMessage}"\n\nSugiere una respuesta.`;

    const text = await callGroq({ systemPrompt, userContent, maxTokens: 300 });
    res.json({ reply: text.trim() });
  } catch (e) {
    console.error('negotiate:', e);
    res.status(500).json({ error: e.message || 'Error interno del servidor.' });
  }
});

// ---------- 4) Sugerir bajar precio ----------
app.post('/api/price-drop', async (req, res) => {
  try {
    const { title, category, condition, currency, price } = req.body;
    if (!title || price == null) return res.status(400).json({ error: 'Faltan datos del artículo (title, price).' });

    const systemPrompt = 'Eres un asesor de precios para ventas de artículos de segunda mano. No tienes búsqueda web en vivo: usa tu conocimiento general para sugerir, en una sola frase breve en español, si conviene bajar el precio y a cuánto, aclarando que es una estimación general.';
    const userContent = `Artículo: ${title}. Categoría: ${category || 'sin especificar'}. Estado: ${condition || 'sin especificar'}. Precio actual: ${currency || 'USD'} ${price}. Lleva más de una semana publicado sin venderse.`;

    const text = await callGroq({ systemPrompt, userContent, maxTokens: 200 });
    res.json({ suggestion: text.trim() });
  } catch (e) {
    console.error('price-drop:', e);
    res.status(500).json({ error: e.message || 'Error interno del servidor.' });
  }
});

app.get('/', (req, res) => {
  res.send('Revalúa API funcionando ✅ (usando Groq)');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Revalúa corriendo en el puerto ${PORT}`);
});
