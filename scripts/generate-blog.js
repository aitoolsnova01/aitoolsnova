import fs from "fs-extra";
import path from "path";
import axios from "axios";
import slugify from "slugify";

const CONFIG = {
  siteName: "AIToolsNova",
  siteUrl: "https://aitoolsnova.com",
  blogDir: "./blog",
  indexFile: "./blogs.html",
  sitemapFile: "./sitemap.xml",
  logDir: "./logs",
  maxRetries: 3,
  timeout: 60000,
};

const API_KEY = process.env.GROQ_API_KEY;

if (!API_KEY) {
  console.error("❌ GROQ_API_KEY not found.");
  process.exit(1);
}

await fs.ensureDir(CONFIG.blogDir);
await fs.ensureDir(CONFIG.logDir);

function timestamp() {
  return new Date().toISOString();
}

async function writeLog(message) {
  const file = path.join(CONFIG.logDir, "blog.log");
  await fs.appendFile(file, `[${timestamp()}] ${message}\n`);
}

function createSlug(title) {
  return slugify(title, {
    lower: true,
    strict: true,
    trim: true,
  });
}

async function fileExists(file) {
  return fs.pathExists(file);
}

async function loadJson(file, fallback = []) {
  if (!(await fileExists(file))) return fallback;
  return fs.readJson(file);
}

async function saveJson(file, data) {
  await fs.writeJson(file, data, { spaces: 2 });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestGroq(messages) {
  const url = "https://api.groq.com/openai/v1/chat/completions";

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await axios.post(
        url,
        {
          model: "llama-3.3-70b-versatile",
          temperature: 0.7,
          messages,
        },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: CONFIG.timeout,
        }
      );
      return response.data.choices[0].message.content;
    } catch (err) {
      await writeLog(`Groq Attempt ${attempt} Failed: ${err.message}`);
      if (attempt === CONFIG.maxRetries) throw err;
      await sleep(3000);
    }
  }
}

async function getNextKeyword() {
  const keywords = await loadJson("./data/keywords.json", []);
  const published = await loadJson("./data/published.json", []);
  const remaining = keywords.filter((kw) => !published.includes(kw));

  if (remaining.length === 0) {
    throw new Error("No keywords remaining.");
  }

  return remaining[Math.floor(Math.random() * remaining.length)];
}

async function markKeywordPublished(keyword) {
  const published = await loadJson("./data/published.json", []);
  if (!published.includes(keyword)) {
    published.push(keyword);
    await saveJson("./data/published.json", published);
  }
}

// ============================================================
// BLOG GENERATION ENGINE
// ============================================================

async function generateBlog(keyword) {
  const prompt = `
Write a detailed SEO optimized blog about:

${keyword}

Requirements:

- 2000+ words
- Human readable
- H1 Title
- Meta Description
- Introduction
- Table of Contents
- H2 & H3 headings
- FAQs (at least 3)
- Conclusion
- Use Markdown formatting
`;

  return await requestGroq([{ role: "user", content: prompt }]);
}

// ============================================================
// HTML + SEO + SCHEMA GENERATOR
// ============================================================

function markdownToHtml(markdown = "") {
  let html = markdown;
  html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
  const blocks = html.split(/\n\s*\n/);
  html = blocks
    .map((block) => {
      if (/^<h[1-6]>/.test(block.trim())) return block;
      return `<p>${block.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
  return html;
}

function getTitle(article) {
  const match = article.match(/^#\s+(.+)$/m);
  return match ? match[1] : "AIToolsNova Blog";
}

function getMeta(article) {
  return article
    .replace(/^#.*$/gm, "")
    .replace(/\*/g, "")
    .replace(/\n/g, " ")
    .trim()
    .substring(0, 155);
}

function generateFaqSchema(article) {
  // Extract FAQ items from the article (looking for FAQ heading)
  const faqRegex = /##\s*FAQs?\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i;
  const match = article.match(faqRegex);
  if (!match) return null;

  const faqText = match[1];
  const items = [];
  const qaRegex = /\*\*Q:\s*(.*?)\*\*\s*\n\s*\*\*A:\s*(.*?)\*\*/g;
  let m;
  while ((m = qaRegex.exec(faqText)) !== null) {
    items.push({
      question: m[1].trim(),
      answer: m[2].trim(),
    });
  }

  if (items.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({
      "@type": "Question",
      name: i.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: i.answer,
      },
    })),
  };
}

async function saveBlog(slug, article) {
  const title = getTitle(article);
  const description = getMeta(article);
  const date = new Date().toISOString().split("T")[0];
  const htmlContent = markdownToHtml(article);

  // Generate JSON-LD Schemas
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description: description,
    author: {
      "@type": "Organization",
      name: CONFIG.siteName,
    },
    datePublished: date,
    dateModified: date,
    url: `${CONFIG.siteUrl}/blog/${slug}.html`,
    publisher: {
      "@type": "Organization",
      name: CONFIG.siteName,
      logo: {
        "@type": "ImageObject",
        url: `${CONFIG.siteUrl}/images/logo.png`,
      },
    },
  };

  const faqSchema = generateFaqSchema(article);
  const schemas = [articleSchema];
  if (faqSchema) schemas.push(faqSchema);

  const schemaScript = schemas
    .map((s) => `<script type="application/ld+json">${JSON.stringify(s, null, 2)}</script>`)
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <meta name="description" content="${description}">
    <link rel="canonical" href="${CONFIG.siteUrl}/blog/${slug}.html">

    <!-- Open Graph -->
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${CONFIG.siteUrl}/blog/${slug}.html">
    <meta property="og:site_name" content="${CONFIG.siteName}">

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">

    <!-- JSON-LD Structured Data -->
    ${schemaScript}

    <style>
        body { font-family: system-ui, -apple-system, sans-serif; max-width: 850px; margin: 40px auto; padding: 20px; line-height: 1.8; color: #1e293b; background: #f8fafc; }
        h1 { font-size: 2.2rem; }
        h2 { font-size: 1.8rem; margin-top: 2rem; }
        h3 { font-size: 1.4rem; margin-top: 1.5rem; }
        a { color: #4F46E5; }
        .faq-item { margin-bottom: 1.5rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 1rem; }
        .faq-item strong { display: block; font-size: 1.1rem; }
    </style>
</head>
<body>
    ${htmlContent}
</body>
</html>`;

  const file = path.join(CONFIG.blogDir, `${slug}.html`);
  await fs.writeFile(file, html);
  console.log("✅ Blog Saved:", file);
  await writeLog(`Blog Saved : ${slug}.html`);

  // Return data for index/sitemap update
  return { title, description, slug, date };
}

// ============================================================
// BLOG INDEX UPDATER
// ============================================================

async function updateBlogIndex(title, slug, description) {
  const indexFile = CONFIG.indexFile;
  let html = "";

  if (await fs.pathExists(indexFile)) {
    html = await fs.readFile(indexFile, "utf8");
  } else {
    html = `<!DOCTYPE html><html><head><title>Blogs</title></head><body><h1>Blogs</h1></body></html>`;
  }

  const card = `
<div class="blog-card" style="border:1px solid #e2e8f0;padding:20px;border-radius:12px;margin-bottom:20px;background:#fff;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1);">
  <h3><a href="/blog/${slug}.html" style="color:#1e293b;text-decoration:none;">${title}</a></h3>
  <p style="color:#64748b;">${description.substring(0, 150)}...</p>
  <a href="/blog/${slug}.html" style="color:#4F46E5;font-weight:700;">Read More →</a>
</div>
`;

  // Insert before </body> or append
  if (html.includes("</body>")) {
    html = html.replace("</body>", `${card}\n</body>`);
  } else {
    html += card;
  }

  await fs.writeFile(indexFile, html);
  console.log("✅ blogs.html Updated");
  await writeLog("blogs.html Updated");
}

// ============================================================
// SITEMAP UPDATER
// ============================================================

async function updateSitemap(slug) {
  const sitemapFile = CONFIG.sitemapFile;
  let xml = "";

  if (await fs.pathExists(sitemapFile)) {
    xml = await fs.readFile(sitemapFile, "utf8");
  } else {
    xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;
  }

  const urlEntry = `
<url>
  <loc>${CONFIG.siteUrl}/blog/${slug}.html</loc>
  <lastmod>${new Date().toISOString().split("T")[0]}</lastmod>
  <priority>0.8</priority>
</url>`;

  // Insert before </urlset>
  if (xml.includes("</urlset>")) {
    xml = xml.replace("</urlset>", `${urlEntry}\n</urlset>`);
  } else {
    xml += urlEntry;
  }

  await fs.writeFile(sitemapFile, xml);
  console.log("✅ sitemap.xml Updated");
  await writeLog("sitemap.xml Updated");
}

// ============================================================
// MAIN EXECUTION
// ============================================================

async function main() {
  try {
    const keyword = await getNextKeyword();
    console.log("Selected Keyword:", keyword);
    await writeLog(`Keyword Selected: ${keyword}`);

    const article = await generateBlog(keyword);
    const slug = createSlug(keyword);

    // Save blog and get metadata
    const { title, description, date } = await saveBlog(slug, article);

    // Mark as published
    await markKeywordPublished(keyword);

    // Update frontend files
    await updateBlogIndex(title, slug, description);
    await updateSitemap(slug);

    console.log("✅ Blog automation completed successfully!");
    await writeLog("Blog Generation Completed Successfully");
  } catch (error) {
    console.error("❌ Error in main:", error.message);
    await writeLog(`FATAL ERROR: ${error.message}`);
    process.exit(1);
  }
}

await main();
