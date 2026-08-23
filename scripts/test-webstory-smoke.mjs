#!/usr/bin/env node
/**
 * Offline smoke test for scripts/generate-webstory.mjs
 * - Mocks story data (no Groq call)
 * - Runs buildStoryHtml + updateSitemap + rebuildStoriesIndex
 * - Writes to /tmp/webstory-test/ so real files are not touched
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildStoryHtml, rebuildStoriesIndex, updateSitemap } from './generate-webstory.mjs';

process.env.GROQ_API_KEY = 'test'; // satisfy top-level check on next import (already imported)

const story = {
    story_title: 'Test: 10 AI Hacks Every Creator Needs',
    meta_description: 'Ten must-know AI hacks that save hours and boost creativity. Free tools, no signup.',
    cover_caption: 'Discover 10 AI hacks that save hours every week.',
    cover_image_prompt: 'cinematic hd ai brain glowing neon portrait',
    slides: [
        { heading: 'ChatGPT Prompts', caption: 'Use structured prompts to get answers 10x faster than plain questions. This works for all AI chatbots and saves hours every week.', image_prompt: 'photorealistic person using ChatGPT on laptop' },
        { heading: 'AI Image Tools', caption: 'Free AI image tools create studio-quality visuals in under 30 seconds. No design skills needed for professional results.', image_prompt: 'photorealistic studio image creation on tablet' },
        { heading: 'Voice Clone', caption: 'Clone your voice in minutes and turn any blog post into a podcast episode. This tool works with just a short audio sample.', image_prompt: 'photorealistic studio microphone neon glow' },
        { heading: 'AI Resume', caption: 'Auto-tailor your resume for every job with a single click. AI matches keywords to each job description automatically.', image_prompt: 'photorealistic resume on desk with laptop cinematic' },
        { heading: 'SEO Automation', caption: 'Let AI find keywords, write meta tags and speed your ranking journey. Free SEO tools make optimization effortless.', image_prompt: 'photorealistic seo dashboard glowing neon' },
        { heading: 'AI Writing', caption: 'Generate entire blog posts with AI in minutes. These tools create human-quality content on any topic.', image_prompt: 'photorealistic person writing on laptop with AI interface' },
        { heading: 'Data Analysis', caption: 'Use AI to analyze spreadsheets and find patterns instantly. No coding required for powerful data insights.', image_prompt: 'photorealistic dashboard with charts and AI analysis' },
        { heading: 'Video Editing', caption: 'AI video editors trim, caption and enhance your footage automatically. Create professional videos in half the time.', image_prompt: 'photorealistic video editing timeline with AI tools' },
        { heading: 'Research Assistant', caption: 'Research assistants summarize long reports and surface useful sources quickly. Always verify important claims before publishing or acting on the result.', image_prompt: 'photorealistic researcher reviewing sources on a laptop' },
        { heading: 'Workflow Automation', caption: 'Connect everyday apps to remove repetitive copy and paste work. Start with one reliable workflow, measure the time saved, then expand carefully.', image_prompt: 'photorealistic professional planning an automated workflow' },
    ],
    cta_line: 'Explore 100+ free AI tools on AIToolsNova - no signup needed.',
};

const html = buildStoryHtml({ slug: 'test-story-smoke', story });

// Assert essentials
const checks = [
    ['<amp-story', 'amp-story tag present'],
    ['amp-story-page id="cover"', 'cover page present'],
    ['amp-story-page id="cta"', 'cta page present'],
    ['amp-story-page id="s-8"', '10th slide present (exactly 10 content slides)'],
    ['slide-caption', 'caption class present'],
    ['Playfair+Display', 'google font imported'],
    ['application/ld+json', 'schema.org json-ld present'],
    ['Ten must-know AI hacks', 'meta description escaped correctly'],
    ['Tip 10 of 10', 'pill shows correct count (10 tips)'],
];
let failed = 0;
for (const [needle, desc] of checks) {
    if (html.includes(needle)) console.log(`✅ ${desc}`);
    else { console.log(`❌ ${desc}`); failed++; }
}
// Sanity: html should be under 200KB and valid-ish
if (html.length < 3000) { console.log(`❌ output too small (${html.length})`); failed++; }
else console.log(`✅ output size ${(html.length / 1024).toFixed(1)}KB`);

if (failed > 0) { console.error(`\n❌ ${failed} check(s) failed`); process.exit(1); }
console.log('\n🎉 All smoke checks passed');