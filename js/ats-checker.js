/*!
 * AIToolsNova — ATS Resume Checker engine (client-side, no API, no data leaves the browser).
 * Exposes window.ATS.analyze(resumeText, jobDescriptionText) -> report.
 * Also loadable in Node via require() for offline tests.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers
  var norm = function (t) { return String(t || '').toLowerCase(); };

  var EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  var PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
  var LINK_RE = /https?:\/\/\S+|www\.\S+/i;
  var EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

  var ACTION_VERBS = [
    'led', 'lead', 'built', 'developed', 'created', 'launched', 'designed', 'managed',
    'increased', 'reduced', 'improved', 'optimized', 'automated', 'delivered', 'achieved',
    'implemented', 'migrated', 'scaled', 'saved', 'grew', 'drove', 'owned', 'shipped',
    'streamlined', 'accelerated', 'cut', 'boosted', 'architected', 'mentored', 'negotiated'
  ];

  var SOFT_SKILLS = [
    'communication', 'leadership', 'teamwork', 'problem solving', 'problem-solving',
    'project management', 'time management', 'collaboration', 'analytical', 'adaptability',
    'stakeholder management', 'presentation', 'mentoring', 'ownership', 'attention to detail'
  ];

  var TECH_SKILLS = [
    'javascript', 'typescript', 'python', 'java', 'c++', 'c#', 'go', 'golang', 'rust', 'php',
    'ruby', 'kotlin', 'swift', 'sql', 'nosql', 'html', 'css', 'react', 'angular', 'vue',
    'node', 'node.js', 'express', 'django', 'flask', 'spring', 'laravel', '.net', 'next.js',
    'aws', 'azure', 'gcp', 'google cloud', 'docker', 'kubernetes', 'terraform', 'ci/cd',
    'git', 'github', 'gitlab', 'jenkins', 'linux', 'rest', 'graphql', 'api', 'microservices',
    'mysql', 'postgres', 'postgresql', 'mongodb', 'redis', 'elasticsearch', 'kafka',
    'machine learning', 'deep learning', 'ai', 'nlp', 'computer vision', 'tensorflow', 'pytorch',
    'data analysis', 'pandas', 'numpy', 'excel', 'tableau', 'power bi', 'etl', 'airflow',
    'seo', 'sem', 'google analytics', 'adsense', 'content marketing', 'email marketing',
    'figma', 'photoshop', 'illustrator', 'ui/ux', 'ux', 'ui', 'wireframing', 'prototyping',
    'agile', 'scrum', 'kanban', 'jira', 'product management', 'roadmap', 'a/b testing',
    'salesforce', 'crm', 'hubspot', 'shopify', 'wordpress', 'woocommerce',
    'customer support', 'accounting', 'recruiting', 'copywriting', 'editing', 'proofreading'
  ];

  var SECTION_CHECKS = [
    { key: 'summary', label: 'Professional Summary', re: /(professional\s+)?summary|objective|profile|about\s+me/ },
    { key: 'experience', label: 'Work Experience', re: /(work\s+)?experience|employment\s+history|work\s+history|professional\s+experience/ },
    { key: 'education', label: 'Education', re: /education|degree|university|college|academics/ },
    { key: 'skills', label: 'Skills', re: /skills|technologies|technical\s+proficien|competenc|tools/ }
  ];

  // Punctuation-insensitive, whole-token matching so "java" does NOT match
  // "javascript" and "ci/cd" is treated as the two-token phrase "ci cd".
  var normSpace = function (t) { return norm(t).replace(/[^a-z0-9+#]+/g, ' ').replace(/\s+/g, ' ').trim(); };
  var has = function (normHay, kw) {
    var nk = normSpace(kw);
    if (!nk) return false;
    return (' ' + normHay + ' ').indexOf(' ' + nk + ' ') !== -1;
  };

  // ---------------------------------------------------------------- keyword extraction
  function extractJdKeywords(jd) {
    var hay = normSpace(jd);
    var found = {};
    var add = function (k) { if (k && k.length > 1) found[k] = true; };

    TECH_SKILLS.concat(SOFT_SKILLS).forEach(function (k) {
      if (has(hay, k)) add(k);
    });

    // Acronyms / capitalized tokens (e.g. AWS, SQL, KPI, B2B)
    var caps = jd.match(/\b[A-Z]{2,5}\b/g) || [];
    caps.forEach(function (c) { add(c.toLowerCase()); });

    // Quoted phrases ("must have 'stakeholder management'")
    var quoted = jd.match(/["“']([A-Za-z][A-Za-z /+.-]{2,40})["”']/g) || [];
    quoted.forEach(function (q) { add(q.replace(/["“”']/g, '').trim().toLowerCase()); });

    return Object.keys(found);
  }

  // ---------------------------------------------------------------- analysis
  function analyze(resumeText, jdText) {
    var text = String(resumeText || '');
    var low = norm(text);
    var words = (text.trim().match(/\S+/g) || []).length;
    var lines = text.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
    var bullets = lines.filter(function (l) { return /^[-•*‣>]/.test(l); });
    if (!bullets.length) bullets = lines; // fallback: treat lines as bullets

    var cats = [];
    var suggestions = [];

    // --- Contact info (15)
    var hasEmail = EMAIL_RE.test(text);
    var hasPhone = PHONE_RE.test(text);
    var hasLink = LINK_RE.test(text); // linkedin / portfolio
    var contact = (hasEmail ? 8 : 0) + (hasPhone ? 5 : 0) + (hasLink ? 2 : 0);
    cats.push({ name: 'Contact Information', got: contact, max: 15 });
    if (!hasEmail) suggestions.push('Add a professional email address — parsers use it to identify you.');
    if (!hasPhone) suggestions.push('Add a phone number with country code.');
    if (!hasLink) suggestions.push('Add a LinkedIn or portfolio URL if you have one.');

    // --- Sections (20)
    var secGot = 0;
    SECTION_CHECKS.forEach(function (s) {
      var ok = s.re.test(low);
      if (ok) secGot += 5; else suggestions.push('Add a clear "' + s.label + '" section heading (standard headings parse best).');
    });
    cats.push({ name: 'Standard Sections', got: secGot, max: 20 });

    // --- Length (10)
    var lenGot = words >= 300 && words <= 800 ? 10 : (words >= 200 && words <= 950 ? 6 : 2);
    cats.push({ name: 'Length', got: lenGot, max: 10 });
    if (words < 300) suggestions.push('Resume is short (' + words + ' words). Aim for 400-700 words of specific evidence.');
    if (words > 800) suggestions.push('Resume is long (' + words + ' words). Trim to ~1-2 pages; cut the weakest bullets.');

    // --- Quantified impact (15)
    var withNum = bullets.filter(function (b) { return /\d/.test(b); }).length;
    var ratio = bullets.length ? withNum / bullets.length : 0;
    var quant = Math.round(15 * Math.min(1, ratio / 0.5)); // full marks at 50% numeric bullets
    cats.push({ name: 'Quantified Achievements', got: quant, max: 15 });
    if (ratio < 0.3) suggestions.push('Add numbers to your bullets (% improved, $ saved, time cut). Numbers make claims credible.');

    // --- Action verbs (10)
    var verbHits = ACTION_VERBS.filter(function (v) { return new RegExp('\\b' + v + '\\b', 'i').test(text); }).length;
    var verb = Math.min(10, verbHits * 2);
    cats.push({ name: 'Strong Action Verbs', got: verb, max: 10 });
    if (verbHits < 3) suggestions.push('Start bullets with strong verbs (led, built, increased, reduced) instead of "responsible for".');

    // --- Format / red flags (10)
    var flags = 0;
    var flagNotes = [];
    if (EMOJI_RE.test(text)) { flags++; flagNotes.push('emojis'); }
    if (/references\s+available/i.test(text)) { flags++; flagNotes.push('"references available" line'); }
    if (/\b(photo|picture|headshot|image of me)\b/i.test(text)) { flags++; flagNotes.push('photo/image mention'); }
    if (/\b(i|me|my)\b/i.test(text)) { flags++; flagNotes.push('first-person pronouns'); }
    if (/\t/.test(text)) { flags++; flagNotes.push('tab characters / columns'); }
    var format = Math.max(0, 10 - flags * 2);
    cats.push({ name: 'Parse-Safe Format', got: format, max: 10 });
    if (flagNotes.length) suggestions.push('Remove: ' + flagNotes.join(', ') + ' — these can confuse ATS parsers.');

    // --- Keyword match (20, only when a JD is provided)
    var missing = [], matched = [];
    var jd = String(jdText || '').trim();
    if (jd) {
      var hay = normSpace(text);
      var kws = extractJdKeywords(jd);
      kws.forEach(function (k) {
        if (has(hay, k)) matched.push(k); else missing.push(k);
      });
      var kr = kws.length ? matched.length / kws.length : 1;
      cats.push({ name: 'Job-Description Keyword Match', got: Math.round(20 * kr), max: 20 });
      if (missing.length) {
        suggestions.push('Missing keywords from the job ad (add only if genuinely true): ' + missing.slice(0, 12).join(', ') + '.');
      }
    }

    // --- score: sum categories, rescale to 100 if no JD
    var gotTotal = cats.reduce(function (a, c) { return a + c.got; }, 0);
    var maxTotal = cats.reduce(function (a, c) { return a + c.max; }, 0);
    var score = Math.round(100 * gotTotal / maxTotal);

    var grade =
      score >= 80 ? 'Excellent — likely to pass most ATS screens.' :
      score >= 65 ? 'Good — a few fixes will make it ATS-strong.' :
      score >= 50 ? 'Average — address the suggestions below.' :
      'At risk — restructure using the suggestions below.';

    return {
      score: score,
      grade: grade,
      wordCount: words,
      categories: cats,
      matchedKeywords: matched,
      missingKeywords: missing,
      suggestions: suggestions
    };
  }

  var api = { analyze: analyze, extractJdKeywords: extractJdKeywords };
  if (typeof window !== 'undefined') window.ATS = api;
  if (typeof globalThis !== 'undefined') globalThis.ATS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
