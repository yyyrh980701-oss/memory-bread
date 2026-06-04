const state = {
  drafts: [],
  cards: [],
  glossary: [],
  reviewHistory: [],
  previewDrafts: [],
  currentDraft: 0,
  currentLearn: 0,
  statsPeriod: "week",
  previewEditIndex: null,
  addCardTarget: "preview",
  remindersEnabled: false,
  lastReminderKey: "",
};

const intervals = {
  again: 10 * 60 * 1000,
  hard: 24 * 60 * 60 * 1000,
  good: 3 * 24 * 60 * 60 * 1000,
  easy: 7 * 24 * 60 * 60 * 1000,
};

const englishGlossary = {
  "it is regular": "它是正常的",
  "it is normal": "它是正常的",
  regular: "正常的",
  normal: "正常的",
  relax: "放松",
  "excuse me": "对不起",
  sorry: "对不起",
};

const sourcePageImages = new Map();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function setParseStatus(message, tone = "") {
  const el = $("#parseStatus");
  el.textContent = message;
  el.className = `parse-status ${tone}`.trim();
}

function saveState() {
  localStorage.setItem("fragment-review-state", JSON.stringify(state));
}

function loadState() {
  const stored = localStorage.getItem("fragment-review-state");
  if (!stored) return;
  Object.assign(state, JSON.parse(stored));
  state.reviewHistory ||= [];
  state.previewDrafts ||= [];
  state.statsPeriod ||= "week";
  state.remindersEnabled ||= false;
  state.lastReminderKey ||= "";
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function createManualCard(front, back) {
  return {
    id: uid(),
    originalFront: front,
    originalBack: back,
    front,
    back,
    analysis: "手动添加的卡片。",
    source: "手动添加",
  };
}

function switchView(name) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === name));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `${name}View`));
  render();
}

function applyGlossary(text) {
  return state.glossary.reduce((next, item) => {
    return next.replaceAll(item.original, item.corrected);
  }, text);
}

function structureText(rawText, mode = "language") {
  const cleanText = applyGlossary(rawText.trim());
  const sections = splitPageSections(cleanText);
  const cards = sections.flatMap((section) => {
    const text = cleanImportedText(section.text);
    if (mode === "language") {
      const languageCards = structureLanguageCards(text);
      if (languageCards.length) return languageCards.map((card) => ({ ...card, pageNumber: section.pageNumber }));
    }
    return structureNoteCards(text).map((card) => ({ ...card, pageNumber: section.pageNumber }));
  });
  return cards;
}

function splitPageSections(text) {
  const markerPattern = /\[\[PAGE:(\d+)\]\]/g;
  const matches = [...text.matchAll(markerPattern)];
  if (!matches.length) return [{ text, pageNumber: null }];
  return matches.map((match, index) => ({
    pageNumber: Number(match[1]),
    text: text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length),
  }));
}

function cleanImportedText(text) {
  return text
    .replace(/^第\s*\d+\s*页\s*$/gm, "")
    .replace(/\[\[PAGE:\d+\]\]/g, "")
    .replace(/\s+第\s*\d+\s*页\s+/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isNoisyCandidate(card, mode) {
  const front = card.front.replace(/\s+/g, " ").trim();
  const back = card.back.replace(/\s+/g, " ").trim();
  if (!front || !back) return true;
  if (/^\d+$/.test(front) || /^\d+$/.test(back)) return true;
  if (front.length > 90 || back.length > 260) return true;
  if (/第\s*\d+\s*页|\[\[PAGE:|week\s*\d+\s*day\s*\d+/i.test(`${front} ${back}`)) return true;
  if (mode === "language" && !/[A-Za-zÀ-ÖØ-öø-ÿ¿¡]/.test(back)) return true;
  return false;
}

function analyzePreview(rawText) {
  const mode = document.querySelector('input[name="cardMode"]:checked')?.value || "language";
  state.previewDrafts = structureText(rawText, mode).filter((card) => !isNoisyCandidate(card, mode));
  saveState();
  renderPreview();
  setParseStatus(
    state.previewDrafts.length
      ? `AI 已整理出 ${state.previewDrafts.length} 张候选闪卡。请查看预览。`
      : "暂时没有筛选出可靠闪卡。可以展开解析原文进行修改，或切换制卡方式。",
    state.previewDrafts.length ? "done" : "warn",
  );
}

function structureLanguageCards(text) {
  const cards = [];
  const seen = new Set();
  splitVocabularyLines(text).forEach((pair) => {
    addLanguageCard(cards, seen, pair.front, pair.back, pair.source, pair.analysis);
  });
  splitEqualsPairs(text).forEach((pair) => {
    addLanguageCard(cards, seen, pair.front, pair.back, pair.source, pair.analysis);
  });

  const pairPattern = /([A-Za-zÀ-ÖØ-öø-ÿ¿¡][^\u4e00-\u9fff\n]{1,100}?)(?:\s*[=＝]\s*|\s+)([\u4e00-\u9fff][\u4e00-\u9fff\s，,、。；;（）()＋+\-]{0,60})/g;
  let match;

  while ((match = pairPattern.exec(text)) !== null) {
    const analysis = analyzeLanguagePair(match[1], match[2]);
    const foreign = analysis.answer;
    const chinese = cleanChineseText(match[2]);
    addLanguageCard(cards, seen, chinese, foreign, match[0].trim(), analysis.note);
  }

  return cards;
}

function splitVocabularyLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const normalized = line.replace(/^\d+[.、]\s*/, "");
      const match = normalized.match(/^([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ\s.'-]{1,45})[,，]\s*([\u4e00-\u9fff][\u4e00-\u9fff/、\s]{1,35})(?:[,，]\s*(.+))?$/);
      if (!match) return null;
      const foreign = match[1].trim();
      const chinese = match[2].trim();
      const example = match[3]?.trim();
      return {
        front: chinese,
        back: foreign,
        source: line,
        analysis: example
          ? `识别为词汇卡：${chinese} = ${foreign}\n例句保留：${example}`
          : `识别为词汇卡：${chinese} = ${foreign}`,
      };
    })
    .filter(Boolean);
}

function addLanguageCard(cards, seen, front, back, source, analysis) {
  if (!front || !back) return;
  if (front.length < 2 || back.length < 2) return;
  const key = `${front}|${back}`.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  cards.push({
    id: uid(),
    originalFront: front,
    originalBack: back,
    front,
    back,
    analysis,
    source,
  });
}

function splitEqualsPairs(text) {
  const normalized = cleanImportedText(text).replace(/＝/g, "=");
  const pairs = [];
  const seen = new Set();
  const knownGlosses = Object.keys(englishGlossary)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const knownPattern = new RegExp(
    `([A-Za-zÀ-ÖØ-öø-ÿ¿¡][A-Za-zÀ-ÖØ-öø-ÿ¿¡\\s/.'-]{1,70})\\s*=\\s*(${knownGlosses})(?=\\s+[A-Za-zÀ-ÖØ-öø-ÿ¿¡]|\\s*$|[。.;；,，])`,
    "gi",
  );
  const equalsPattern = /([A-Za-zÀ-ÖØ-öø-ÿ¿¡][A-Za-zÀ-ÖØ-öø-ÿ¿¡\s/.'-]{1,70})\s*=\s*([A-Za-z][A-Za-z\s.'-]{1,50}|[\u4e00-\u9fff][\u4e00-\u9fff\s，,、。；;]{0,40})/g;
  let match;

  while ((match = knownPattern.exec(normalized)) !== null) {
    const foreign = cleanForeignText(match[1]);
    const gloss = match[2].trim();
    const front = englishGlossary[gloss.toLowerCase()];
    const key = `${front}|${foreign}`.toLowerCase();
    const letterCount = foreign.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "").length;
    if (!front || !foreign || letterCount < 4 || seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      front,
      back: foreign,
      source: match[0].trim(),
      analysis: `检测到英文释义：${foreign} = ${gloss}\n已转成中文复习卡：${front} = ${foreign}`,
    });
  }

  while ((match = equalsPattern.exec(normalized)) !== null) {
    const foreign = cleanForeignText(match[1]);
    const gloss = match[2].trim().replace(/[.。]+$/g, "");
    const front = /[\u4e00-\u9fff]/.test(gloss) ? cleanChineseText(gloss) : englishGlossary[gloss.toLowerCase()];
    const key = `${front}|${foreign}`.toLowerCase();
    if (!front || !foreign || seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      front,
      back: foreign,
      source: match[0].trim(),
      analysis: `检测到等号结构：${foreign} = ${gloss}\n已转成复习卡：${front} = ${foreign}`,
    });
  }

  const apologyMatch = normalized.match(/(disculpe\s+disculpa\s+perd[oó]n\.?\s+perdona\s+perdone)/i);
  if (apologyMatch) {
    pairs.push({
      front: "对不起",
      back: apologyMatch[1].replace(/\s+/g, " ").replace(/\./g, "").trim(),
      source: apologyMatch[0],
      analysis: "检测到一组道歉/打扰表达，合并成一张同义表达卡。",
    });
  }

  return pairs;
}

function openSplitDialog() {
  const draft = state.drafts[state.currentDraft];
  if (!draft) return;
  const text = [draft.source, draft.back, $("#backEdit").value].filter(Boolean).join(" ");
  const splitCards = structureLanguageCards(text);
  const uniqueCards = splitCards.filter((card) => card.front !== draft.front || card.back !== draft.back);
  const currentLine = `${$("#frontEdit").value.trim()} = ${$("#backEdit").value.trim()}`;

  $("#splitText").value = [currentLine, ...uniqueCards.map((card) => `${card.front} = ${card.back}`)].join("\n");
  $("#splitHint").textContent = uniqueCards.length
    ? `第一行是当前卡片，下面有 ${uniqueCards.length} 张拆分建议。请核对、修改或删除。`
    : "第一行是当前卡片。请点“原文”核对笔记图片，再手动拆分为每行一张。";
  $("#splitDialog").showModal();
}

function confirmSplitCards() {
  const draft = state.drafts[state.currentDraft];
  if (!draft) return;
  const cards = $("#splitText").value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1 || separator === line.length - 1) return null;
      const front = line.slice(0, separator).trim();
      const back = line.slice(separator + 1).trim();
      if (!front || !back) return null;
      return {
        id: uid(),
        originalFront: front,
        originalBack: back,
        front,
        back,
        analysis: `由原卡拆分：${draft.front} = ${draft.back}`,
        source: draft.source,
        pageNumber: draft.pageNumber,
      };
    })
    .filter(Boolean);

  if (!cards.length) {
    $("#splitHint").textContent = "还没有有效卡片。请使用“中文 = 外语”的格式，每行填写一张。";
    return;
  }

  state.drafts.splice(state.currentDraft, 1, ...cards);
  $("#splitDialog").close();
  saveState();
  render();
}

function analyzeLanguagePair(rawForeign, rawChinese) {
  const sourceForeign = cleanForeignText(rawForeign);
  let answer = sourceForeign;
  const notes = [];
  const vocativeMatch = answer.match(/,\s*([A-ZÁÉÍÓÚÑ][A-Za-zÀ-ÖØ-öø-ÿ]+)\.?$/);

  if (vocativeMatch) {
    answer = answer.replace(/,\s*[A-ZÁÉÍÓÚÑ][A-Za-zÀ-ÖØ-öø-ÿ]+\.?$/, "").trim();
    notes.push(`${vocativeMatch[1]} 看起来是人名/称呼，不放进核心答案。`);
  }

  const leadingNameMatch = answer.match(/^([A-ZÁÉÍÓÚÑ][A-Za-zÀ-ÖØ-öø-ÿ]+)\s+\(([^)]+)\)(.+)$/);
  if (leadingNameMatch) {
    answer = `${leadingNameMatch[2]}${leadingNameMatch[3]}`.trim();
    notes.push(`${leadingNameMatch[1]} 看起来是上一句的人名残留，已忽略。`);
  }

  answer = answer
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,，.。;；:：=]+|[\s,，.。;；:：=]+$/g, "")
    .trim();

  const chinese = cleanChineseText(rawChinese);
  if (notes.length) {
    notes.unshift(`核心对应：${chinese} = ${answer}`);
  } else {
    notes.push(`核心对应：${chinese} = ${answer}`);
  }
  if (sourceForeign && sourceForeign !== answer) {
    notes.push(`原句保留：${sourceForeign}`);
  }

  return {
    answer,
    note: notes.join("\n"),
  };
}

function cleanForeignText(text) {
  return text
    .replace(/^第\s*\d+\s*页\s*/g, "")
    .replace(/\s*=\s*[A-Za-z\s]+$/g, "")
    .replace(/^[\s,，.。;；:：=]+|[\s,，;；:：=]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanChineseText(text) {
  const withoutForeign = text
    .replace(/[A-Za-zÀ-ÖØ-öø-ÿ¿¡][A-Za-zÀ-ÖØ-öø-ÿ\s.',?!¿¡()/+-]*/g, "")
    .replace(/[（）()]/g, "")
    .trim();
  const firstPhrase = withoutForeign.split(/[，,。；;]/).find(Boolean) || withoutForeign;
  return firstPhrase.replace(/[^\u4e00-\u9fff＋+的了么吗呢吧不没无]/g, "").trim();
}

function structureNoteCards(cleanText) {
  const blocks = cleanText
    .split(/\n{2,}|(?=^[一二三四五六七八九十]+[、.])|(?=^\d+[.、])|(?=^[-*•]\s+)/m)
    .map((block) => block.trim())
    .filter(Boolean);

  const sourceBlocks = blocks.length ? blocks : [cleanText];

  return sourceBlocks.map((block) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const title = lines[0]?.replace(/^[-#*\d.、\s]+/, "") || "未命名知识点";
    const body = lines.slice(1).join("\n") || block;
    const question = lines.length > 1 ? `什么是：${title}？` : `请解释：${title}`;
    return {
      id: uid(),
      originalFront: question,
      originalBack: body,
      front: question,
      back: body,
      analysis: "已从文档中识别出一个候选知识点。请核对问题和答案是否适合独立复习。",
      source: block,
    };
  });
}

async function parseFile(file) {
  const name = file.name.toLowerCase();
  if (/\.(txt|md)$/i.test(name)) {
    sourcePageImages.clear();
    return file.text();
  }
  if (/\.docx$/i.test(name)) {
    sourcePageImages.clear();
    return parseDocx(file);
  }
  if (/\.pdf$/i.test(name)) return parsePdf(file);
  throw new Error("暂时只支持 txt、md、docx、pdf。");
}

async function parseDocx(file) {
  if (!window.mammoth) {
    throw new Error("Word 解析库还没有加载完成，请确认网络可用后再试一次。");
  }
  const buffer = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer: buffer });
  const text = result.value.trim();
  if (!text) throw new Error("这个 Word 文档没有提取到文字。");
  const pages = splitWordPreviewPages(text);
  sourcePageImages.clear();
  const renderedImages = await renderWordPageImages(buffer);
  pages.forEach((pageText, index) => {
    sourcePageImages.set(index + 1, renderedImages[index] || renderTextPageImage(pageText, `Word 原文 · 第 ${index + 1} 页`));
  });
  return pages.map((pageText, index) => `[[PAGE:${index + 1}]]\n${pageText}`).join("\n\n");
}

async function renderWordPageImages(buffer) {
  if (!window.docx?.renderAsync || !window.html2canvas) return [];
  const host = $("#wordRenderHost");
  host.innerHTML = "";
  try {
    await window.docx.renderAsync(buffer, host, null, {
      breakPages: true,
      ignoreWidth: false,
      ignoreHeight: false,
      useBase64URL: true,
    });
    const pages = [...host.querySelectorAll(".docx-wrapper > section.docx")];
    const images = [];
    for (const page of pages) {
      const canvas = await window.html2canvas(page, { backgroundColor: "#ffffff", scale: 0.9 });
      images.push(canvas.toDataURL("image/jpeg", 0.82));
    }
    return images;
  } catch {
    return [];
  } finally {
    host.innerHTML = "";
  }
}

function splitWordPreviewPages(text) {
  const paragraphs = text.split(/\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const pages = [];
  let current = "";
  paragraphs.forEach((paragraph) => {
    if (current && `${current}\n${paragraph}`.length > 1100) {
      pages.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n${paragraph}` : paragraph;
    }
  });
  if (current) pages.push(current);
  return pages;
}

function renderTextPageImage(text, title) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.width = 900;
  canvas.height = 1260;
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#6d6a62";
  context.font = "700 24px -apple-system, BlinkMacSystemFont, sans-serif";
  context.fillText(title, 58, 68);
  context.fillStyle = "#1f2328";
  context.font = "28px -apple-system, BlinkMacSystemFont, sans-serif";
  const lines = wrapCanvasText(context, text, 780);
  lines.slice(0, 34).forEach((line, index) => context.fillText(line, 58, 130 + index * 33));
  return canvas.toDataURL("image/jpeg", 0.82);
}

function wrapCanvasText(context, text, maxWidth) {
  const lines = [];
  text.split("\n").forEach((paragraph) => {
    let line = "";
    Array.from(paragraph).forEach((character) => {
      const next = line + character;
      if (line && context.measureText(next).width > maxWidth) {
        lines.push(line);
        line = character;
      } else {
        line = next;
      }
    });
    if (line) lines.push(line);
    lines.push("");
  });
  return lines;
}

async function parsePdf(file) {
  const pdfjs = await waitForPdfJs();
  pdfjs.GlobalWorkerOptions.workerSrc = "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const pages = [];
  sourcePageImages.clear();

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = normalizePdfText(content.items);
    sourcePageImages.set(pageNumber, await renderPdfPageImage(page));
    if (pageText) pages.push(`[[PAGE:${pageNumber}]]\n${pageText}`);
  }

  const text = pages.join("\n\n").trim();
  if (text.length < 20) {
    throw new Error("这个 PDF 像是扫描版或图片型 PDF，需要下一步接 OCR 后才能识别。");
  }
  return text;
}

function normalizePdfText(items) {
  const groups = new Map();
  items.forEach((item) => {
    const y = Math.round(item.transform?.[5] || 0);
    const key = [...groups.keys()].find((lineY) => Math.abs(lineY - y) <= 3) ?? y;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  const build = (direction, reverseContent = false) => [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, line]) => line
      .sort((a, b) => direction * ((a.transform?.[4] || 0) - (b.transform?.[4] || 0)))
      .map((item) => reverseContent ? repairReversedPunctuation(reverseText(item.str)) : item.str)
      .join(" "))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

  const candidates = [
    build(1),
    build(1, true),
    build(-1),
    build(-1, true),
  ];
  return candidates.sort((a, b) => readableTextScore(b) - readableTextScore(a))[0];
}

function reverseText(text) {
  return Array.from(text).reverse().join("");
}

function orientReadableText(text) {
  if (!text) return text;
  const reversed = repairReversedPunctuation(reverseText(text));
  return readableTextScore(reversed) > readableTextScore(text) + 2 ? reversed : text;
}

function repairReversedPunctuation(text) {
  return text
    .replace(/^\?(.+¿.+)$/u, "$1?")
    .replace(/^!(.+¡.+)$/u, "$1!");
}

function readableTextScore(text) {
  const lower = text.toLowerCase();
  const commonTerms = [
    "hola", "qué tal", "bien", "buenas", "tardes", "cómo", "está", "gracias",
    "adiós", "hasta", "luego", "你好", "怎么样", "很好", "下午好", "对不起", "不客气",
  ];
  const reversedTerms = commonTerms.map(reverseText);
  const normalScore = commonTerms.reduce((score, term) => score + (lower.includes(term) ? 4 : 0), 0);
  const reversedPenalty = reversedTerms.reduce((score, term) => score + (lower.includes(term) ? 5 : 0), 0);
  const punctuationScore = (lower.match(/[¿¡][a-zà-öø-ÿ]/g) || []).length * 2;
  return normalScore + punctuationScore - reversedPenalty;
}

async function renderPdfPageImage(page) {
  const viewport = page.getViewport({ scale: 1.15 });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.78);
}

function waitForPdfJs() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const pdfjs = window.pdfjsLib || globalThis.pdfjsLib;
      if (pdfjs) {
        clearInterval(timer);
        resolve(pdfjs);
      } else if (Date.now() - startedAt > 8000) {
        clearInterval(timer);
        reject(new Error("PDF 解析库还没有加载完成，请确认网络可用后再试一次。"));
      }
    }, 80);
  });
}

function rememberCorrections(draft, edited) {
  [
    [draft.originalFront, edited.front],
    [draft.originalBack, edited.back],
  ].forEach(([before, after]) => {
    if (!before || !after || before === after) return;
    const beforeWords = before.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || [];
    const afterWords = after.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || [];
    beforeWords.forEach((word, index) => {
      const corrected = afterWords[index];
      if (!corrected || corrected === word || Math.abs(corrected.length - word.length) > 2) return;
      const existing = state.glossary.find((item) => item.original === word && item.corrected === corrected);
      if (existing) existing.count += 1;
      else state.glossary.unshift({ original: word, corrected, count: 1 });
    });
  });
  state.glossary = state.glossary.slice(0, 20);
}

function saveCurrentDraft() {
  const draft = state.drafts[state.currentDraft];
  if (!draft) return;
  const edited = {
    ...draft,
    front: $("#frontEdit").value.trim(),
    back: $("#backEdit").value.trim(),
    isEdited: draft.front !== $("#frontEdit").value.trim() || draft.back !== $("#backEdit").value.trim(),
    dueAt: Date.now(),
    step: 0,
    createdAt: Date.now(),
  };
  rememberCorrections(draft, edited);
  state.cards.unshift(edited);
  state.drafts.splice(state.currentDraft, 1);
  if (state.currentDraft >= state.drafts.length) state.currentDraft = Math.max(0, state.drafts.length - 1);
  saveState();
  render();
}

function discardCurrentDraft() {
  if (!state.drafts.length) return;
  state.drafts.splice(state.currentDraft, 1);
  if (state.currentDraft >= state.drafts.length) state.currentDraft = Math.max(0, state.drafts.length - 1);
  saveState();
  render();
}

function cacheCurrentDraftEdits() {
  const draft = state.drafts[state.currentDraft];
  if (!draft) return;
  draft.front = $("#frontEdit").value.trim();
  draft.back = $("#backEdit").value.trim();
}

function moveDraft(offset) {
  if (!state.drafts.length) return;
  cacheCurrentDraftEdits();
  state.currentDraft = (state.currentDraft + offset + state.drafts.length) % state.drafts.length;
  saveState();
  renderDraft();
}

function dueCards() {
  const now = Date.now();
  return state.cards.filter((card) => card.dueAt <= now);
}

function formatScheduleTime(timestamp) {
  const date = new Date(timestamp);
  const today = startOfDay(new Date()).getTime();
  const targetDay = startOfDay(date).getTime();
  const dayDiff = Math.round((targetDay - today) / (24 * 60 * 60 * 1000));
  const dayLabel = dayDiff === 0 ? "今天" : dayDiff === 1 ? "明天" : `${date.getMonth() + 1}/${date.getDate()}`;
  return `${dayLabel} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function nextReviewEntries(limit = 6) {
  const followUps = [intervals.again, intervals.hard, intervals.good, intervals.easy];
  return state.cards
    .flatMap((card) => {
      const firstDue = Math.max(card.dueAt || Date.now(), Date.now());
      let cursor = firstDue;
      return followUps.map((gap, index) => {
        if (index > 0) cursor += gap;
        return { front: card.front, dueAt: cursor, cardId: card.id };
      });
    })
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, limit);
}

function gradeCurrentCard(grade) {
  const due = dueCards();
  const card = due[state.currentLearn];
  if (!card) return;
  card.dueAt = Date.now() + intervals[grade];
  card.step = grade === "again" ? 0 : card.step + 1;
  state.reviewHistory.push({
    cardId: card.id,
    grade,
    reviewedAt: Date.now(),
  });
  $("#learnBack").hidden = true;
  state.currentLearn = 0;
  saveState();
  render();
}

function renderSchedule() {
  const entries = nextReviewEntries();
  $("#scheduleList").innerHTML = entries.length
    ? entries.map((entry) => `
      <div class="schedule-row">
        <strong>${escapeHtml(entry.front)}</strong>
        <time>${formatScheduleTime(entry.dueAt)}</time>
      </div>
    `).join("")
    : `<p class="muted">加入卡片后，这里会显示后续复习时间。</p>`;
}

function updateReminderStatus() {
  const supported = "Notification" in window;
  const permission = supported ? Notification.permission : "unsupported";
  $("#enableReminderBtn").textContent = state.remindersEnabled ? "已开启复习提醒" : "开启复习提醒";
  $("#reminderStatus").textContent = !supported
    ? "当前浏览器不支持系统通知。网页打开时仍会显示站内提醒。"
    : permission === "granted"
      ? "已允许系统通知。网页打开时，到期卡片会弹出提醒。"
      : "点击按钮允许通知。iPhone 后台可靠推送需将网页添加到主屏幕，并在后续接入推送服务。";
}

async function enableReminders() {
  if ("Notification" in window && Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    state.remindersEnabled = permission === "granted";
  } else {
    state.remindersEnabled = true;
  }
  saveState();
  updateReminderStatus();
  checkDueReminder();
}

function checkDueReminder() {
  const due = dueCards();
  $("#reminderBanner").hidden = !due.length;
  $("#reminderBanner").textContent = due.length ? `有 ${due.length} 张卡片到时间了，点击开始复习。` : "";
  if (!due.length || !state.remindersEnabled) return;
  const key = due.map((card) => `${card.id}:${card.dueAt}`).sort().join("|");
  if (key === state.lastReminderKey) return;
  state.lastReminderKey = key;
  saveState();
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("🥖记忆面包提醒", { body: `有 ${due.length} 张卡片到时间了。` });
  }
}

function renderDraft() {
  const draft = state.drafts[state.currentDraft];
  if (draft) {
    draft.front = orientReadableText(draft.front);
    draft.back = orientReadableText(draft.back);
  }
  $("#cardIndex").textContent = draft
    ? `待学习 ${state.currentDraft + 1} / ${state.drafts.length}`
    : "暂无待学习卡片";
  $("#frontEdit").value = draft?.front || "";
  $("#backEdit").value = draft?.back || "";
  $("#aiAnalysis").textContent = draft?.analysis || "";
  $("#aiAnalysis").hidden = !draft?.analysis;
  $("#sourceBtn").disabled = !draft;
  $("#prevDraftBtn").disabled = !draft || state.drafts.length < 2;
  $("#nextDraftBtn").disabled = !draft || state.drafts.length < 2;
}

function renderLearn() {
  const due = dueCards();
  const card = due[state.currentLearn];
  $("#learnIndex").textContent = card ? `今日复习 ${state.currentLearn + 1} / ${due.length}` : "今日暂无复习";
  $("#learnFront").textContent = card?.front || "先导入几张卡片吧";
  $("#learnBack").textContent = card?.back || "";
  $("#learnBack").hidden = true;
  $("#revealBtn").disabled = !card;
}

function renderGlossary() {
  const list = $("#glossaryList");
  if (!state.glossary.length) {
    list.innerHTML = `<p class="muted">还没有纠错记录。确认卡片时改几个字，这里就会开始积累。</p>`;
    return;
  }
  list.innerHTML = state.glossary
    .map((item) => `
      <div class="glossary-row">
        <span>${escapeHtml(item.original)}</span>
        <span>→</span>
        <strong>${escapeHtml(item.corrected)}</strong>
        <small>${item.count}</small>
      </div>
    `)
    .join("");
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date, count) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + count);
  return copy;
}

function statsBuckets(period) {
  const today = startOfDay(new Date());
  if (period === "week") {
    return Array.from({ length: 7 }, (_, index) => {
      const start = addDays(today, index - 6);
      return { start, end: addDays(start, 1), label: `${start.getMonth() + 1}/${start.getDate()}` };
    });
  }
  if (period === "month") {
    return Array.from({ length: 30 }, (_, index) => {
      const start = addDays(today, index - 29);
      return { start, end: addDays(start, 1), label: index % 5 === 0 || index === 29 ? `${start.getMonth() + 1}/${start.getDate()}` : "" };
    });
  }
  return Array.from({ length: 12 }, (_, index) => {
    const start = new Date(today.getFullYear(), today.getMonth() - 11 + index, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    return { start, end, label: `${start.getMonth() + 1}月` };
  });
}

function renderStats() {
  const bucketFrames = statsBuckets(state.statsPeriod);
  const periodHistory = state.reviewHistory.filter((entry) => (
    entry.reviewedAt >= bucketFrames[0].start.getTime()
    && entry.reviewedAt < bucketFrames[bucketFrames.length - 1].end.getTime()
  ));
  const buckets = bucketFrames.map((bucket) => ({
    ...bucket,
    count: periodHistory.filter((entry) => entry.reviewedAt >= bucket.start.getTime() && entry.reviewedAt < bucket.end.getTime()).length,
  }));
  const max = Math.max(...buckets.map((bucket) => bucket.count), 1);
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  $("#statsSummary").textContent = total ? `当前周期共完成 ${total} 次复习。` : "当前周期还没有复习记录。";
  $("#statsChart").style.setProperty("--chart-count", buckets.length);
  $("#statsChart").innerHTML = buckets.map((bucket) => `
    <div class="chart-column">
      <span class="chart-value">${bucket.count || ""}</span>
      <div class="chart-bar" style="height:${Math.max((bucket.count / max) * 100, 2)}%"></div>
      <span class="chart-label">${bucket.label}</span>
    </div>
  `).join("");

  const gradeLabels = { again: "忘了", hard: "模糊", good: "记得", easy: "秒懂" };
  $("#statsGrade").innerHTML = Object.entries(gradeLabels).map(([grade, label]) => {
    const count = periodHistory.filter((entry) => entry.grade === grade).length;
    return `<div><strong>${count}</strong>${label}</div>`;
  }).join("");
  $$(".period-switch button").forEach((button) => button.classList.toggle("active", button.dataset.period === state.statsPeriod));
}

function renderPreview() {
  $("#previewCount").textContent = state.previewDrafts.length ? `${state.previewDrafts.length} 张候选卡` : "等待导入";
  $("#previewList").innerHTML = state.previewDrafts.length
    ? state.previewDrafts.map((card, index) => `
      <div class="preview-card" data-preview-index="${index}">
        <button class="preview-delete" data-preview-delete="${index}">删除</button>
        <div class="preview-card-content">
          <span>${escapeHtml(card.front)}</span>
          <span class="preview-arrow">→</span>
          <span>${escapeHtml(card.back)}</span>
          <button class="preview-edit" data-preview-edit="${index}" aria-label="修改卡片" title="修改卡片">✎</button>
        </div>
      </div>
    `).join("")
    : `<p class="muted">上传文档或粘贴文本后，这里会显示准备生成的闪卡。</p>`;
  bindPreviewGestures();
}

function bindPreviewGestures() {
  $$(".preview-card").forEach((card) => {
    const content = card.querySelector(".preview-card-content");
    let touchStartX = 0;
    content.addEventListener("touchstart", (event) => {
      touchStartX = event.changedTouches[0].clientX;
    }, { passive: true });
    content.addEventListener("touchend", (event) => {
      const distance = event.changedTouches[0].clientX - touchStartX;
      if (distance < -36) card.classList.add("revealed");
      if (distance > 36) card.classList.remove("revealed");
    }, { passive: true });
  });
}

function openPreviewEdit(index) {
  const card = state.previewDrafts[index];
  if (!card) return;
  state.previewEditIndex = index;
  $("#previewFrontEdit").value = card.front;
  $("#previewBackEdit").value = card.back;
  $("#previewEditDialog").showModal();
}

function savePreviewEdit() {
  const card = state.previewDrafts[state.previewEditIndex];
  if (!card) return;
  card.front = $("#previewFrontEdit").value.trim();
  card.back = $("#previewBackEdit").value.trim();
  if (!card.front || !card.back) return;
  saveState();
  $("#previewEditDialog").close();
  renderPreview();
}

function deletePreviewCard(index) {
  state.previewDrafts.splice(index, 1);
  saveState();
  renderPreview();
  setParseStatus(`预览中还剩 ${state.previewDrafts.length} 张候选闪卡。`, state.previewDrafts.length ? "done" : "warn");
}

function openAddCard(target) {
  state.addCardTarget = target;
  $("#addCardFront").value = "";
  $("#addCardBack").value = "";
  $("#addCardDialog").showModal();
}

function saveAddedCard() {
  const front = $("#addCardFront").value.trim();
  const back = $("#addCardBack").value.trim();
  if (!front || !back) return;
  const card = createManualCard(front, back);
  if (state.addCardTarget === "learning") {
    state.drafts.push(card);
    state.currentDraft = state.drafts.length - 1;
  } else {
    state.previewDrafts.push(card);
  }
  saveState();
  $("#addCardDialog").close();
  render();
  if (state.addCardTarget === "preview") {
    setParseStatus(`预览中有 ${state.previewDrafts.length} 张候选闪卡。`, "done");
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function render() {
  $("#draftCount").textContent = state.drafts.length;
  $("#savedCount").textContent = state.cards.length;
  $("#dueCount").textContent = dueCards().length;
  renderDraft();
  renderLearn();
  renderGlossary();
  renderStats();
  renderPreview();
  renderSchedule();
  updateReminderStatus();
  checkDueReminder();
}

$("#fileInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  setParseStatus(`正在解析：${file.name}`, "busy");
  $("#structureBtn").disabled = true;
  try {
    const text = await parseFile(file);
    $("#rawText").value = text;
    setParseStatus(`已解析 ${file.name}，正在整理候选闪卡...`, "busy");
    analyzePreview(text);
  } catch (error) {
    $("#rawText").value = "";
    setParseStatus(error.message, "warn");
  } finally {
    $("#structureBtn").disabled = false;
  }
});

$("#structureBtn").addEventListener("click", async () => {
  if (!state.previewDrafts.length) {
    const rawText = $("#rawText").value;
    if (!rawText.trim()) return;
    analyzePreview(rawText);
  }
  if (!state.previewDrafts.length) return;
  state.drafts = state.previewDrafts.map((card) => ({ ...card }));
  state.currentDraft = 0;
  saveState();
  setParseStatus(`已生成 ${state.drafts.length} 张待学习卡片。`, state.drafts.length ? "done" : "warn");
  switchView("correct");
});

$("#analyzeTextBtn").addEventListener("click", () => {
  const rawText = $("#rawText").value;
  if (!rawText.trim()) return;
  setParseStatus("正在重新分析文本...", "busy");
  analyzePreview(rawText);
});

$("#previewList").addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-preview-edit]");
  const deleteButton = event.target.closest("[data-preview-delete]");
  if (editButton) openPreviewEdit(Number(editButton.dataset.previewEdit));
  if (deleteButton) deletePreviewCard(Number(deleteButton.dataset.previewDelete));
});
$("#closePreviewEdit").addEventListener("click", () => $("#previewEditDialog").close());
$("#savePreviewEdit").addEventListener("click", savePreviewEdit);
$("#addPreviewCardBtn").addEventListener("click", () => openAddCard("preview"));
$("#addLearningCardBtn").addEventListener("click", () => openAddCard("learning"));
$("#closeAddCard").addEventListener("click", () => $("#addCardDialog").close());
$("#saveAddedCard").addEventListener("click", saveAddedCard);

$("#saveBtn").addEventListener("click", saveCurrentDraft);
$("#discardBtn").addEventListener("click", discardCurrentDraft);
$("#prevDraftBtn").addEventListener("click", () => moveDraft(-1));
$("#nextDraftBtn").addEventListener("click", () => moveDraft(1));
$("#splitBtn").addEventListener("click", openSplitDialog);
$("#closeSplit").addEventListener("click", () => $("#splitDialog").close());
$("#confirmSplitBtn").addEventListener("click", confirmSplitCards);
$("#revealBtn").addEventListener("click", () => {
  $("#learnBack").hidden = false;
});

$(".grade-actions").addEventListener("click", (event) => {
  const grade = event.target.dataset.grade;
  if (grade) gradeCurrentCard(grade);
});

$("#sourceBtn").addEventListener("click", () => {
  const draft = state.drafts[state.currentDraft];
  if (!draft) return;
  const pageImage = draft.pageNumber ? sourcePageImages.get(draft.pageNumber) : null;
  $("#sourceTitle").textContent = draft.pageNumber ? `原文对照 · 第 ${draft.pageNumber} 页` : "原文对照";
  $("#sourceImage").src = pageImage || "";
  $("#sourceImage").hidden = !pageImage;
  $("#sourceText").textContent = pageImage ? "" : draft.source;
  $("#sourceText").hidden = Boolean(pageImage);
  $("#sourceDialog").showModal();
});

$("#closeSource").addEventListener("click", () => $("#sourceDialog").close());
$("#enableReminderBtn").addEventListener("click", enableReminders);
$("#reminderBanner").addEventListener("click", () => switchView("review"));
$("#resetDemo").addEventListener("click", () => {
  localStorage.removeItem("fragment-review-state");
  state.drafts = [];
  state.cards = [];
  state.glossary = [];
  state.reviewHistory = [];
  state.previewDrafts = [];
  state.currentDraft = 0;
  state.currentLearn = 0;
  state.statsPeriod = "week";
  state.previewEditIndex = null;
  state.addCardTarget = "preview";
  state.remindersEnabled = false;
  state.lastReminderKey = "";
  render();
});

$$('input[name="cardMode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    $("#modeHelp").textContent = radio.value === "language"
      ? "适合单词和短语笔记：中文做正面，外语做背面。"
      : "适合课程和概念笔记：每段标题转成问题，正文作为答案。";
    const rawText = $("#rawText").value;
    if (rawText.trim()) analyzePreview(rawText);
  });
});

$$(".period-switch button").forEach((button) => {
  button.addEventListener("click", () => {
    state.statsPeriod = button.dataset.period;
    saveState();
    renderStats();
  });
});

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

loadState();
render();
setInterval(checkDueReminder, 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkDueReminder();
});
