// Radar Worker v161: URLs RSS canonicalizadas, extração HTML limitada e API Dados Futebol configurada no código.
const FEEDS = {
  "agencia-brasil": {
    name: "Agência Brasil",
    url: "https://agenciabrasil.ebc.com.br/feed/ultimasnoticias/feed.xml",
  },
  g1: {
    name: "G1",
    url: "https://g1.globo.com/rss/g1/",
  },
  "g1-rn": {
    name: "G1 Rio Grande do Norte",
    url: "https://g1.globo.com/rss/g1/rn/",
  },
};

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: HEADERS,
  });
}

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTag(xml, tag) {
  const escaped = tag.replace(":", "\\:");
  const regex = new RegExp(
    `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`,
    "i"
  );
  return decodeXml(xml.match(regex)?.[1] || "");
}

/* Detecta a codificação declarada no cabeçalho HTTP,
   no BOM ou na declaração XML. */
function detectXmlCharset(bytes, contentType = "") {
  const headerMatch = contentType.match(
    /charset\s*=\s*["']?([^;"'\s]+)/i
  );

  if (headerMatch) {
    return headerMatch[1].trim().toLowerCase();
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return "utf-8";
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }

  const prefix = new TextDecoder("windows-1252")
    .decode(bytes.slice(0, 512));

  const xmlMatch = prefix.match(
    /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i
  );

  if (xmlMatch) {
    return xmlMatch[1].trim().toLowerCase();
  }

  return "utf-8";
}

function decodeFeedBytes(bytes, contentType = "") {
  const charset = detectXmlCharset(bytes, contentType);

  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    for (const fallback of [
      "windows-1252",
      "iso-8859-1",
      "utf-8",
    ]) {
      try {
       return new TextDecoder(fallback).decode(bytes);
      } catch {
        // Tenta a próxima codificação.
      }
    }

    throw new Error(
      `Não foi possível decodificar o feed (charset informado: ${charset}).`
    );
  }
}

function parseFeed(xml, source, limit = 15) {
  const blocks = [
    ...xml.matchAll(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1\s*>/gi),
  ];

  return blocks.slice(0, limit).map((match) => {
    const item = match[0];

    const atomLink = item.match(
      /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i
    );

    const title = getTag(item, "title");
    const link = getTag(item, "link") || atomLink?.[1] || "";

    const rawDate =
      getTag(item, "pubDate") ||
      getTag(item, "published") ||
      getTag(item, "updated") ||
      getTag(item, "dc:date");

    const description =
      getTag(item, "description") ||
      getTag(item, "summary") ||
      getTag(item, "content:encoded");

    const timestamp = rawDate ? Date.parse(rawDate) : NaN;

    return {
      title,
      url: link,
      date: Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString()
        : rawDate,
      summary: description.slice(0, 1200),
      source: source.name,
    };
  }).filter((item) => {
    try {
      return item.title &&
        item.url &&
        ["http:", "https:"].includes(new URL(item.url).protocol);
    } catch {
      return false;
    }
  });
}

function validateUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Informe uma URL válida.");
  }

  const host = url.hostname.toLowerCase();

  if (url.protocol !== "https:") {
    throw new Error("Por segurança, o feed precisa usar HTTPS.");
  }

  if (
    url.username ||
    url.password ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid") ||
    host.endsWith(".example") ||
    host === "metadata.google.internal" ||
    /^[0-9.]+$/.test(host) ||
    host.startsWith("[")
  ) {
    throw new Error("Endereço não permitido.");
  }

  return url;
}

async function safeFetchFeed(value) {
  let url = validateUrl(value);

  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "RadarNewsCollector/1.0",
        "Accept":
          "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");

      if (!location) {
        throw new Error("Redirecionamento sem destino.");
      }

      url = validateUrl(new URL(location, url).href);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `A fonte respondeu com HTTP ${response.status}.`
      );
    }

    // Lê os bytes originais para permitir a detecção do charset.
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (bytes.byteLength > 3_000_000) {
      throw new Error("O feed excedeu o limite de tamanho.");
    }

    const contentType = response.headers.get("Content-Type") || "";
    const xml = decodeFeedBytes(bytes, contentType);

    return xml.replace(/^\uFEFF/, "");
  }

  throw new Error("A fonte excedeu o limite de redirecionamentos.");
}

async function collectSource(source, limit = 15) {
  const xml = await safeFetchFeed(source.url);
  const items = parseFeed(xml, source, limit);

  if (!items.length) {
    throw new Error(
      "Nenhuma notícia reconhecida. Verifique se a URL é um feed RSS/Atom."
    );
  }

  return {
    name: source.name,
    url: source.url,
    ok: true,
    count: items.length,
    items,
  };
}

function canonicalFeedUrl(value = "") {
  try {
    const url = new URL(String(value).trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|mc_cid|mc_eid|ref|ref_src|_ga)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    return url.toString().replace(/\?$/, "");
  } catch {
    return String(value).trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

function deduplicate(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = canonicalFeedUrl(item.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeBulletinText(value = "") {
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    // Preserve o destino do hiperlink antes de remover as tags HTML.
    .replace(/<a\b[^>]*href\s*=\s*(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi,
      (_, quote, href, label) => `${label.replace(/<[^>]+>/g, " ").trim()} (${href})`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBulletinItems(text) {
  // Exclui a seção de destaques/recomendações, que também usa numeração.
  const prioritySection = text.search(/(?:^|\n)\s*PAUTAS PRIORITÁRIAS\b/i);
  const mainText = prioritySection >= 0 ? text.slice(0, prioritySection) : text;

  // Mantém todos os títulos numerados como limites de trecho, mas não transforma
  // cabeçalhos de editoria em notícias.
  const allMatches = [...mainText.matchAll(/(?:^|\n)\s*(\d{1,2})[.)]\s+([^\n]{8,240})/g)];
  const sectionHeadings = new Set([
    "POLÍTICA E ELEIÇÕES",
    "ECONOMIA",
    "CULTURA E PATRIMÔNIO POTIGUAR",
    "ESPORTES",
  ]);

  return allMatches
    .filter((match) => !sectionHeadings.has(match[2].trim().toLocaleUpperCase("pt-BR")))
    .map((match) => {
      const nextBoundary = allMatches.find((candidate) => candidate.index > match.index);
      const excerptWithLinks = mainText.slice(
        match.index + match[0].length,
        nextBoundary ? nextBoundary.index : mainText.length
      ).trim().slice(0, 2500);
      const urlMatch = excerptWithLinks.match(/https?:\/\/[^\s<>"')]+/i);
      const url = urlMatch ? urlMatch[0].replace(/[),.;]+$/, "") : "";
      const excerpt = excerptWithLinks
        .replace(/\s*\(https?:\/\/[^)]+\)/gi, "")
        .replace(/https?:\/\/[^\s<>"')]+/gi, "")
        .trim();
      return {
        number: Number(match[1]),
        title: match[2].trim(),
        excerpt,
        url,
      };
    });
}

async function hasValidImportToken(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match || !env.RADAR_IMPORT_TOKEN ||
      typeof env.RADAR_IMPORT_TOKEN.get !== "function") {
    return false;
  }

  const expected = await env.RADAR_IMPORT_TOKEN.get();
  if (!expected) return false;

  const received = match[1].trim();
  if (received.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < received.length; i++) {
    diff |= received.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function handleBulletinImport(request, env, json) {
  if (!(await hasValidImportToken(request, env))) {
    return json({ ok: false, error: "Não autorizado." }, 401);
  }

  if (!env.RADAR_BOLETINS) {
    return json({ ok: false, error: "KV não configurado." }, 500);
  }

  try {
    const body = await request.json();
    const subject = String(body.subject || "").trim();
    const text = normalizeBulletinText(body.body || "");

    if (!/resumo jornal[ií]stico di[aá]rio/i.test(subject)) {
      return json({ ok: false, error: "Assunto não reconhecido." }, 400);
    }

    if (text.length < 500) {
      return json({ ok: false, error: "Corpo do boletim muito curto." }, 400);
    }

    const items = extractBulletinItems(text);
    if (items.length < 3) {
      return json({
        ok: false,
        error: "Não foi possível reconhecer as notícias numeradas."
      }, 422);
    }

    const messageId = String(body.messageId || "").trim();
    const fingerprint = messageId || `${subject}:${text.slice(0, 200)}`;
    const key = `message:${encodeURIComponent(fingerprint).slice(0, 200)}`;

    const existing = await env.RADAR_BOLETINS.get(key);
    let previousRecord = null;
    if (existing) {
      try { previousRecord = JSON.parse(existing); } catch { previousRecord = null; }
      // Sempre reprocessa o mesmo e-mail: uma nova versão do parser pode recuperar
      // URLs que não foram salvas na primeira importação.
    }

    const record = {
      subject,
      receivedAt: body.receivedAt || new Date().toISOString(),
      importedAt: new Date().toISOString(),
      text,
      count: items.length,
      items
    };

    await env.RADAR_BOLETINS.put(key, JSON.stringify(record), {
      expirationTtl: 10368000
    });
    await env.RADAR_BOLETINS.put("latest", JSON.stringify(record), {
      expirationTtl: 10368000
    });

    return json({
      ok: true,
      duplicate: false,
      updated: Boolean(existing),
      count: items.length,
      linksFound: items.filter((item) => item.url).length
    }, existing ? 200 : 201);
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Falha ao importar."
    }, 400);
  }
}

async function handleLatestBulletin(env, json) {
  const value = await env.RADAR_BOLETINS.get("latest");
  if (!value) {
    return json({ ok: false, error: "Nenhum boletim importado." }, 404);
  }
  return json({ ok: true, bulletin: JSON.parse(value) });
}


const OUTLOOK_CLIENT_ID = "b6d73d99-93ab-484f-b798-0b6d535e6599";
const OUTLOOK_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const OUTLOOK_GRAPH_URL = "https://graph.microsoft.com/v1.0";

async function getOutlookRefreshToken(env) {
  // Depois da primeira renovação, prioriza o token rotacionado salvo no KV.
  const saved = env.RADAR_OUTLOOK_AUTH
    ? await env.RADAR_OUTLOOK_AUTH.get("refresh_token")
    : null;

  if (saved) return saved;

  // O segredo inicial precisa estar vinculado ao Worker com este nome.
  const secret = env.RADAR_OUTLOOK_REFRESH_TOKEN;
  if (!secret || typeof secret.get !== "function") {
    throw new Error(
      "Segredo RADAR_OUTLOOK_REFRESH_TOKEN não está vinculado ao Worker."
    );
  }

  const value = await secret.get();
  if (!value) {
    throw new Error("O segredo inicial do Outlook está vazio.");
  }
  return value;
}

async function getOutlookAccessToken(env) {
  const refreshToken = await getOutlookRefreshToken(env);
  const form = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read",
  });

  const response = await fetch(OUTLOOK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(15000),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) {
    // Não retornar o corpo do erro OAuth, pois ele pode conter dados sensíveis.
    const code = String(result.error || "oauth_error").slice(0, 80);
    throw new Error(`Não foi possível renovar a autorização do Outlook (${code}).`);
  }

  // A Microsoft pode rotacionar o refresh token. Salve o novo no KV;
  // o segredo do Secrets Store funciona como token inicial/fallback.
  if (result.refresh_token && env.RADAR_OUTLOOK_AUTH) {
    await env.RADAR_OUTLOOK_AUTH.put("refresh_token", result.refresh_token);
  }

  return result.access_token;
}

async function handleOutlookImport(request, env, json) {
  if (!(await hasValidImportToken(request, env))) {
    return json({ ok: false, error: "Não autorizado." }, 401);
  }

  if (!env.RADAR_BOLETINS) {
    return json({ ok: false, error: "KV de boletins não configurado." }, 500);
  }

  try {
    const accessToken = await getOutlookAccessToken(env);
    const select = "id,subject,body,receivedDateTime,internetMessageId";
    // Consulta explicitamente a Caixa de Entrada para não depender da pasta
    // padrão nem combinar filtros que podem causar InefficientFilter.
    const graphUrl = new URL(`${OUTLOOK_GRAPH_URL}/me/mailFolders/inbox/messages`);
    graphUrl.searchParams.set("$orderby", "receivedDateTime desc");
    graphUrl.searchParams.set("$top", "100");
    graphUrl.searchParams.set("$select", select);

    const response = await fetch(graphUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        Prefer: 'outlook.body-content-type="html"',
      },
      signal: AbortSignal.timeout(20000),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = String(result.error?.code || "graph_error").slice(0, 80);
      throw new Error(`Não foi possível consultar o Outlook (${code}).`);
    }

    const messages = Array.isArray(result.value) ? result.value : [];
    const message = messages.find((item) =>
      /resumo jornal[ií]stico di[aá]rio/i.test(String(item.subject || ""))
    );

    if (!message) {
      return json({
        ok: true,
        imported: false,
        message: "Nenhum e-mail com o assunto esperado foi encontrado nas mensagens recentes da Caixa de Entrada.",
        checked: messages.length,
      });
    }

    const content = typeof message.body === "string"
      ? message.body
      : String(message.body?.content || "");
    const syntheticRequest = new Request(new URL("/api/boletim-chatgpt", request.url), {
      method: "POST",
      headers: {
        Authorization: request.headers.get("Authorization") || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject: message.subject,
        body: content,
        messageId: message.id || message.internetMessageId || "",
        receivedAt: message.receivedDateTime || new Date().toISOString(),
      }),
    });

    const importedResponse = await handleBulletinImport(syntheticRequest, env, json);
    const importedData = await importedResponse.json();

    return json({
      ...importedData,
      imported: importedData.ok === true && importedData.duplicate !== true,
      source: "outlook",
      checked: messages.length,
    }, importedResponse.status);
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Falha ao importar o boletim do Outlook.",
    }, 502);
  }
}

function normalizeSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("Informe pelo menos uma fonte.");
  }

  if (sources.length > 30) {
    throw new Error("O limite é de 30 fontes por coleta.");
  }

  return sources.map((source) => {
    const name = String(source?.name || "").trim().slice(0, 100);
    const url = String(source?.url || "").trim();

    if (!name) {
      throw new Error("Toda fonte precisa ter um nome.");
    }

    validateUrl(url);

    return { name, url };
  });
}

function getLimit(value) {
  const number = Number(value ?? 15);

  return Number.isFinite(number)
    ? Math.max(1, Math.min(30, Math.floor(number)))
    : 15;
}

async function collectMany(sources, limit) {
  const results = await Promise.allSettled(
    sources.map((source) => collectSource(source, limit))
  );

  const sourceResults = results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    return {
      name: sources[index].name,
      url: sources[index].url,
      ok: false,
      count: 0,
      items: [],
      error: result.reason?.message || "Falha na coleta.",
    };
  });

  const items = deduplicate(
    sourceResults.flatMap((source) => source.items)
  ).sort(
    (a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)
  );

  const successful = sourceResults.filter(
    (source) => source.ok
  ).length;

  return {
    ok: successful > 0,
    partial: successful > 0 && successful < sourceResults.length,
    collectedAt: new Date().toISOString(),
    sourceCount: sourceResults.length,
    successfulSources: successful,
    failedSources: sourceResults.length - successful,
    count: items.length,
    sources: sourceResults,
    items,
  };
}


function decodeHtmlEntities(value = "") {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripArticleHtml(value = "") {
  return decodeHtmlEntities(String(value)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|button)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|article|section)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[\t\r\f\v ]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function htmlAttr(html, attr, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<meta\\b(?=[^>]*\\b${attr}\\s*=\\s*["']${escaped}["'])[^>]*>`, "i");
  const tag = html.match(re)?.[0] || "";
  return tag.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] || "";
}

function firstMeta(html, candidates) {
  for (const [attr, value] of candidates) {
    const found = htmlAttr(html, attr, value);
    if (found.trim()) return decodeHtmlEntities(found).trim();
  }
  return "";
}

function extractArticleFields(html, pageUrl) {
  const title = firstMeta(html, [
    ["property", "og:title"], ["name", "twitter:title"], ["name", "title"]
  ]) || decodeHtmlEntities((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<[^>]+>/g, " ")).trim();

  const description = firstMeta(html, [
    ["property", "og:description"], ["name", "description"],
    ["name", "twitter:description"], ["property", "article:description"]
  ]);

  let date = firstMeta(html, [
    ["property", "article:published_time"], ["name", "datePublished"], ["itemprop", "datePublished"],
    ["name", "pubdate"], ["name", "publishdate"], ["name", "publication_date"], ["name", "date"]
  ]);

  // Muitos portais modernos guardam corpo e data no JSON-LD, mesmo quando
  // o HTML visível contém apenas um contêiner vazio renderizado por JavaScript.
  let structuredBody = "";
  const ldScripts = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].slice(0, 12);
  for (const match of ldScripts) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (!date && (node.datePublished || node.dateCreated || node.dateModified)) {
          date = String(node.datePublished || node.dateCreated || node.dateModified);
        }
        const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : String(node["@type"] || "");
        if (!structuredBody && (node.articleBody || /Article|NewsArticle|BlogPosting/i.test(type))) {
          structuredBody = String(node.articleBody || node.description || "");
        }
        if (!structuredBody && node.description && /Article|NewsArticle|BlogPosting/i.test(type)) {
          structuredBody = String(node.description);
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) stack.push(...value);
          else if (value && typeof value === "object") stack.push(value);
        }
      }
    } catch {}
  }

  const parsedDate = date ? new Date(date) : null;
  const publishedAt = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString() : "";

  // Remove elementos de navegação/rodapé antes de procurar os parágrafos.
  let cleanedHtml = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");

  // Primeiro tenta o contêiner editorial conhecido. Depois usa <article>/<main>.
  // A captura global de parágrafos abaixo evita perder o texto quando o contêiner
  // possui elementos div aninhados e uma expressão regular fecha cedo demais.
  let bodyHtml = "";
  const bodyStart = cleanedHtml.search(/<(?:div|section|article)\b[^>]*(?:itemprop\s*=\s*["']articleBody["']|class\s*=\s*["'][^"']*(?:article-body|article__body|article-content|article__content|post-content|entry-content|story-body|materia-conteudo|content-text|texto-materia|materia__conteudo|glb-materia)[^"']*["'])[^>]*>/i);
  if (bodyStart >= 0) {
    const openTag = cleanedHtml.slice(bodyStart).match(/^<(div|section|article)\b[^>]*>/i);
    if (openTag) {
      const tagName = openTag[1];
      const afterOpen = bodyStart + openTag[0].length;
      const closing = new RegExp(`<\\/${tagName}\\s*>`, "ig");
      closing.lastIndex = afterOpen;
      let depth = 1, match;
      // Contagem simples de tags iguais para suportar divs aninhadas.
      const tokens = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "ig");
      tokens.lastIndex = afterOpen;
      while ((match = tokens.exec(cleanedHtml))) {
        if (/^<\//.test(match[0])) depth--;
        else if (!/\/\s*>$/.test(match[0])) depth++;
        if (depth === 0) { bodyHtml = cleanedHtml.slice(afterOpen, match.index); break; }
      }
    }
  }
  if (!bodyHtml) bodyHtml = cleanedHtml.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i)?.[1] || "";
  if (!bodyHtml) bodyHtml = cleanedHtml.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1] || "";
  if (!bodyHtml) bodyHtml = cleanedHtml;

  const paragraphSource = bodyHtml + "\n" + cleanedHtml;
  let paragraphs = [...paragraphSource.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)]
    .map(match => stripArticleHtml(match[1]))
    .filter(text => text.length >= 35 && !/^(compartilhe|leia também|publicidade|patrocinado|veja também|siga o g1|assine|ouça|foto:|vídeo:)/i.test(text))
    .filter((text, index, all) => all.indexOf(text) === index)
    .slice(0, 8);

  let lead = paragraphs.slice(0, 2).join(" ").trim();
  // O texto estruturado costuma ser a fonte mais completa para páginas dinâmicas.
  if (structuredBody) {
    const structuredText = stripArticleHtml(structuredBody.replace(/\\n/g, " "));
    if (structuredText.length > lead.length) {
      lead = structuredText;
      paragraphs = [structuredText, ...paragraphs].filter((text, index, all) => text && all.indexOf(text) === index);
    }
  }
  if (!lead && description) lead = stripArticleHtml(description);
  if (!lead) lead = stripArticleHtml(bodyHtml).slice(0, 700).trim();
  lead = lead.slice(0, 1200);
  const summary = (paragraphs.join(" ") || lead || description).slice(0, 2400);

  return {
    ok: Boolean(title || lead || publishedAt),
    title: title.slice(0, 300),
    date: publishedAt,
    lead,
    summary,
    source: new URL(pageUrl).hostname.replace(/^www\./, ""),
    url: pageUrl,
  };
}

async function readTextLimited(response, maxBytes = 1800000) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("A página excedeu o limite de tamanho permitido.");
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error("A página excedeu o limite de tamanho permitido.");
    return new TextDecoder().decode(buffer);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("A página excedeu o limite de tamanho permitido.");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

async function fetchPublicHtmlPage(value) {
  let target = validateUrl(value);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(target.href, {
      method: "GET",
      redirect: "manual",
      headers: {
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "User-Agent": "Mozilla/5.0 (compatible; RadarNewsCollector/1.0)"
      },
      signal: AbortSignal.timeout(12000),
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || hop === 3) throw new Error("A página redirecionou muitas vezes.");
      target = validateUrl(new URL(location, target).href);
      continue;
    }
    if (!response.ok) throw new Error(`O site respondeu com HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error("A URL não retornou uma página HTML.");
    }
    const html = await readTextLimited(response, 1800000);
    return { html, url: target.href };
  }
  throw new Error("Limite de redirecionamentos excedido.");
}

function extractListingLinks(html, pageUrl, limit = 8) {
  const base = new URL(pageUrl);
  const ignored = /^(javascript:|mailto:|tel:|#)/i;
  const skipPath = /\/(tag|tags|categoria|categorias|category|author|autor|busca|search|login|contato|sobre|politica-de-privacidade|termos|video|videos|galeria|galerias|podcast)(\/|$)/i;
  const seen = new Set();
  const found = [];
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].slice(0, 3000);
  for (const match of anchors) {
    const href = match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2] || "";
    if (!href || ignored.test(href)) continue;
    let url;
    try { url = new URL(decodeHtmlEntities(href), base); } catch { continue; }
    if (!["http:","https:"].includes(url.protocol)) continue;
    if (url.hostname.toLowerCase().replace(/^www\./,"") !== base.hostname.toLowerCase().replace(/^www\./,"")) continue;
    url.hash = "";
    if (url.pathname === base.pathname || skipPath.test(url.pathname)) continue;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|xml|rss|mp4|mp3)$/i.test(url.pathname)) continue;
    const title = stripArticleHtml(match[2]).replace(/\s+/g," ").trim();
    if (title.length < 18 || title.length > 240) continue;
    const segments = url.pathname.split("/").filter(Boolean);
    const slug = segments[segments.length - 1] || "";
    if (segments.length < 2 && !/-/.test(slug) && slug.length < 24) continue;
    const canonical = url.href.replace(/\/$/,"");
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    found.push({ url: canonical, title });
    if (found.length >= Math.max(1, Math.min(12, limit * 2))) break;
  }
  return found;
}

async function collectHtmlSource(source, limit = 8) {
  const listing = await fetchPublicHtmlPage(source.url);
  const candidates = extractListingLinks(listing.html, listing.url, limit);
  if (!candidates.length) {
    throw new Error("Não foram encontrados links de matérias reconhecíveis nessa página. Tente uma página de editoria ou notícias.");
  }
  const items = [];
  for (const candidate of candidates) {
    if (items.length >= limit) break;
    try {
      const page = await fetchPublicHtmlPage(candidate.url);
      if (new URL(page.url).hostname.toLowerCase().replace(/^www\./,"") !== new URL(listing.url).hostname.toLowerCase().replace(/^www\./,"")) continue;
      const article = extractArticleFields(page.html, page.url);
      const title = article.title || candidate.title;
      if (!title || title.length < 12) continue;
      items.push({
        title, url: page.url, date: article.date || "",
        summary: article.summary || article.lead || "",
        lead: article.lead || "", source: source.name, collectionMethod: "HTML",
      });
    } catch (error) {
      // Uma matéria inacessível não interrompe a coleta das demais.
    }
  }
  if (!items.length) {
    throw new Error("Os links foram encontrados, mas não foi possível extrair matérias. O site pode exigir JavaScript ou bloquear acessos automatizados.");
  }
  return { ok: true, name: source.name, url: source.url, count: items.length, items, collectionMethod: "HTML" };
}

async function handleExtractArticle(request, json) {
  try {
    const body = await request.json();
    const rawUrl = String(body.url || "").trim();
    let target = validateUrl(rawUrl);
    // Mantém o endpoint restrito a páginas públicas HTTPS e valida cada redirecionamento.
    let response = null;
    for (let hop = 0; hop < 4; hop++) {
      response = await fetch(target.href, {
        method: "GET",
        redirect: "manual",
        headers: {
          "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "User-Agent": "Mozilla/5.0 (compatible; RadarNews/1.0; +https://radar-api.gerlaneoliv.workers.dev)"
        },
        signal: AbortSignal.timeout(12000),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || hop === 3) throw new Error("A página redirecionou muitas vezes ou não informou o destino.");
      target = validateUrl(new URL(location, target).href);
    }
    if (!response || !response.ok) throw new Error(`O site respondeu com HTTP ${response?.status || "desconhecido"}.`);
    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error("O endereço não retornou uma página HTML.");
    const html = await readTextLimited(response, 1800000);
    const result = extractArticleFields(html, target.href);
    if (!result.ok) throw new Error("Não foram encontrados título, texto inicial ou data na página.");
    return json(result);
  } catch (error) {
    return json({ ok: false, error: String(error?.message || "Não foi possível extrair a notícia.").slice(0, 240) }, 422);
  }
}



// V154: na segunda-feira mostra resultados do sábado e domingo; nos outros dias, ontem e hoje.
// V154: inclui também a agenda de Jogos do Dia a partir da mesma consulta às rodadas, sem rota ao vivo.
// V151: ordena Série A primeiro; Séries B-D só entram com clubes potiguares em partidas recentes.
// V149: usa /rodadas (liberado no plano Free para Brasileirão A-D e Copa do Brasil).
// V148: usa a rota básica do catálogo para plano Free e informa a rota em erros 401/403.
// V160: integração Dados Futebol configurada por Secret Binding do Cloudflare Worker.
// Defina DADOSFUTEBOL_API_KEY com wrangler secret put; nunca grave a chave no repositório.
const DADOSFUTEBOL_API_BASE = "https://api.dadosfutebol.com.br";

async function getDadosFutebolApiKey(env) {
  return String(env?.DADOSFUTEBOL_API_KEY || "").trim();
}
const FOOTBALL_COMPETITION_CACHE_TTL = 86400;
const FOOTBALL_FIXTURE_CACHE_TTL = 21600; // placares históricos: cache de 6 horas para poupar a cota Free
const FOOTBALL_COMPETITION_RESPONSE_TTL = 21600;
const FOOTBALL_TEAM_RESPONSE_TTL = 21600;

function footballDateInNatal(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  const today = `${get("year")}-${get("month")}-${get("day")}`;
  return footballShiftCalendarDate(today, offsetDays);
}

function footballShiftCalendarDate(dateString, offsetDays = 0) {
  const match = String(dateString || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateString;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offsetDays));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function footballResultsDateWindow(today = footballDateInNatal(0)) {
  const match = String(today).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const weekdayNumber = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay() : -1;
  if (weekdayNumber === 1) {
    // Na segunda-feira, o bloco de resultados cobre apenas o fim de semana anterior.
    return { from: footballShiftCalendarDate(today, -2), to: footballShiftCalendarDate(today, -1), today, mode: "weekend" };
  }
  // Nos demais dias, só hoje e ontem.
  return { from: footballShiftCalendarDate(today, -1), to: today, today, mode: "daily" };
}

function footballNormalize(value = "") {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function footballApiGet(path, env, ttl = FOOTBALL_FIXTURE_CACHE_TTL) {
  const apiKey = await getDadosFutebolApiKey(env);
  if (!apiKey) {
    const error = new Error("Secret DADOSFUTEBOL_API_KEY não foi configurado no ambiente do Worker.");
    error.code = "missing_api_key";
    throw error;
  }
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheRequest = new Request(`https://radar-football-cache.invalid/dados-futebol/${encodeURIComponent(path)}`);
  if (cache) {
    try {
      const cached = await cache.match(cacheRequest);
      if (cached) return await cached.json();
    } catch (_) { /* cache opcional; consulta à API continua */ }
  }

  const response = await fetch(`${DADOSFUTEBOL_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  let data;
  try { data = await response.json(); } catch (_) { data = null; }
  if (!response.ok || !data || data.erro) {
    const baseMessage = data?.mensagem || data?.message || (response.status === 403
      ? "A API Dados Futebol recusou o acesso a esse recurso no plano atual."
      : response.status === 401
        ? "A chave da API não foi aceita. Confira se está ativa no painel Dados Futebol."
        : `Dados Futebol respondeu HTTP ${response.status}.`);
    // Expõe o endpoint recusado, sem revelar a chave, para facilitar o diagnóstico do plano.
    const endpointPath = String(path).split("?")[0];
    const message = `${baseMessage} (rota consultada: ${endpointPath})`;
    const error = new Error(String(message));
    error.status = response.status || 502;
    error.code = response.status === 401 ? "invalid_api_key" : response.status === 403 ? "plan_insufficient" : "dados_futebol_api_error";
    throw error;
  }
  if (cache) {
    try {
      await cache.put(cacheRequest, new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${Math.max(60, ttl)}` },
      }));
    } catch (_) { /* cache opcional */ }
  }
  return data;
}

async function footballLoadCompetitions(season, env) {
  const all = [];
  // Começa pela chamada simples documentada para a conta gratuita: GET /v1/campeonatos.
  // Só usa paginação se a própria resposta informar que há outras páginas; evita
  // pedir o catálogo filtrado por temporada ou 100 itens logo na primeira chamada.
  let lastPage = 1;
  for (let page = 1; page <= 3; page++) {
    const path = page === 1 ? "/v1/campeonatos" : `/v1/campeonatos?pagina=${page}`;
    let result;
    try {
      result = await footballApiGet(path, env, FOOTBALL_COMPETITION_CACHE_TTL);
    } catch (error) {
      // Se a primeira página já trouxe dados, uma restrição de paginação não impede
      // o uso das competições que a chave gratuita disponibilizou.
      if (page > 1 && all.length) break;
      throw error;
    }
    const items = Array.isArray(result.data) ? result.data : [];
    all.push(...items);
    lastPage = Number(result.meta?.ultima_pagina || 1);
    if (!items.length || page >= lastPage) break;
  }
  const seen = new Set();
  const unique = all.filter((c) => {
    const id = Number(c.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  // O catálogo básico pode trazer várias temporadas. Filtra em memória apenas
  // quando o campo temporada está disponível; não exige o filtro na chamada API.
  const seasonMatches = unique.filter((c) => {
    const value = c.temporada ?? c.season;
    return value != null && String(value).slice(0, 4) === String(season);
  });
  return seasonMatches.length ? seasonMatches : unique;
}

function footballIsYouthOrWomenCompetition(competition) {
  const name = footballNormalize(competition?.nome || "");
  return /(feminina|feminino|women|femenina|u17|u18|u19|u20|sub 17|sub 18|sub 19|sub 20|juniores|juvenil)/.test(name);
}

function footballIsFreeRoundsCompetition(competition) {
  const name = footballNormalize(competition?.nome || "");
  if (!name || footballIsYouthOrWomenCompetition(competition)) return false;
  const brasileiraoSeries = /brasileirao serie [abcd]( |$)/.test(name)
    || /serie [abcd] do brasileiro( |$)/.test(name)
    || /campeonato brasileiro serie [abcd]( |$)/.test(name);
  const copaDoBrasil = name.includes("copa do brasil") && !/(sub 17|sub 20|feminina|feminino)/.test(name);
  return brasileiraoSeries || copaDoBrasil;
}

function footballPickCompetitions(list, kind) {
  const comps = (list || []).filter((c) => !footballIsYouthOrWomenCompetition(c));
  const nameOf = (c) => footballNormalize(c.nome || "");
  if (kind === "recent") {
    const rank = (c) => {
      const n = nameOf(c);
      if (/brasileirao serie a|serie a do brasileiro|campeonato brasileiro serie a/.test(n)) return 0;
      if (/brasileirao serie b|serie b do brasileiro|campeonato brasileiro serie b/.test(n)) return 1;
      if (/brasileirao serie c|serie c do brasileiro|campeonato brasileiro serie c/.test(n)) return 2;
      if (/brasileirao serie d|serie d do brasileiro|campeonato brasileiro serie d/.test(n)) return 3;
      if (n.includes("copa do brasil")) return 4;
      return 9;
    };
    return comps.filter(footballIsFreeRoundsCompetition).sort((a,b)=>rank(a)-rank(b)).slice(0,5);
  }
  if (kind === "brasileirao") {
    const found = comps.find((c) => /(^| )brasileirao serie a($| )/.test(nameOf(c)))
      || comps.find((c) => /(^| )serie a($| )/.test(nameOf(c)) && /brasil|brasileir|campeonato/.test(nameOf(c)));
    return found ? [found] : [];
  }
  if (kind === "copa-brasil") return comps.filter((c) => nameOf(c).includes("copa do brasil")).slice(0, 1);
  // A tabela de acesso do plano Free informa que /rodadas só é liberado para
  // Brasileirão A-D e Copa do Brasil. Não tentamos consultar outras competições.
  if (["libertadores", "sulamericana", "potiguar", "selecao", "alecrim"].includes(kind)) return [];
  if (["abc", "america-rn"].includes(kind)) {
    return comps.filter((c) => footballIsFreeRoundsCompetition(c)
      && (/copa do brasil|brasileirao serie [abcd]|serie [abcd] do brasileiro|campeonato brasileiro serie [abcd]/.test(nameOf(c))))
      .slice(0, 8);
  }
  return [];
}

function footballCombinedDateTime(item) {
  if (item.data_hora_realizacao) return item.data_hora_realizacao;
  const date = String(item.data_realizacao || "").trim();
  const time = String(item.hora_realizacao || "00:00").trim();
  const m = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}T${/^\d{2}:\d{2}$/.test(time) ? time : "00:00"}:00-03:00` : null;
}

function footballFormatFixture(item, competition) {
  const home = item.time_mandante || {};
  const away = item.time_visitante || {};
  const phaseName = item.fase?.nome || "";
  return {
    id: item.id ?? `${competition.id}-${item.data_hora_realizacao || item.data_realizacao || ""}-${home.nome || "home"}-${away.nome || "away"}`,
    date: footballCombinedDateTime(item),
    timestamp: footballCombinedDateTime(item) ? Math.floor(new Date(footballCombinedDateTime(item)).getTime() / 1000) : null,
    status: item.status || "aguardando",
    statusLong: item.status || "aguardando",
    elapsed: item.minuto ?? item.tempo_corrente ?? null,
    competition: competition.nome || "",
    round: item.rodada_nome || phaseName || (item.rodada_numero ? `${item.rodada_numero}ª rodada` : ""),
    home: home.nome || "Mandante",
    homeId: home.id ?? null,
    homeLogo: home.escudo_url || "",
    homeScore: item.placar_mandante ?? null,
    away: away.nome || "Visitante",
    awayId: away.id ?? null,
    awayLogo: away.escudo_url || "",
    awayScore: item.placar_visitante ?? null,
    venue: item.estadio || "",
  };
}

function footballTeamMatchesKind(teamName, kind) {
  const name = footballNormalize(teamName);
  if (kind === "abc") return /(^| )abc( fc| futebol clube| de natal)?($| )/.test(name) || name.includes("abc de natal");
  if (kind === "alecrim") return name === "alecrim" || name.includes("alecrim futebol") || name.includes("alecrim rn");
  if (kind === "america-rn") {
    return /america rn/.test(name) || name.includes("america de natal") || name.includes("america natal") || name.includes("america futebol clube rn");
  }
  return false;
}

const FOOTBALL_BRAZILIAN_CLUB_ALIASES = [
  "flamengo","palmeiras","corinthians","sao paulo","santos","botafogo","fluminense","vasco da gama","vasco",
  "gremio","internacional","atletico mineiro","atletico mg","cruzeiro","bahia","fortaleza","ceara","sport recife",
  "sport club do recife","bragantino","rb bragantino","red bull bragantino","mirassol","juventude","vitoria","athletico paranaense",
  "athletico pr","coritiba","goias","cuiaba","avai","chapecoense","america mineiro","america mg","novorizontino",
  "paysandu","remo","crb","operario pr","operario paranaense","vila nova","ponte preta","guarani","ferroviaria",
  "amazonas fc","manaus fc","tombense","ituano","sao bernardo","botafogo sp","botafogo de ribeirao preto","volta redonda",
  "brusque","figueirense","londrina","athletic club mg","y p iranga rs","ypiranga rs","abc fc","abc de natal","abc futebol clube",
  "america rn","america de natal","america natal","alecrim","maringa fc","caxias","sergipe","sampaio correa","nautico","nautico capibaribe",
  "remo pa","cruzeiro mg","atletico goianiense","atletico go","vitoria ba","santa cruz","central pe","treze","campinense",
  "ferroviario ce","floresta ce","aparecidense","altos","confiança","confianca se","sao jose rs","sao jose rs"
].map(footballNormalize);

function footballIsBrazilianClub(teamName) {
  const name = footballNormalize(teamName);
  if (!name) return false;
  return FOOTBALL_BRAZILIAN_CLUB_ALIASES.some((alias) => name === alias || name.startsWith(`${alias} `) || name.includes(` ${alias} `));
}

function footballIsBrazilSelection(teamName) {
  const name = footballNormalize(teamName);
  return name === "brasil" || name === "brazil" || name.includes("selecao brasileira") || name.includes("brazil national");
}

function footballIsCompletedStatus(status) {
  return ["encerrado", "finalizado", "finalizada", "terminado", "terminada", "concluido", "concluida", "finished", "ft", "aet", "pen"].includes(footballNormalize(status));
}

async function footballLoadFixturesForCompetition(competition, from, to, env, includeScheduled = false) {
  if (!footballIsFreeRoundsCompetition(competition)) {
    const error = new Error(`O plano Free permite consultar rodadas apenas do Brasileirão Série A-D e da Copa do Brasil; ${competition?.nome || "esta competição"} não está liberada.`);
    error.status = 403;
    error.code = "plan_insufficient";
    throw error;
  }
  // Uma única consulta por campeonato retorna a rodada completa. No modo agenda,
  // inclui partidas futuras de hoje; no modo resultados, aceita somente encerradas com placar.
  const data = await footballApiGet(`/v1/campeonatos/${Number(competition.id)}/rodadas`, env, FOOTBALL_FIXTURE_CACHE_TTL);
  const rounds = Array.isArray(data.data) ? data.data : [];
  const start = Date.parse(`${from}T00:00:00-03:00`);
  const end = Date.parse(`${to}T23:59:59-03:00`);
  const fixtures = [];
  const excludedStatuses = new Set(["adiado", "postergado", "cancelado", "cancelada", "cancelled", "canceled", "suspenso", "suspensa", "abandonado", "abandonada"]);
  for (const round of rounds) {
    const matches = Array.isArray(round.partidas) ? round.partidas : [];
    for (const match of matches) {
      const status = footballNormalize(match.status || "aguardando");
      const completed = footballIsCompletedStatus(match.status);
      if (includeScheduled) {
        if (excludedStatuses.has(status)) continue;
      } else {
        if (!completed) continue;
        if (match.placar_mandante == null || match.placar_visitante == null) continue;
      }
      const fixture = footballFormatFixture({
        ...match,
        rodada_numero: match.rodada_numero ?? round.numero,
        rodada_nome: match.rodada_nome || round.nome || "",
      }, competition);
      const fixtureTimeMs = Number(fixture.timestamp) * 1000;
      if (!Number.isFinite(fixtureTimeMs) || fixtureTimeMs < start || fixtureTimeMs > end) continue;
      fixtures.push(fixture);
    }
  }
  return fixtures;
}

function footballSortFixtures(fixtures) {
  const now = Date.now();
  const live = new Set(["ao_vivo", "ao vivo", "live", "1h", "ht", "2h", "et", "bt", "p", "int"]);
  return fixtures.sort((a, b) => {
    const al = live.has(footballNormalize(a.status)), bl = live.has(footballNormalize(b.status));
    if (al !== bl) return al ? -1 : 1;
    const at = new Date(a.date || 0).getTime(), bt = new Date(b.date || 0).getTime();
    const ap = at >= now, bp = bt >= now;
    if (ap !== bp) return ap ? -1 : 1;
    return ap ? at - bt : bt - at;
  });
}

function footballDeduplicateFixtures(fixtures) {
  const seen = new Set();
  return fixtures.filter((f) => {
    const id = String(f.id || `${f.date}|${f.home}|${f.away}`);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function footballCompetitionDisplayRank(name) {
  const n = footballNormalize(name || "");
  if (/brasileirao serie a|serie a do brasileiro|campeonato brasileiro serie a/.test(n)) return 0;
  if (/brasileirao serie b|serie b do brasileiro|campeonato brasileiro serie b/.test(n)) return 1;
  if (/brasileirao serie c|serie c do brasileiro|campeonato brasileiro serie c/.test(n)) return 2;
  if (/brasileirao serie d|serie d do brasileiro|campeonato brasileiro serie d/.test(n)) return 3;
  if (n.includes("copa do brasil")) return 4;
  return 9;
}

function footballSortByCompetition(fixtures) {
  return [...fixtures].sort((a, b) => {
    const rank = footballCompetitionDisplayRank(a.competition) - footballCompetitionDisplayRank(b.competition);
    if (rank) return rank;
    return new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
  });
}

function footballIsPotiguarClubName(teamName) {
  const n = footballNormalize(teamName || "");
  const aliases = [
    "abc", "abc de natal", "abc futebol clube", "america rn", "america de natal", "america futebol clube rn",
    "alecrim", "alecrim rn", "potiguar de mossoro", "potiguar mossoro", "globo fc", "globo futebol clube",
    "forca e luz", "santa cruz de natal", "baraunas", "assu", "assu futebol clube", "corintians de caico",
    "potyguar seridoense", "palmeira de goianinha", "uniao atletico potiguar"
  ];
  return aliases.some((alias) => n === alias || n.startsWith(`${alias} `) || n.includes(` ${alias} `));
}

function footballFixtureHasPotiguarClub(fixture) {
  return footballIsPotiguarClubName(fixture.home) || footballIsPotiguarClubName(fixture.away);
}

function footballFixtureDateInNatal(fixture) {
  const timestamp = new Date(fixture?.date || "").getTime();
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function footballFixtureIsWithinDateWindow(fixture, from, to) {
  const date = footballFixtureDateInNatal(fixture);
  return !!date && date >= from && date <= to;
}

function footballSelectRecentFixtures(fixtures, from, to) {
  const eligible = (fixtures || []).filter((fixture) =>
    footballFixtureIsWithinDateWindow(fixture, from, to)
    && footballIsCompletedStatus(fixture.status)
    && fixture.homeScore != null && fixture.awayScore != null
  );
  const sorted = footballSortFixtures(footballDeduplicateFixtures(eligible));
  // Prioridade visual: Série A primeiro, depois B, C, D e Copa do Brasil.
  // Séries B-D só entram quando há clube potiguar envolvido.
  const serieA = sorted.filter((f) => footballCompetitionDisplayRank(f.competition) === 0).slice(0, 8);
  const seriesLower = sorted.filter((f) => {
    const rank = footballCompetitionDisplayRank(f.competition);
    return rank >= 1 && rank <= 3 && footballFixtureHasPotiguarClub(f);
  });
  const copaBrasil = sorted.filter((f) => footballCompetitionDisplayRank(f.competition) === 4).slice(0, 4);
  return footballSortByCompetition(footballDeduplicateFixtures([...serieA, ...seriesLower, ...copaBrasil]));
}

function footballSelectTodayFixtures(fixtures, today) {
  const excludedStatuses = new Set(["adiado", "postergado", "cancelado", "cancelada", "cancelled", "canceled", "suspenso", "suspensa", "abandonado", "abandonada"]);
  const eligible = footballDeduplicateFixtures(fixtures || []).filter((fixture) => {
    if (footballFixtureDateInNatal(fixture) !== today) return false;
    return !excludedStatuses.has(footballNormalize(fixture.status));
  }).filter((fixture) => {
    const rank = footballCompetitionDisplayRank(fixture.competition);
    if (rank === 0 || rank === 4) return true; // Série A e Copa do Brasil: jogos do dia
    if (rank >= 1 && rank <= 3) return footballFixtureHasPotiguarClub(fixture);
    return false;
  });
  return eligible.sort((a, b) => {
    const rank = footballCompetitionDisplayRank(a.competition) - footballCompetitionDisplayRank(b.competition);
    if (rank) return rank;
    return new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime();
  });
}

async function handleFootball(request, env) {
  const url = new URL(request.url);
  const competition = String(url.searchParams.get("competition") || "brasileirao").trim().toLowerCase();
  const supported = new Set(["recent", "brasileirao", "copa-brasil", "libertadores", "sulamericana", "selecao", "potiguar", "abc", "america-rn", "alecrim"]);
  if (!supported.has(competition)) return json({ ok: false, error: "Competição ou clube inválido." }, 400);
  const season = Number(new Intl.DateTimeFormat("en", { timeZone: "America/Fortaleza", year: "numeric" }).format(new Date()));
  const window = footballResultsDateWindow();
  const { from, to, today, mode } = window;
  // O catálogo de rodadas é lido até hoje para que a mesma resposta possa montar
  // tanto os resultados do período quanto a agenda de partidas marcadas para hoje.
  const fetchFrom = from;
  const isTeamView = ["abc", "america-rn", "alecrim"].includes(competition);
  const responseTtl = isTeamView ? FOOTBALL_TEAM_RESPONSE_TTL : FOOTBALL_COMPETITION_RESPONSE_TTL;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheRequest = new Request(`${url.origin}/api/football?competition=${encodeURIComponent(competition)}&season=${season}&from=${from}&to=${to}&today=${today}&rules=154`);
  if (cache && url.searchParams.get("refresh") !== "1") {
    try {
      const cached = await cache.match(cacheRequest);
      if (cached) return new Response(cached.body, { status: cached.status, headers: { ...Object.fromEntries(cached.headers), "X-Radar-Cache": "HIT" } });
    } catch (_) { /* cache opcional */ }
  }

  try {
    const allCompetitions = await footballLoadCompetitions(season, env);
    const requestedCompetitions = footballPickCompetitions(allCompetitions, competition);
    const selectedCompetitions = requestedCompetitions.filter(footballIsFreeRoundsCompetition);
    if (!selectedCompetitions.length) {
      const label = ({brasileirao:"Brasileirão Série A", "copa-brasil":"Copa do Brasil", libertadores:"Libertadores", sulamericana:"Sul-Americana", selecao:"Seleção Brasileira", potiguar:"Campeonato Potiguar", abc:"ABC FC", "america-rn":"América-RN", alecrim:"Alecrim-RN"})[competition] || competition;
      let note;
      if (competition === "recent") {
        note = "Não foram retornadas competições com rodadas acessíveis no plano Free. A agenda e os resultados usam Brasileirão Série A-D e Copa do Brasil, conforme o acesso disponível.";
      } else if (["libertadores", "sulamericana", "potiguar", "selecao", "alecrim"].includes(competition)) {
        note = `O plano Free da Dados Futebol libera a consulta de rodadas apenas para Brasileirão Série A, B, C e D e Copa do Brasil; ${label} não está disponível nesse acesso.`;
      } else {
        note = `A API não listou uma competição com rodadas liberadas no plano Free para ${label}. O acesso gratuito cobre Brasileirão Série A-D e Copa do Brasil.`;
      }
      const result = { ok: true, competition, competitionLabel: label, season, count: 0, fixtures: [], todayFixtures: [], updatedAt: new Date().toISOString(), source: "Dados Futebol", window: { from, to, today, mode }, today, note, todayNote: "Não foi possível carregar a agenda sem competições acessíveis." };
      return json(result);
    }

    const raw = [];
    for (const comp of selectedCompetitions) {
      // A rota /rodadas já vem cacheada e contém tanto jogos encerrados quanto os agendados.
      // A leitura em modo agenda evita chamadas adicionais por partida ou por horário.
      const games = await footballLoadFixturesForCompetition(comp, fetchFrom, today, env, competition === "recent");
      let filtered = games;
      if (competition === "libertadores" || competition === "sulamericana") {
        filtered = games.filter((f) => footballIsBrazilianClub(f.home) || footballIsBrazilianClub(f.away));
      } else if (competition === "selecao") {
        filtered = games.filter((f) => footballIsBrazilSelection(f.home) || footballIsBrazilSelection(f.away));
      } else if (isTeamView) {
        filtered = games.filter((f) => footballTeamMatchesKind(f.home, competition) || footballTeamMatchesKind(f.away, competition));
      }
      raw.push(...filtered);
    }

    const allRelevantFixtures = footballDeduplicateFixtures(raw);
    let fixtures;
    let todayFixtures = [];
    if (competition === "recent") {
      fixtures = footballSelectRecentFixtures(allRelevantFixtures, from, to);
      todayFixtures = footballSelectTodayFixtures(allRelevantFixtures, today);
    } else {
      fixtures = footballSortFixtures(allRelevantFixtures.filter((f) => footballFixtureIsWithinDateWindow(f, from, to)
        && footballIsCompletedStatus(f.status) && f.homeScore != null && f.awayScore != null)).slice(0, 12);
    }
    const competitionLabel = competition === "recent"
      ? "Resultados recentes e jogos do dia"
      : isTeamView
        ? ({abc:"ABC FC · competições disponíveis", "america-rn":"América-RN · competições disponíveis", alecrim:"Alecrim-RN · competições disponíveis"})[competition]
        : selectedCompetitions.map((c) => c.nome).join(" · ");
    let note = "";
    if (!fixtures.length) {
      note = mode === "weekend"
        ? "Nenhum placar encerrado foi encontrado para sábado e domingo nas competições liberadas."
        : "Nenhum placar encerrado foi encontrado hoje ou ontem nas competições liberadas.";
    }
    const todayNote = todayFixtures.length
      ? ""
      : "Nenhum jogo previsto para hoje nas competições disponíveis no plano atual.";
    const result = {
      ok: true, competition, competitionLabel, season,
      count: fixtures.length, fixtures, todayCount: todayFixtures.length, todayFixtures,
      updatedAt: new Date().toISOString(), source: "Dados Futebol",
      window: { from, to, today, mode }, today, note, todayNote,
    };
    const response = new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${responseTtl}`, "X-Radar-Cache": "MISS" },
    });
    if (cache) {
      try { await cache.put(cacheRequest, response.clone()); } catch (_) { /* cache opcional */ }
    }
    return response;
  } catch (error) {
    const message = error?.message || "Não foi possível consultar os jogos.";
    const status = error?.code === "missing_api_key" ? 503 : error?.status === 401 || error?.status === 403 || error?.status === 429 ? error.status : 502;
    return json({ ok: false, code: error?.code || "dados_futebol_api_error", error: message, source: "Dados Futebol" }, status);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: HEADERS,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/api/football") {
      return handleFootball(request, env);
    }

    if (request.method === "POST" && path === "/api/extract-article") {
      return handleExtractArticle(request, json);
    }


    if (
  request.method === "POST" &&
  path === "/api/boletim-chatgpt"
) {
  return handleBulletinImport(request, env, json);
}

if (
  request.method === "GET" &&
  path === "/api/boletim-chatgpt/latest"
) {
  return handleLatestBulletin(env, json);
}

    if (request.method === "POST" && path === "/api/outlook/import") {
      return handleOutlookImport(request, env, json);
    }

    if (request.method === "GET" && path === "/api/health") {
      return json({
        ok: true,
        service: "Radar API",
        sources: Object.keys(FEEDS),
        footballApiConfigured: Boolean(await getDadosFutebolApiKey()),
      });
    }

    if (request.method === "GET" && path === "/api/rss") {
      const key = url.searchParams.get("source");
      const source = FEEDS[key];

      if (!source) {
        return json({
          ok: false,
          error: "Fonte inválida.",
          availableSources: Object.keys(FEEDS),
        }, 400);
      }

      try {
        return json(await collectSource(source, 15));
      } catch (error) {
        return json({
          ok: false,
          source: key,
          error: error.message || "Falha na coleta.",
        }, 502);
      }
    }

    if (request.method === "GET" && path === "/api/collect") {
      try {
        return json(
          await collectMany(
            Object.values(FEEDS),
            getLimit(url.searchParams.get("limit"))
          )
        );
      } catch (error) {
        return json({
          ok: false,
          error: error.message || "Falha na coleta.",
        }, 500);
      }
    }

    if (request.method === "POST" && path === "/api/collect-html-source") {
      try {
        const body = await request.json();
        const source = {
          name: String(body.name || "Fonte HTML").trim().slice(0, 100),
          url: String(body.url || "").trim(),
        };
        if (!source.name) throw new Error("Informe o nome da fonte.");
        validateUrl(source.url);
        const result = await collectHtmlSource(source, getLimit(body.limit ?? 8));
        return json(result);
      } catch (error) {
        return json({ ok: false, error: String(error?.message || "Falha na coleta HTML.").slice(0, 240) }, 422);
      }
    }

    if (request.method === "POST" && path === "/api/test-feed") {
      try {
        const body = await request.json();

        const source = {
          name: String(body.name || "Fonte de teste")
            .trim()
            .slice(0, 100),
          url: String(body.url || "").trim(),
        };

        validateUrl(source.url);

        const result = await collectSource(
          source,
          getLimit(body.limit ?? 5)
        );

        return json(result);
      } catch (error) {
        return json({
          ok: false,
          error: error.message || "Não foi possível testar o feed.",
        }, 400);
      }
    }

    if (request.method === "POST" && path === "/api/collect") {
      try {
        const body = await request.json();

        const sources = normalizeSources(
          (body.sources || []).filter(
            (source) => source.active !== false
          )
        );

        return json(
          await collectMany(sources, getLimit(body.limit))
        );
      } catch (error) {
        return json({
          ok: false,
          error: error.message || "Não foi possível iniciar a coleta.",
        }, 400);
      }
    }

    return json({
      ok: false,
      error: "Rota não encontrada.",
      availableRoutes: [
        "/api/health",
        "/api/rss?source=agencia-brasil",
        "/api/rss?source=g1",
        "/api/collect",
        "POST /api/test-feed",
        "POST /api/collect",
        "POST /api/boletim-chatgpt",
        "GET /api/boletim-chatgpt/latest",
        "POST /api/outlook/import",
        "POST /api/extract-article",
        "GET /api/football?competition=recent (fixtures + todayFixtures)",
        "GET /api/football?competition=brasileirao"
      ],
    }, 404);
  },
};