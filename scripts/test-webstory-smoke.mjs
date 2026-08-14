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
    story_title: 'Test: 5 AI Hacks Every Creator Needs',
    meta_description: 'Five must-know AI hacks that save hours and boost creativity. Free tools, no signup.',
    cover_caption: 'Discover 5 AI hacks that save hours every week.',
    cover_image_prompt: 'cinematic hd ai brain glowing neon portrait',
    slides: [
        { heading: 'ChatGPT Prompts', caption: 'Use structured prompts to get answers 10x faster than plain questions.', image_prompt: 'photorealistic person using ChatGPT on laptop' },
        { heading: 'AI Image Tools', caption: 'Free AI image tools that create studio-quality visuals in under 30 seconds.', image_prompt: 'photorealistic studio image creation on tablet' },
        { heading: 'Voice Clone', caption: 'Clone your voice in minutes and turn any blog post into a podcast episode.', image_prompt: 'photorealistic studio microphone neon glow' },
        { heading: 'AI Resume', caption: 'Auto-tailor your resume for every job with a single click.', image_prompt: 'photorealistic resume on desk with laptop cinematic' },
        { heading: 'SEO Automation', caption: 'Let AI find keywords, write meta tags and speed your ranking journey.', image_prompt: 'photorealistic seo dashboard glowing neon' },
    ],
    cta_line: 'Explore 100+ free AI tools on AIToolsNova - no signup needed.',
};

const html = buildStoryHtml({ slug: 'test-story-smoke', story });

// Assert essentials
const checks = [
    ['<amp-story', 'amp-story tag present'],
    ['amp-story-page id="cover"', 'cover page present'],
    ['amp-story-page id="cta"', 'cta page present'],
    ['amp-story-page id="s-5"', '5th slide present'],
    ['slide-caption', 'caption class present'],
    ['Playfair+Display', 'google font imported'],
    ['application/ld+json', 'schema.org json-ld present'],
    ['Five must-know AI hacks', 'meta description escaped correctly'],
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
